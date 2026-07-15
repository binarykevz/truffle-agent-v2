import { Bot } from "grammy";
import { runAgent } from "./agent";
import {
    initDB, seedOwner, getOwner, isOwner, isAllowedUser,
    getConfig, setConfig,
} from "./db";
import {
    initCommandsDB, getCommand, saveCommand, deleteCommand,
    toggleCommand, listCommands, updateCommandDescription,
} from "./commandsDb";
import { executeCommandCode } from "./commandRunner";
import { seedDefaultCommands } from "./seedCommands";
import { fixAndValidateCode } from "./codeFixer";
import { convertFile } from "./converter";

const pendingFeatures = new Map<number, { step: "code" | "description"; name: string; ownerOnly: boolean; code?: string }>();
const conversionJobs = new Map<string, { filePath: string; fileName: string; ext: string; userId: number }>();

async function main() {
    await initDB();
    await initCommandsDB();
    console.log("✅ Databases initialized");

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
        console.log("🔑 Bot token auto-seeded from .env");
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
                await ctx.reply(
                    `⛔ Unauthorized. Your ID: \`${ctx.from.id}\`\n` +
                    `Ask the owner${owner ? ` (ID: \`${owner}\`)` : ""} to run:\n` +
                    `\`/adduser ${ctx.from.id}\``,
                    { parse_mode: "Markdown" }
                );
            }
            return;
        }
        await next();
    });

    // ============================================================
    // META-COMMANDS (hardcoded, cannot be deleted)
    // ============================================================

    bot.command("addfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const parts = (ctx.match ?? "").trim().split(/\s+/);
        const name = parts[0]?.replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/addfeature <name> [owner_only]`\nExample: `/addfeature weather 1`", { parse_mode: "Markdown" });
        const ownerOnly = parts[1] === "1" || parts[1] === "true";
        pendingFeatures.set(ctx.from.id, { step: "code", name, ownerOnly });
        await ctx.reply(
            `🛠️ Adding feature \`/${name}\` (${ownerOnly ? "owner only" : "all users"})\n\n` +
            `Send the **code** for this command as your next message.\n\n` +
            `Available in your code:\n` +
            `• \`ctx\` — Grammy context\n` +
            `• \`db\` — { getConfig, setConfig, ... }\n` +
            `• \`auth\` — { isOwner, isAllowedUser, getOwner }\n` +
            `• \`utils\` — { fetch, Bun }\n\n` +
            `Type /cancel to abort.`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("editfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/editfeature <name>` then send new code", { parse_mode: "Markdown" });
        const cmd = await getCommand(name);
        if (!cmd) return ctx.reply(`❌ Command /${name} not found.`);
        pendingFeatures.set(ctx.from.id, { step: "code", name, ownerOnly: cmd.owner_only === 1 });
        await ctx.reply(
            `🛠️ Editing \`/${name}\`. Current code:\n\`\`\`\n${cmd.code.slice(0, 1000)}${cmd.code.length > 1000 ? "\n..." : ""}\n\`\`\`\n\nSend the **new code** as your next message. Type /cancel to abort.`,
            { parse_mode: "Markdown" }
        );
    });

    bot.command("descfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const parts = (ctx.match ?? "").split(/\s+/);
        const name = parts[0]?.replace(/^\//, "");
        const desc = parts.slice(1).join(" ");
        if (!name || !desc) return ctx.reply("Usage: `/descfeature <name> <description>`", { parse_mode: "Markdown" });
        const updated = await updateCommandDescription(name, desc);
        await ctx.reply(updated ? `✅ Updated description for /${name}` : `❌ Command /${name} not found.`);
    });

    bot.command("deletefeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/deletefeature <name>`", { parse_mode: "Markdown" });
        const deleted = await deleteCommand(name);
        await ctx.reply(deleted ? `✅ Deleted /${name}` : `❌ Command /${name} not found.`);
    });

    bot.command("togglefeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/togglefeature <name>`", { parse_mode: "Markdown" });
        const result = await toggleCommand(name);
        if (!result.found) return ctx.reply(`❌ Command /${name} not found.`);
        await ctx.reply(`${result.enabled ? "✅ Enabled" : "⏸️ Disabled"} /${name}`);
    });

    bot.command("listfeatures", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const cmds = await listCommands();
        if (cmds.length === 0) return ctx.reply("No features yet.");
        const lines = cmds.map(c => {
            const status = c.enabled ? "✅" : "⏸️";
            const lock = c.owner_only ? "🔒" : "🌐";
            return `${status}${lock} \`/${c.name}\` — ${c.description || "(no description)"}`;
        });
        await ctx.reply(`**Features (${cmds.length}):**\n` + lines.join("\n") + "\n\n🔒 = owner only | 🌐 = all users", { parse_mode: "Markdown" });
    });

    bot.command("viewfeature", async (ctx) => {
        if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
        const name = ctx.match?.trim().replace(/^\//, "");
        if (!name) return ctx.reply("Usage: `/viewfeature <name>`", { parse_mode: "Markdown" });
        const cmd = await getCommand(name);
        if (!cmd) return ctx.reply(`❌ Command /${name} not found.`);
        const code = cmd.code.length > 3500 ? cmd.code.slice(0, 3500) + "\n\n... (truncated)" : cmd.code;
        await ctx.reply(`**/${cmd.name}**\n\`\`\`\n${code}\n\`\`\``, { parse_mode: "Markdown" });
    });

    bot.command("cancel", async (ctx) => {
        if (pendingFeatures.has(ctx.from.id)) {
            pendingFeatures.delete(ctx.from.id);
            await ctx.reply("❌ Cancelled.");
        } else {
            await ctx.reply("Nothing to cancel.");
        }
    });

    // ============================================================
    // MESSAGE HANDLER
    // ============================================================
    bot.on("message:text", async (ctx) => {
        const text = ctx.message.text;
        const userId = ctx.from.id;

        // 1. Handle pending feature code/description
        const pending = pendingFeatures.get(userId);
        if (pending) {
            if (pending.step === "code") {
                await ctx.replyWithChatAction("typing");
                await ctx.reply("🔍 AI is reviewing and validating your code...");

                const fixResult = await fixAndValidateCode(text, pending.name);

                if (!fixResult.success) {
                    await ctx.reply(`❌ Code validation failed: ${fixResult.error}\n\nPlease try again or type /cancel.`);
                    return;
                }

                pending.code = fixResult.correctedCode;
                pending.step = "description";
                pendingFeatures.set(userId, pending);

                let changelogMsg = "✅ Code validated and corrected!\n\n";
                if (fixResult.changelog.length > 0 && fixResult.changelog[0] !== "Code validated successfully") {
                    changelogMsg += "**Changes made:**\n" + fixResult.changelog.map(c => `• ${c}`).join("\n") + "\n\n";
                }
                changelogMsg += "Now send a short **description** for this command (or type `skip`):";

                await ctx.reply(changelogMsg, { parse_mode: "Markdown" });
                return;
            }
            if (pending.step === "description") {
                const description = text.trim().toLowerCase() === "skip" ? "" : text.trim();
                try {
                    await saveCommand(pending.name, pending.code!, description, pending.ownerOnly, userId);
                    await ctx.reply(`✅ Feature \`/${pending.name}\` saved and live!`, { parse_mode: "Markdown" });
                } catch (err: any) {
                    await ctx.reply(`❌ Failed to save: ${err.message}`);
                }
                pendingFeatures.delete(userId);
                return;
            }
        }

        // 2. If it's a /command, try to load from DB
        if (text.startsWith("/")) {
            const cmdName = text.split(/\s+/)[0].replace(/^\//, "").split("@")[0];
            const cmd = await getCommand(cmdName);
            if (cmd) {
                if (cmd.owner_only && !(await isOwner(userId))) {
                    await ctx.reply("⛔ Owner only.");
                    return;
                }
                if (!cmd.enabled) {
                    await ctx.reply(`⏸️ /${cmdName} is currently disabled.`);
                    return;
                }
                try {
                    await executeCommandCode(cmd.code, ctx);
                } catch (err: any) {
                    console.error(`Command /${cmdName} failed:`, err);
                    await ctx.reply(`❌ Command /${cmdName} crashed: ${err.message}`);
                    const owner = await getOwner();
                    if (owner && userId !== owner) {
                        try { await bot.api.sendMessage(owner, `⚠️ /${cmdName} crashed when used by ${userId}: ${err.message}`); } catch {}
                    }
                }
                return;
            }
        }

        // 3. Otherwise, run the agentic handler
        try {
            const response = await runAgent(ctx, text);
            const chunks = response.match(/.{1,4000}/gs) || [""];
            for (const chunk of chunks) await ctx.reply(chunk);
        } catch (error: any) {
            console.error("Agent Error:", error);
            await ctx.reply(`❌ Error: ${error.message}`);
        }
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
        const fileLink = await ctx.getFileLink(doc.file_id);
        await Bun.write(filePath, await new Response(await fetch(fileLink)).arrayBuffer());
        const jobInfo = { jobId, filePath, fileName, ext, userId: ctx.from.id };
        conversionJobs.set(jobId, jobInfo);
        const userMessage = `Please process this attached file.\n\n[SYSTEM: User attached a file. Job ID: ${jobId}, Name: ${fileName}, Format: ${ext}]`;
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
        const fileLink = await ctx.getFileLink(photo.file_id);
        await Bun.write(filePath, await new Response(await fetch(fileLink)).arrayBuffer());
        const jobInfo = { jobId, filePath, fileName, ext, userId: ctx.from.id };
        conversionJobs.set(jobId, jobInfo);
        const userMessage = `Please process this attached image.\n\n[SYSTEM: User attached an image. Job ID: ${jobId}, Name: ${fileName}, Format: ${ext}]`;
        try {
            const response = await runAgent(ctx, userMessage, jobInfo);
            const chunks = response.match(/.{1,4000}/gs) || [""];
            for (const chunk of chunks) await ctx.reply(chunk);
        } catch (error: any) {
            await ctx.reply(`❌ Error: ${error.message}`);
        }
    });

    // ============================================================
    // CALLBACK QUERY HANDLER
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
                if (!job) {
                    await ctx.editMessageText("❌ Conversion session expired. Please upload the file again.");
                    return;
                }
                await ctx.editMessageText("⏳ Converting your file, please wait...");
                try {
                    const resultPath = await convertFile(job.filePath, job.ext, targetExt);
                    const outputFileName = job.fileName.replace(new RegExp(`${job.ext}$`, 'i'), targetExt);
                    await ctx.replyWithDocument({ source: resultPath, filename: outputFileName });
                    await ctx.editMessageText(`✅ Successfully converted to **${targetExt.toUpperCase()}**!`, { parse_mode: "Markdown" });
                    conversionJobs.delete(jobId);
                    await Bun.file(job.filePath).delete();
                    await Bun.file(resultPath).delete();
                } catch (err: any) {
                    await ctx.editMessageText(`❌ Conversion failed: ${err.message}`);
                }
            }
        }
    });

    console.log("🤖 Bot starting...");
    await bot.start();
    console.log(`✅ Online as @${bot.botInfo?.username}`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
