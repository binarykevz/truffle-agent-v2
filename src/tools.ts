import { Context } from "grammy";
import * as cheerio from "cheerio";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfig } from "./db";
import { isTermux, launchOnTermux, listInstalledApps, getKnownApps, APP_REGISTRY } from "./device";
import { getConversionOptions } from "./converter";

function escapeMd(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, '\\$&');
}

export interface Tool {
    name: string; description: string; parameters: Record<string, any>;
    execute: (args: any, ctx: Context) => Promise<any>;
}

const WORKSPACE = "/tmp/bot_workspace";

export const tools: Tool[] = [
    {
        name: "web_crawl", description: "Crawl a URL.",
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
        name: "generate_and_deploy_program", description: "Generate and run TypeScript code.",
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
                body: JSON.stringify({ model, messages: [{ role: "system", content: "Write runnable TypeScript. Return ONLY code." }, { role: "user", content: prompt }], temperature: 0.1 }),
            });
            const code = ((await codeRes.json()) as any).choices[0].message.content.trim();
            await writeFile(filePath, code);
            if (type === "web_server") {
                const proc = Bun.spawn(["bun", "run", filePath], { stdout: "ignore", stderr: "ignore", detached: true });
                proc.unref();
                return `Deployed ${fileName}.`;
            }
            const proc = Bun.spawn(["bun", "run", filePath], { timeout: 15000 });
            return `Output:\n${await new Response(proc.stdout).text()}`;
        }
    },
    {
        name: "openclaw_action", description: "Send message to OpenClaw.",
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
                if (!response.ok) return `❌ HTTP ${response.status}`;
                const data = await response.json();
                return typeof data === "string" ? data : JSON.stringify(data, null, 2).slice(0, 4000);
            } catch (err: any) { return `❌ ${err.message}`; }
        }
    },
    {
        name: "open_app", description: `Open app. Known: ${getKnownApps().join(", ")}`,
        parameters: { type: "object", properties: { app: { type: "string" }, extra: { type: "string" } }, required: ["app"] },
        execute: async ({ app, extra = "" }, ctx) => {
            if (isTermux()) return await launchOnTermux(app, extra);
            const key = app.toLowerCase();
            const known = APP_REGISTRY[key];
            const url = known ? known.web + extra : extra;
            if (!url) return `❌ Cannot open "${app}" remotely.`;
            await ctx.reply(`🚀 Tap to open ${app}:`, { reply_markup: { inline_keyboard: [[{ text: `Open ${app}`, url }]] } });
            return `Sent button.`;
        }
    },
    {
        name: "list_installed_apps", description: "List apps (Termux only).",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            if (!isTermux()) return "❌ Only on Termux.";
            const apps = await listInstalledApps();
            return apps.length === 0 ? "No apps." : `Apps (${apps.length}):\n${apps.slice(0, 100).join("\n")}`;
        }
    },
    {
        name: "request_file_upload",
        description: "Use when user wants to convert a file but hasn't uploaded one yet.",
        parameters: {
            type: "object",
            properties: { expected_format: { type: "string", description: "Optional: file format mentioned" } },
            required: []
        },
        execute: async ({ expected_format = "" }, ctx) => {
            const hint = expected_format ? ` (you mentioned **${escapeMd(expected_format)}**)` : "";
            await ctx.reply(
                `📎 Please upload the file you want to convert${hint}.\n\nOnce uploaded, I'll detect its format and show conversion options.`,
                { parse_mode: "Markdown" }
            );
            return `File upload requested${hint}.`;
        }
    },
    {
        name: "get_conversion_options", description: "Get target formats for extension.",
        parameters: { type: "object", properties: { file_extension: { type: "string" } }, required: ["file_extension"] },
        execute: async ({ file_extension }) => getConversionOptions(file_extension)
    },
    {
        name: "show_conversion_menu", description: "Show conversion options UI.",
        parameters: { type: "object", properties: { job_id: { type: "string" }, current_format: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["job_id", "current_format", "options"] },
        execute: async ({ job_id, current_format, options }, ctx) => {
            const keyboard = options.map(opt => ({ text: `📄 ${current_format.toUpperCase()} → ${opt.toUpperCase()}`, callback_data: `conv_${job_id}_${opt}` }));
            const rows = [];
            for (let i = 0; i < keyboard.length; i += 8) rows.push(keyboard.slice(i, i + 8));
            await ctx.reply("✨ Choose output format:", { reply_markup: { inline_keyboard: rows } });
            return `Menu displayed.`;
        }
    }
];
