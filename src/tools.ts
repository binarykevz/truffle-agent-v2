import { Context } from "grammy";
import * as cheerio from "cheerio";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfig } from "./db";
import { isTermux, launchOnTermux, listInstalledApps, getKnownApps, APP_REGISTRY } from "./device";
import { getConversionOptions } from "./converter";

export interface Tool {
    name: string; description: string; parameters: Record<string, any>;
    execute: (args: any, ctx: Context) => Promise<any>;
}

function escapeMd(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, '\\$&');
}

const WORKSPACE = "/tmp/bot_workspace";

export const tools: Tool[] = [
    {
        name: "web_crawl", description: "Crawl a URL and extract its main text content.",
        parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        execute: async ({ url }) => {
            const res = await fetch(url, { headers: { "User-Agent": "AgenticBot/1.0" } });
            const html = await res.text();
            const $ = cheerio.load(html);
            $("script, style, nav, footer").remove();
            return $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
        }
    },
    {
        name: "generate_and_deploy_program", description: "Generate a TypeScript program based on a prompt and execute/deploy it.",
        parameters: { type: "object", properties: { prompt: { type: "string" }, type: { type: "string", enum: ["script", "web_server"], default: "script" } }, required: ["prompt"] },
        execute: async ({ prompt, type = "script" }) => {
            await mkdir(WORKSPACE, { recursive: true });
            const fileName = `program_${Date.now()}.ts`;
            const filePath = join(WORKSPACE, fileName);
            const apiKey = await getConfig("api_key");
            const baseUrl = await getConfig("base_url");
            const model = (await getConfig("model")) || "qwen-max";
            const codeRes = await fetch(`${baseUrl!.replace(/\/$/, "")}/chat/completions`, {
                method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model, messages: [{ role: "system", content: "Write clean, runnable TypeScript code. Return ONLY the code, no markdown." }, { role: "user", content: prompt }], temperature: 0.1 }),
            });
            const code = ((await codeRes.json()) as any).choices[0].message.content.trim();
            await writeFile(filePath, code);
            if (type === "web_server") {
                const proc = Bun.spawn(["bun", "run", filePath], { stdout: "ignore", stderr: "ignore", detached: true });
                proc.unref();
                return `Deployed web server. File: ${fileName}. Running in background.`;
            } else {
                const proc = Bun.spawn(["bun", "run", filePath], { timeout: 15000 });
                return `Executed ${fileName}. Output:\n${await new Response(proc.stdout).text()}`;
            }
        }
    },
    {
        name: "openclaw_action", description: "Send a message to the OpenClaw agent.",
        parameters: { type: "object", properties: { message: { type: "string" }, session: { type: "string", default: "agent:main:main" } }, required: ["message"] },
        execute: async ({ message, session = "agent:main:main" }, ctx) => {
            const openclawUrl = (await getConfig("openclaw_url")) || "http://127.0.0.1:18789/hooks/agent";
            const openclawToken = await getConfig("openclaw_token");
            if (!openclawToken) return "❌ OpenClaw token not configured.";
            try {
                const response = await fetch(openclawUrl, {
                    method: "POST", headers: { Authorization: `Bearer ${openclawToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ message, session, name: "telegram", user: String(ctx.from?.id || "unknown") }),
                });
                if (!response.ok) return `❌ OpenClaw request failed: ${response.status} ${response.statusText}`;
                const data = await response.json();
                return typeof data === "string" ? data : JSON.stringify(data, null, 2).slice(0, 4000);
            } catch (err: any) { return `❌ OpenClaw request failed: ${err.message}`; }
        }
    },
{
        name: "request_file_upload",
        description: "Use this when the user wants to convert a file but hasn't uploaded one yet. This sends a friendly request asking them to upload the file. The bot will automatically detect the format and show conversion options.",
        parameters: {
            type: "object",
            properties: {
                expected_format: { 
                    type: "string", 
                    description: "Optional: the file format the user mentioned (e.g., 'PDF', 'image', 'video'). Leave empty if unknown."
                }
            },
            required: []
        },
        execute: async ({ expected_format = "" }, ctx) => {
            const formatHint = expected_format 
                ? ` (you mentioned **${escapeMd(expected_format)}**)` 
                : "";
            
            await ctx.reply(
                `📎 Please upload the file you want to convert${formatHint}.\n\n` +
                `Once uploaded, I'll automatically detect its format and show you the available conversion options.`,
                { parse_mode: "Markdown" }
            );
            return `File upload requested${formatHint}. Waiting for user to upload.`;
        }
    },
    {
        name: "open_app", description: `Open an app on the user's device. Known: ${getKnownApps().join(", ")}`,
        parameters: { type: "object", properties: { app: { type: "string" }, extra: { type: "string" } }, required: ["app"] },
        execute: async ({ app, extra = "" }, ctx) => {
            if (isTermux()) return await launchOnTermux(app, extra);
            const key = app.toLowerCase();
            const known = APP_REGISTRY[key];
            const url = known ? known.web + extra : extra;
            if (!url) return `❌ Cannot open "${app}" remotely.`;
            await ctx.reply(`🚀 Tap to open ${app}:`, { reply_markup: { inline_keyboard: [[{ text: `Open ${app}`, url }]] } });
            return `Sent button to open ${app}.`;
        }
    },
    {
        name: "list_installed_apps", description: "List third-party apps (Termux only).",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            if (!isTermux()) return "❌ Only works on Termux/Android.";
            const apps = await listInstalledApps();
            return apps.length === 0 ? "No third-party apps found." : `Installed apps (${apps.length} total):\n${apps.slice(0, 100).join("\n")}`;
        }
    },
    {
        name: "get_conversion_options", description: "Get supported target formats for a file extension.",
        parameters: { type: "object", properties: { file_extension: { type: "string" } }, required: ["file_extension"] },
        execute: async ({ file_extension }) => getConversionOptions(file_extension)
    },
    {
        name: "show_conversion_menu", description: "Display an interactive inline keyboard with conversion options.",
        parameters: { type: "object", properties: { job_id: { type: "string" }, current_format: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["job_id", "current_format", "options"] },
        execute: async ({ job_id, current_format, options }, ctx) => {
            const keyboard = options.map((opt: string) => ({ text: `📄 ${current_format.toUpperCase()} → ${opt.toUpperCase()}`, callback_data: `conv_${job_id}_${opt}` }));
            const rows = [];
            for (let i = 0; i < keyboard.length; i += 8) rows.push(keyboard.slice(i, i + 8));
            await ctx.reply("✨ Choose your desired output format:", { reply_markup: { inline_keyboard: rows } });
            return `Conversion menu displayed for job ${job_id}.`;
        }
    }
];
