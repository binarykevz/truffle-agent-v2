import * as db from "./db";

export async function seedDefaultCommands(ownerId: number) {
    const defaults = [
        {
            name: "start", description: "Welcome message", ownerOnly: false,
            code: `await ctx.reply(\`👋 Welcome, \${ctx.from.first_name}! Use /help for commands.\`);`,
        },
        {
            name: "help", description: "Show commands", ownerOnly: false,
            code: `
const owner = await isOwner(ctx.from.id);
let msg = "**User Commands**\\n/reset — Clear memory\\n/help — Show this\\n\\n";
if (owner) msg += "**Owner Commands**\\n/adduser, /removeuser, /listusers\\n/setconfig, /getconfig, /delconfig\\n/status\\n/addfeature, /editfeature, /deletefeature, /listfeatures, /togglefeature, /viewfeature\\n/cachestats, /clearcache";
await ctx.reply(msg, { parse_mode: "Markdown" });
`,
        },
        {
            name: "reset", description: "Clear memory", ownerOnly: false,
            code: `
const { clearHistory } = await import("./db.js");
await clearHistory(ctx.from.id);
await ctx.reply("🧹 Memory cleared.");
`,
        },
               {
            name: "adduser", description: "Add a user (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
let targetId = null, targetUsername = undefined, targetFirstName = undefined;
const repliedTo = ctx.message?.reply_to_message;
if (repliedTo?.from) {
    targetId = repliedTo.from.id;
    targetUsername = repliedTo.from.username;
    targetFirstName = repliedTo.from.first_name;
} else if (ctx.match?.trim()) {
    const parsed = Number(ctx.match.trim());
    if (!isNaN(parsed) && parsed > 0) targetId = parsed;
}
if (!targetId) return ctx.reply("Usage: Reply with /adduser or /adduser <id>", { parse_mode: "Markdown" });
const ownerId = await getOwner();
if (targetId === ownerId) return ctx.reply("ℹ️ Already the owner.");
const added = await addAllowedUser(targetId, targetUsername, ctx.from.id);
const displayName = targetUsername ? \`@\\\${targetUsername}\` : (targetFirstName || \`ID \\\${targetId}\`);
await ctx.reply(added ? \`✅ Added user \\\${displayName} (\\\`\${targetId}\\\`)\` : \`ℹ️ Already allowed\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "addgroup", description: "Approve a group (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const chat = ctx.chat;
if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
    return ctx.reply("⚠️ Use this command inside a group chat.");
}
const groupId = chat.id;
const groupTitle = chat.title;
const groupUsername = chat.username || undefined;
const added = await addAllowedGroup(groupId, groupTitle, groupUsername, ctx.from.id);
const displayTitle = groupUsername ? \`@\\\${groupUsername}\` : (groupTitle || \`ID \\\${groupId}\`);
await ctx.reply(
    added 
        ? \`✅ Added group \\\${displayTitle}\\\\n🆔 Chat ID: \\\`\\\${groupId}\\\`\\\\n👥 All members can now use the bot!\`
        : \`ℹ️ Group already allowed.\`,
    { parse_mode: "Markdown" }
);
`,
        },
        {
            name: "removeuser", description: "Remove a user (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
let targetId = null, displayName = "";
const repliedTo = ctx.message?.reply_to_message;
if (repliedTo?.from) {
    targetId = repliedTo.from.id;
    displayName = repliedTo.from.username ? \`@\\\${repliedTo.from.username}\` : repliedTo.from.first_name;
} else if (ctx.match?.trim()) {
    const parsed = Number(ctx.match.trim());
    if (!isNaN(parsed)) {
        targetId = parsed;
        const entry = await getEntry(parsed);
        displayName = entry?.username ? \`@\\\${entry.username}\` : (entry?.title || \`ID \\\${parsed}\`);
    }
}
if (!targetId) return ctx.reply("Usage: Reply with /removeuser or /removeuser <id>", { parse_mode: "Markdown" });
if (targetId === ctx.from.id) return ctx.reply("⛔ Cannot remove yourself.");
const ownerId = await getOwner();
if (targetId === ownerId) return ctx.reply("⛔ Cannot remove the owner.");
const removed = await removeAllowedUser(targetId);
await ctx.reply(removed ? \`✅ Removed \\\${displayName || targetId}\` : \`ℹ️ Not in list\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "removegroup", description: "Remove a group (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
let targetId;
if (ctx.match?.trim()) {
    const parsed = Number(ctx.match.trim());
    if (isNaN(parsed)) return ctx.reply("Usage: /removegroup <chat_id>", { parse_mode: "Markdown" });
    targetId = parsed;
} else if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
    targetId = ctx.chat.id;
} else {
    return ctx.reply("Usage: /removegroup <chat_id> or use in a group", { parse_mode: "Markdown" });
}
const entry = await getEntry(targetId);
if (!entry || entry.type !== 'group') return ctx.reply(\`ℹ️ \\\`\${targetId}\\\` is not an approved group.\`);
const removed = await removeAllowedUser(targetId);
await ctx.reply(removed ? \`✅ Removed group \\\${entry.title || targetId}\` : \`ℹ️ Not found.\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "listusers", description: "List allowed users and groups (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const { users, groups } = await listAllowedUsers();
if (users.length === 0 && groups.length === 0) return ctx.reply("No allowed users or groups yet.");
let msg = "";
if (groups.length > 0) {
    msg += \`**👥 Approved Groups (\\\${groups.length}):**\\\\n\`;
    for (const g of groups) {
        const name = g.username ? \`@\\\${g.username}\` : (g.title || 'Unknown');
        msg += \`• \\\`\\\${g.chat_id}\\\` — \\\${name}\\\\n\`;
    }
    msg += \`\\\\n\`;
}
if (users.length > 0) {
    msg += \`**👤 Approved Users (\\\${users.length}):**\\\\n\`;
    for (const u of users) {
        const name = u.username ? \`@\\\${u.username}\` : 'no username';
        msg += \`• \\\`\\\${u.user_id}\\\` — \\\${name}\\\\n\`;
    }
}
await ctx.reply(msg, { parse_mode: "Markdown" });
`,
        },
        {
            name: "setconfig", description: "Set config (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const parts = (ctx.match ?? "").split(/\\s+/);
if (parts.length < 2) return ctx.reply("Usage: \`/setconfig <key> <value>\`", { parse_mode: "Markdown" });
const [key, ...rest] = parts;
await setConfig(key, rest.join(" "));
await ctx.reply(\`✅ Set \\\`\${key}\\\`\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "getconfig", description: "View config (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const key = ctx.match?.trim();
if (key) {
    const val = await getConfig(key);
    await ctx.reply(val === null ? \`❓ \\\`\${key}\\\` not set\` : \`\\\`\${key}\\\` = \\\`\${val}\\\`\`, { parse_mode: "Markdown" });
} else {
    const all = await getAllConfig();
    const lines = Object.entries(all).map(([k, v]) => {
        const masked = ["api_key", "bot_token", "openclaw_token"].includes(k) ? v.slice(0, 6) + "***" + v.slice(-4) : v;
        return \`\\\`\${k}\\\` = \\\`\${masked}\\\`\`;
    });
    await ctx.reply("**Config:**\\n" + (lines.join("\\n") || "(empty)"), { parse_mode: "Markdown" });
}
`,
        },
        {
            name: "delconfig", description: "Delete config key (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const key = ctx.match?.trim();
if (!key) return ctx.reply("Usage: \`/delconfig <key>\`", { parse_mode: "Markdown" });
await deleteConfig(key);
await ctx.reply(\`✅ Deleted \\\`\${key}\\\`\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "status", description: "Bot status (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const config = await getAllConfig();
const users = await listAllowedUsers();
const owner = await getOwner();
const cmds = await listCommands();
await ctx.reply(
    \`**Bot Status**\\n\` +
    \`• Owner: \\\`\${owner ?? "not set"}\\\`\\n\` +
    \`• Allowed users: \${users.length}\\n\` +
    \`• Active commands: \${cmds.filter(c => c.enabled).length}/\${cmds.length}\\n\` +
    \`• Model: \\\`\${config.model ?? "not set"}\\\`\\n\` +
    \`• API Key: \${config.api_key ? "✅" : "❌"}\\n\` +
    \`• OpenClaw Token: \${config.openclaw_token ? "✅" : "❌"}\`,
    { parse_mode: "Markdown" }
);
`,
        },
    ];

    for (const cmd of defaults) {
        const existing = await db.getCommand(cmd.name);
        if (!existing) {
            await db.saveCommand(cmd.name, cmd.code, cmd.description, cmd.ownerOnly, ownerId);
            console.log(`  📦 Seeded command: /${cmd.name}`);
        }
    }
}
