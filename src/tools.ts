import { Context, InputFile } from "grammy";
import * as cheerio from "cheerio";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { getConfig } from "./db";
import { searchAndPlay } from "./music";
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
           
        name: "play_music",
        description: "Search and play music. Returns audio file and stylish player interface.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Song name, artist, or lyrics to search" },
            },
            required: ["query"],
        },
               execute: async ({ query }, ctx) => {
            await ctx.replyWithChatAction("upload_voice");
            
            const result = await searchAndPlay(query, ctx.from!.id);
            
            if (!result) {
                return "❌ No songs found. Try a different search.";
            }

            // 1. Send photo with caption and keyboard
            try {
                await ctx.replyWithPhoto(result.photo, {
                    caption: result.caption,
                    reply_markup: result.keyboard,
                    parse_mode: "Markdown",
                });
            } catch (err: any) {
                console.warn(`[Music] Photo send failed, falling back to text: ${err.message}`);
                await ctx.reply(result.caption, {
                    reply_markup: result.keyboard,
                    parse_mode: "Markdown",
                });
            }

            // 2. Send the audio file
            if (result.audioPath) {
                try {
                    const bunFile = Bun.file(result.audioPath);
                    const fileSize = bunFile.size;
                    console.log(`[Music] 📤 Preparing upload: ${result.audioPath} (${fileSize} bytes)`);
                    
                    if (fileSize < 10000) {
                        throw new Error("File is too small, likely an error response");
                    }

                    // Read the entire file into memory (avoids Bun stream lock issues with Grammy)
                    const buffer = await bunFile.arrayBuffer();
                    
                    // 🕵️ Detective check: Is it actually audio, or an HTML/JSON error page?
                    const header = new TextDecoder().decode(buffer.slice(0, 100));
                    if (header.trim().startsWith("<") || header.trim().startsWith("{") || header.trim().startsWith("[")) {
                        console.error(`[Music] ❌ Downloaded file is NOT audio! First 100 chars:\n${header}`);
                        await ctx.reply("⚠️ The download API returned a text/JSON error instead of an audio file.");
                        return `Played: ${query} (but audio file was invalid)`;
                    }

                    // Create InputFile with explicit filename and binary Uint8Array
                    const safeName = `${query.replace(/[^\w\s.-]/gi, '').slice(0, 50)}.mp3`;
                    const inputFile = new InputFile(new Uint8Array(buffer), safeName);
                    
                    // Try sending as Audio first
                    try {
                        await ctx.replyWithAudio(inputFile, {
                            title: query.slice(0, 255),
                            performer: "Truffle Music",
                        });
                        console.log(`[Music] ✅ Audio successfully sent to Telegram`);
                    } catch (audioErr: any) {
                        // Log the exact Telegram error
                        console.warn(`[Music] ⚠️ replyWithAudio failed: ${audioErr.description || audioErr.message}`);
                        
                        // Fallback to Document (bypasses Telegram's strict audio header checks)
                        try {
                            await ctx.replyWithDocument(inputFile);
                            console.log(`[Music] ✅ Document fallback sent successfully`);
                        } catch (docErr: any) {
                            console.error(`[Music] ❌ Document fallback also failed: ${docErr.message}`);
                            await ctx.reply(`⚠️ Downloaded the song, but Telegram rejected both audio and document formats.`);
                        }
                    }
                } catch (err: any) {
                    console.error(`[Music] ❌ Upload pipeline failed: ${err.message}`);
                    await ctx.reply(`⚠️ Downloaded the song, but upload failed: ${err.message.slice(0, 150)}`);
                } finally {
                    // Clean up temp file
                    try { await Bun.file(result.audioPath).delete(); } catch {}
                }
            }

            return `🎵 Played: ${query}`;
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
