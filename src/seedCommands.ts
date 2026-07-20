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
            name: "adduser", description: "Allow a user (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const targetId = Number(ctx.match?.trim());
if (!targetId || isNaN(targetId)) return ctx.reply("Usage: \`/adduser <user_id>\`", { parse_mode: "Markdown" });
const added = await addAllowedUser(targetId, undefined, ctx.from.id);
await ctx.reply(added ? \`✅ Added user \\\`\${targetId}\\\`\` : \`ℹ️ Already allowed\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "removeuser", description: "Revoke a user (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const targetId = Number(ctx.match?.trim());
if (!targetId || isNaN(targetId)) return ctx.reply("Usage: \`/removeuser <user_id>\`", { parse_mode: "Markdown" });
if (targetId === ctx.from.id) return ctx.reply("⛔ Cannot remove yourself.");
const removed = await removeAllowedUser(targetId);
await ctx.reply(removed ? \`✅ Removed user \\\`\${targetId}\\\`\` : \`ℹ️ Not in list\`, { parse_mode: "Markdown" });
`,
        },
        {
            name: "listusers", description: "Show allowed users (owner only)", ownerOnly: true,
            code: `
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const users = await listAllowedUsers();
if (users.length === 0) return ctx.reply("No allowed users yet.");
const lines = users.map(u => \`• \\\`\${u.user_id}\\\` \${u.username ? \`(@\${u.username})\` : ""}\`);
await ctx.reply(\`**Allowed users (\${users.length}):**\\n\` + lines.join("\\n"), { parse_mode: "Markdown" });
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
