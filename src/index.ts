import { Bot } from "grammy";
import { runAgent, resetAgent } from "./agent";
import {
    initMainDB, initCommandsDB, initMemoryDB,
    seedOwner, getOwner, isOwner, isAllowedUser,
    addAllowedUser, removeAllowedUser, listAllowedUsers,
    getConfig, setConfig,
    getCommand, saveCommand, deleteCommand, toggleCommand, listCommands,
    updateCommandDescription,
} from "./db";
import { executeCommandCode } from "./commandRunner";
import { seedDefaultCommands } from "./seedCommands";
import { validateAndFixCode, quickSyntaxCheck } from "./codeValidator";
import { getConversionOptions, convertFile } from "./converter";
import { userFileCache, type CachedFile, getCacheStats, clearAllCaches } from "./cache";

// ============================================================
// HELPERS
// ============================================================

function escapeMarkdown(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, '\\$&');
}

async function safeReply(ctx: any, text: string, options: any = {}): Promise<any> {
    try {
        return await ctx.reply(text, { parse_mode: "Markdown", ...options });
    } catch (e: any) {
        if (e.message?.includes("can't parse")) {
            return await ctx.reply(text, options);
        }
        throw e;
    }
}

async function safeEditMessageText(bot: Bot, chatId: number, messageId: number, text: string, options: any = {}): Promise<any> {
    try {
        return await bot.api.editMessageText(chatId, messageId, text, { parse_mode: "Markdown", ...options });
    } catch (e: any) {
        if (e.message?.includes("can't parse")) {
            return await bot.api.editMessageText(chatId, messageId, text, options);
        }
        throw e;
    }
}

// ============================================================
// STATE
// ============================================================

const pendingFeatures = new Map<number, {
    step: "code" | "description";
    name: string;
    ownerOnly: boolean;
    code?: string;
    isEdit?: boolean;
}>();

const conversionJobs = new Map<string, { filePath: string; fileName: string; ext: string; userId: number }>();

const MAX_CACHE_PER_USER = 10;

function cacheUserFile(userId: number, file: CachedFile) {
    let cache = userFileCache.get(userId) || [];
    cache.unshift(file);
    if (cache.length > MAX_CACHE_PER_USER) {
        cache = cache.slice(0, MAX_CACHE_PER_USER);
    }
    userFileCache.set(userId, cache);
}

function findCachedFile(userId: number, messageId: number): CachedFile | null {
    const cache = userFileCache.get(userId) || [];
    return cache.find(f => f.messageId === messageId) || null;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
    await Promise.all([initMainDB(), initCommandsDB(), initMemoryDB()]);
    console.log("✅ All databases initialized");

    const ownerId = await seedOwner();
    if (ownerId) console.log(`👑 Owner locked to Telegram ID: ${ownerId}`);

    if (ownerId) {
        console.log("📦 Seeding default commands...");
        await seedDefaultCommands(ownerId);
    }

    let botToken = await getConfig("bot_token");
    if (!botToken && process.env.BOT_TOKEN) {
        await setConfig("bot_token", process.env.BOT_TOKEN);
        botToken = process.env.BOT_TOKEN;
        console.log("🔑 Bot token auto-seeded");
    }
    if (!botToken) { console.error("❌ bot_token not set."); process.exit(1); }

    if (!(await getConfig("openclaw_url"))) await setConfig("openclaw_url", "http://127.0.0.1:18789/hooks/agent");
    if (!(await getConfig("openclaw_token"))) await setConfig("openclaw_token", "f1d98b9579ab55a32afefac44feafe681457c903178409f9");

    const bot = new Bot(botToken);

    // ============================================================
    // AUTH MIDDLEWARE
    // ============================================================
    bot.use(async (ctx, next) => {
        if (!ctx.from) return;
        if (ctx.callbackQuery) return await next();
        const allowed = await isAllowedUser(ctx.from.id);
        if (!allowed) {
            if (ctx.message) {
                const owner = await getOwner();
                await safeReply(ctx,
                    `⛔ Unauthorized\\. Your ID: \`${ctx.from.id}\`\n` +
                    `Ask the owner${owner ? ` \\(ID: \`${owner}\`\\)` : ""} to run:\n` +
                    `\`/adduser ${ctx.from.id}\``
                );
            }
            return;
        }
        await next();
    });

    // ============================================================
    // META-COMMANDS
    // ============================================================

    bot.command("addfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const parts = (ctx.match ?? "").trim().split(/\s+/);
        const name = parts[0]?.replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/addfeature <name> [owner_only]`", { parse_mode: "Markdown" });
        const ownerOnly = parts[1] === "1" || parts[1] === "true";
        pendingFeatures.set(ctx.from.id, { step: "code", name, ownerOnly });
        await safeReply(ctx,
            `🛠️ Adding \`/${escapeMarkdown(name)}\` (${ownerOnly ? "owner only" : "all users"})\n\n` +
            `Send the **code** next\\. Available: ctx, db, auth, utils\\.\n` +
            `✨ AI will auto\\-fix errors\\. Type /cancel to abort\\.`
        );
    });

    bot.command("editfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/editfeature <name>`", { parse_mode: "Markdown" });
        const cmd = await getCommand(name);
        if (!cmd) return ctx.reply(`❌ /${escapeMarkdown(name)} not found.`);
        pendingFeatures.set(ctx.from.id, { step: "code", name, ownerOnly: cmd.owner_only === 1, isEdit: true });
        const preview = cmd.code.slice(0, 1000) + (cmd.code.length > 1000 ? "\n..." : "");
        await safeReply(ctx,
            `🛠️ Editing \`/${escapeMarkdown(name)}\`\\. Current:\n\`\`\`\n${escapeMarkdown(preview)}\n\`\`\`\n\n` +
            `Send new code\\. /cancel to abort\\.`
        );
    });

    bot.command("descfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const parts = (ctx.match ?? "").split(/\s+/);
        const name = parts[0]?.replace(/^\//, "");
        const desc = parts.slice(1).join(" ");
        if (!name || !desc) return ctx.reply("Usage: `/descfeature <name> <description>`", { parse_mode: "Markdown" });
        const updated = await updateCommandDescription(name, desc);
        await ctx.reply(updated ? `✅ Updated /${escapeMarkdown(name)}` : `❌ Not found.`);
    });

    bot.command("deletefeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/deletefeature <name>`", { parse_mode: "Markdown" });
        const deleted = await deleteCommand(name);
        await ctx.reply(deleted ? `✅ Deleted /${escapeMarkdown(name)}` : `❌ Not found.`);
    });

    bot.command("togglefeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/togglefeature <name>`", { parse_mode: "Markdown" });
        const result = await toggleCommand(name);
        if (!result.found) return ctx.reply(`❌ Not found.`);
        await ctx.reply(`${result.enabled ? "✅ Enabled" : "⏸️ Disabled"} /${escapeMarkdown(name)}`);
    });

    bot.command("listfeatures", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const cmds = await listCommands();
        if (cmds.length === 0) return ctx.reply("No features.");
        const lines = cmds.map(c => {
            const status = c.enabled ? "✅" : "⏸️";
            const lock = c.owner_only ? "🔒" : "🌐";
            return `${status}${lock} \`/${escapeMarkdown(c.name)}\` — ${escapeMarkdown(c.description || "(no desc)")}`;
        });
        await safeReply(ctx, `**Features (${cmds.length}):**\n` + lines.join("\n"));
    });

    bot.command("viewfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/viewfeature <name>`", { parse_mode: "Markdown" });
        const cmd = await getCommand(name);
        if (!cmd) return ctx.reply(`❌ Not found.`);
        const code = cmd.code.length > 3500 ? cmd.code.slice(0, 3500) + "\n..." : cmd.code;
        await safeReply(ctx, `**/${escapeMarkdown(cmd.name)}**\n\`\`\`\n${escapeMarkdown(code)}\n\`\`\``);
    });

    bot.command("cancel", async (ctx) => {
        if (pendingFeatures.has(ctx.from.id)) {
            pendingFeatures.delete(ctx.from.id);
            await ctx.reply("❌ Cancelled.");
        } else {
            await ctx.reply("Nothing to cancel.");
        }
    });

    bot.command("cachestats", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const stats = getCacheStats();
        await ctx.reply(
            `**📊 Cache Statistics**\n\n` +
            `**LLM:** ${stats.llm.size} / ${stats.llm.maxSize}\n` +
            `**Commands:** ${stats.commands.size} / ${stats.commands.maxSize}\n` +
            `**Config:** ${stats.config.size} / ${stats.config.maxSize}\n` +
            `**Conversions:** ${stats.conversion.size} / ${stats.conversion.maxSize}\n` +
            `**User Files:** ${stats.userFiles.size} / ${stats.userFiles.maxSize}`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("clearcache", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        clearAllCaches();
        await ctx.reply("🧹 All caches cleared.");
    });

    // ============================================================
    // FILE HANDLERS
    // ============================================================
    bot.on("message:document", async (ctx) => {
        const doc = ctx.message.document;
        const ext = doc.file_name?.split('.').pop()?.toLowerCase() || "bin";
        const jobId = crypto.randomUUID().slice(0, 8);
        const fileName = doc.file_name || `file_${jobId}.${ext}`;
        const filePath = `/tmp/conv_${jobId}.${ext}`;

        await ctx.replyWithChatAction("upload_document");
        const fileLink = await ctx.api.getFileLink(doc.file_id);
        await Bun.write(filePath, await new Response(await fetch(fileLink)).arrayBuffer());

        const jobInfo = { jobId, filePath, fileName, ext, userId: ctx.from.id };
        conversionJobs.set(jobId, jobInfo);

        cacheUserFile(ctx.from.id, {
            messageId: ctx.message.message_id,
            filePath, fileName, ext,
            userId: ctx.from.id,
            timestamp: Date.now(),
        });

        const caption = ctx.message.caption || "";
        const isConversionIntent = /convert|change|transform|make.*into|to (pdf|docx|png|jpg|mp3|mp4|gif|webp|zip|7z)/i.test(caption);

        let userMessage: string;
        if (isConversionIntent) {
            userMessage = `[SYSTEM: User attached a file with conversion intent. Job ID: ${jobId}, Name: ${fileName}, Format: ${ext}. User said: "${caption}"]`;
        } else if (caption) {
            userMessage = `[SYSTEM: User attached a file. Job ID: ${jobId}, Name: ${fileName}, Format: ${ext}. Caption: "${caption}"]`;
        } else {
            userMessage = `[SYSTEM: User attached a file. Job ID: ${jobId}, Name: ${fileName}, Format: ${ext}]`;
        }

        try {
            const response = await runAgent(ctx, userMessage, jobInfo);
            const chunks = response.match(/.{1,4000}/gs) || [""];
            for (const chunk of chunks) await ctx.reply(chunk);
        } catch (error: any) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    });

    bot.on("message:photo", async (ctx) => {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const ext = "jpg";
        const jobId = crypto.randomUUID().slice(0, 8);
        const fileName = `image_${jobId}.jpg`;
        const filePath = `/tmp/conv_${jobId}.${ext}`;

        await ctx.replyWithChatAction("upload_photo");
        const fileLink = await ctx.api.getFileLink(photo.file_id);
        await Bun.write(filePath, await new Response(await fetch(fileLink)).arrayBuffer());

        const jobInfo = { jobId, filePath, fileName, ext, userId: ctx.from.id };
        conversionJobs.set(jobId, jobInfo);

        cacheUserFile(ctx.from.id, {
            messageId: ctx.message.message_id,
            filePath, fileName, ext,
            userId: ctx.from.id,
            timestamp: Date.now(),
        });

        const caption = ctx.message.caption || "";
        const isConversionIntent = /convert|change|transform|make.*into|to (png|jpg|webp|pdf|gif)/i.test(caption.toLowerCase());

        let userMessage: string;
        if (isConversionIntent) {
            userMessage = `[SYSTEM: User attached an image with conversion intent. Job ID: ${jobId}, Format: ${ext}. User said: "${caption}"]`;
        } else if (caption) {
            userMessage = `[SYSTEM: User attached an image. Job ID: ${jobId}, Format: ${ext}. Caption: "${caption}"]`;
        } else {
            userMessage = `[SYSTEM: User attached an image. Job ID: ${jobId}, Format: ${ext}]`;
        }

        try {
            const response = await runAgent(ctx, userMessage, jobInfo);
            const chunks = response.match(/.{1,4000}/gs) || [""];
            for (const chunk of chunks) await ctx.reply(chunk);
        } catch (error: any) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    });

    // ============================================================
    // TEXT HANDLER
    // ============================================================
    bot.on("message:text", async (ctx) => {
        const text = ctx.message.text;
        const userId = ctx.from.id;
        const repliedTo = ctx.message.reply_to_message;

        // 1. Reply-to-file conversion
        if (repliedTo && (repliedTo.document || repliedTo.photo)) {
            const cachedFile = findCachedFile(userId, repliedTo.message_id);
            if (cachedFile && /convert|change|to |into |make|transform/i.test(text.toLowerCase())) {
                const jobId = crypto.randomUUID().slice(0, 8);
                const jobInfo = {
                    jobId,
                    filePath: cachedFile.filePath,
                    fileName: cachedFile.fileName,
                    ext: cachedFile.ext,
                    userId,
                };
                conversionJobs.set(jobId, jobInfo);

                const userMessage = `[SYSTEM: User replied to their uploaded file with conversion request. Job ID: ${jobId}, File: ${cachedFile.fileName}, Format: ${cachedFile.ext}. User said: "${text}"]`;

                try {
                    const response = await runAgent(ctx, userMessage, jobInfo);
                    const chunks = response.match(/.{1,4000}/gs) || [""];
                    for (const chunk of chunks) await ctx.reply(chunk);
                } catch (error: any) {
                    await ctx.reply(`❌ Error: ${error.message}`);
                }
                return;
            }
        }

        // 2. Pending feature input
        const pending = pendingFeatures.get(userId);
        if (pending) {
            if (pending.step === "code") {
                const progressMsg = await ctx.reply("🔍 Validating code...");
                const quickCheck = quickSyntaxCheck(text);
                let finalCode = text;
                let wasFixed = false;
                let fixDetails = "";

                if (!quickCheck.valid) {
                    await ctx.replyWithChatAction("typing");
                    const result = await validateAndFixCode(text, pending.name, async (msg) => {
                        try { await safeEditMessageText(bot, ctx.chat.id, progressMsg.message_id, escapeMarkdown(msg)); } catch {}
                    });

                    if (result.valid) {
                        finalCode = result.code;
                        wasFixed = true;
                        const escapedErrors = result.errors.slice(0, 3).map(e => `• ${escapeMarkdown(e.slice(0, 150))}`).join("\n");
                        fixDetails = `\n\n🔧 **AI fixed ${result.fixAttempts} error(s):**\n${escapedErrors}`;
                    } else {
                        const escapedErrors = result.errors.map(e => `• ${escapeMarkdown(e.slice(0, 200))}`).join("\n");
                        await safeEditMessageText(bot, ctx.chat.id, progressMsg.message_id,
                            `❌ Validation failed after ${result.fixAttempts} attempts.\n\n**Errors:**\n${escapedErrors}\n\nFix manually or /cancel.`
                        );
                        return;
                    }
                }

                pending.code = finalCode;
                pending.step = "description";
                pendingFeatures.set(userId, pending);

                const preview = finalCode.length > 500 ? finalCode.slice(0, 500) + "..." : finalCode;
                await safeEditMessageText(bot, ctx.chat.id, progressMsg.message_id,
                    `✅ Code ${wasFixed ? "**auto-fixed by AI**" : "**validated**"}!${fixDetails}\n\n` +
                    `**Preview:**\n\`\`\`\n${escapeMarkdown(preview)}\n\`\`\`\n\n` +
                    `Now send a short **description** \\(or type \`skip\`\\):`
                );
                return;
            }
            if (pending.step === "description") {
                const description = text.trim().toLowerCase() === "skip" ? "" : text.trim();
                try {
                    await saveCommand(pending.name, pending.code!, description, pending.ownerOnly, userId);
                    await ctx.reply(
                        `✅ \`/${escapeMarkdown(pending.name)}\` saved and live!${pending.isEdit ? " \\(edited\\)" : ""}`,
                        { parse_mode: "Markdown" }
                    );
                } catch (err: any) {
                    await ctx.reply(`❌ Failed: ${escapeMarkdown(err.message)}`);
                }
                pendingFeatures.delete(userId);
                return;
            }
        }

        // 3. Command handler
        if (text.startsWith("/")) {
            const cmdName = text.split(/\s+/)[0].replace(/^\//, "").split("@")[0];
            const cmd = await getCommand(cmdName);
            if (cmd) {
                if (cmd.owner_only && !(await isOwner(userId))) return ctx.reply("⛔ Owner only.");
                if (!cmd.enabled) return ctx.reply(`⏸️ /${escapeMarkdown(cmdName)} disabled.`);
                try {
                    await executeCommandCode(cmd.code, ctx);
                } catch (err: any) {
                    console.error(`/${cmdName} failed:`, err);
                    await ctx.reply(`❌ /${escapeMarkdown(cmdName)} crashed: ${escapeMarkdown(err.message)}`);
                    const owner = await getOwner();
                    if (owner && userId !== owner) {
                        try { await bot.api.sendMessage(owner, `⚠️ /${cmdName} crashed: ${err.message}`); } catch {}
                    }
                }
                return;
            }
        }

        // 4. Agent fallback
        try {
            const response = await runAgent(ctx, text);
            const chunks = response.match(/.{1,4000}/gs) || [""];
            for (const chunk of chunks) await ctx.reply(chunk);
        } catch (error: any) {
            await ctx.reply(`❌ Error: ${escapeMarkdown(error.message)}`);
        }
    });

    // ============================================================
    // CALLBACK HANDLER
    // ============================================================
    bot.on("callback_query:data", async (ctx) => {
        const data = ctx.callbackQuery.data;
        if (data.startsWith("conv_")) {
            await ctx.answerCallbackQuery();
            const parts = data.split("_");
            if (parts.length >= 3) {
                const jobId = parts[1];
                const targetExt = parts.slice(2).join("_");
                const job = conversionJobs.get(jobId);
                if (!job) return ctx.editMessageText("❌ Session expired.");
                await ctx.editMessageText("⏳ Converting...");
                try {
                    const resultPath = await convertFile(job.filePath, job.ext, targetExt);
                    const outputFileName = job.fileName.replace(new RegExp(`${job.ext}$`, 'i'), targetExt);
                    await ctx.replyWithDocument({ source: resultPath, filename: outputFileName });
                    await ctx.editMessageText(`✅ Converted to **${targetExt.toUpperCase()}**!`, { parse_mode: "Markdown" });
                    conversionJobs.delete(jobId);
                    await Bun.file(job.filePath).delete();
                    await Bun.file(resultPath).delete();
                } catch (err: any) {
                    await ctx.editMessageText(`❌ ${escapeMarkdown(err.message)}`);
                }
            }
        }
    });

    console.log("🤖 Bot starting...");
    await bot.start();
    console.log(`✅ Online as @${bot.botInfo?.username}`);
}

main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
});
