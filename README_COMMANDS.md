# 🛠️ Dynamic Command System Guide

The bot features a **self-modifying command system** where the owner can add, edit, and delete bot features entirely through Telegram — no code deployments required.

## 🎯 Meta-Commands (Owner Only)

| Command | Description |
|---|---|
| `/addfeature <name> [owner_only]` | Add a new feature (wizard) |
| `/editfeature <name>` | Edit an existing feature's code |
| `/descfeature <name> <description>` | Update a feature's description |
| `/deletefeature <name>` | Delete a feature permanently |
| `/togglefeature <name>` | Enable/disable a feature |
| `/listfeatures` | Show all features with status |
| `/viewfeature <name>` | View a feature's code |
| `/cancel` | Abort a pending add/edit |

## 🧙 Adding a New Feature (Wizard)

### Step 1: Start the wizard
```
You: /addfeature weather
```

The bot responds:
```
🛠️ Adding feature /weather (all users)

Send the code for this command as your next message.

Available in your code:
• ctx — Grammy context
• db — { getConfig, setConfig, ... }
• auth — { isOwner, isAllowedUser, getOwner }
• utils — { fetch, Bun }

Type /cancel to abort.
```

### Step 2: Send your code
```
You: const res = await fetch("https://wttr.in/?format=3");
     const weather = await res.text();
     await ctx.reply(`🌤️ ${weather}`);
```

### Step 3: AI validates and corrects
```
Bot: 🔍 AI is reviewing and validating your code...

Bot: ✅ Code validated and corrected!

     **Changes made:**
     • Added missing "await" keywords
     • Fixed string escaping

     Now send a short description (or type `skip`):
```

### Step 4: Add a description
```
You: Show current weather

Bot: ✅ Feature /weather saved and live!
```

Now any user can type `/weather` and get the current weather!

## 🔒 Making a Feature Owner-Only

Add `1` or `true` after the name:
```
You: /addfeature adminstats 1
```

## 📝 Available API in Command Code

### `ctx` — Grammy Context
```typescript
ctx.reply(text, options)              // Send text
ctx.replyWithDocument(file, options)  // Send document
ctx.replyWithPhoto(photo, options)    // Send photo
ctx.from.id                           // User's Telegram ID
ctx.from.first_name                   // User's first name
ctx.from.username                     // User's username
ctx.match                             // Text after command
ctx.editMessageText(text)             // Edit last message
ctx.answerCallbackQuery()             // Acknowledge button clicks
ctx.replyWithChatAction(action)       // Show typing/uploading
```

### `db` — Database Helpers
```typescript
db.getConfig(key)                     // → string | null
db.setConfig(key, value)              // → void
db.deleteConfig(key)                  // → void
db.getAllConfig()                     // → Record<string, string>
db.addAllowedUser(userId, username, addedBy)  // → boolean
db.removeAllowedUser(userId)          // → boolean
db.listAllowedUsers()                 // → array
db.getCommand(name)                   // → StoredCommand | null
db.saveCommand(name, code, description, ownerOnly, createdBy)  // → void
db.deleteCommand(name)                // → boolean
db.listCommands()                     // → array
```

### `auth` — Authentication
```typescript
auth.isOwner(userId)                  // → boolean
auth.isAllowedUser(userId)            // → boolean
auth.getOwner()                       // → number | null
```

### `utils` — Utilities
```typescript
utils.fetch(url, options)             // Standard fetch
utils.Bun                             // Bun runtime
```

## 💡 Example Features

### Weather Command
```typescript
const res = await fetch("https://wttr.in/?format=3");
const weather = await res.text();
await ctx.reply(`🌤️ ${weather}`);
```

### User Info Command
```typescript
const user = ctx.from;
await ctx.reply(
    `**User Info**\n` +
    `• ID: \`${user.id}\`\n` +
    `• Name: ${user.first_name}\n` +
    `• Username: @${user.username || "none"}`,
    { parse_mode: "Markdown" }
);
```

### Bot Uptime Command
```typescript
const uptime = Math.floor(process.uptime());
const cmds = await listCommands();
await ctx.reply(
    `⚙️ Uptime: ${uptime}s\n` +
    `📊 Commands: ${cmds.length}`
);
```

### Random Quote Command
```typescript
const res = await fetch("https://api.quotable.io/random");
const data = await res.json();
await ctx.reply(`"${data.content}"\n\n— ${data.author}`);
```

### Config Backup Command (Owner Only)
```typescript
if (!(await isOwner(ctx.from.id))) return ctx.reply("⛔ Owner only.");
const config = await getAllConfig();
const backup = JSON.stringify(config, null, 2);
await ctx.reply(`**Config Backup**\n\`\`\`json\n${backup}\n\`\`\``, { parse_mode: "Markdown" });
```

## 🔄 Editing a Feature

```
You: /editfeature weather

Bot: 🛠️ Editing /weather. Current code:
     ```
     const res = await fetch("https://wttr.in/?format=3");
     ...
     ```

     Send the new code as your next message. Type /cancel to abort.

You: [paste new code]

Bot: 🔍 AI is reviewing...
     ✅ Code validated!
     ...
```

## 📊 Managing Features

### List All Features
```
You: /listfeatures

Bot: **Features (12):**
     ✅🌐 /start — Welcome message
     ✅🌐 /help — Show available commands
     ✅🌐 /reset — Clear conversation memory
     ✅🔒 /adduser — Allow a user (owner only)
     ✅🔒 /removeuser — Revoke a user (owner only)
     ✅🔒 /listusers — Show allowed users (owner only)
     ✅🔒 /setconfig — Set a config value (owner only)
     ✅🔒 /getconfig — View config (owner only)
     ✅🔒 /delconfig — Delete a config key (owner only)
     ✅🔒 /status — Bot status overview (owner only)
     ✅🌐 /weather — Show current weather
     ⏸️🌐 /oldfeature — (no description)

     🔒 = owner only | 🌐 = all users
```

### Disable a Feature
```
You: /togglefeature oldfeature

Bot: ⏸️ Disabled /oldfeature
```

### Delete a Feature
```
You: /deletefeature oldfeature

Bot: ✅ Deleted /oldfeature
```

## 🛡️ Safety Features

1. **AI Code Validation** — All code is reviewed and corrected before saving
2. **Changelog Display** — Shows exactly what the AI fixed
3. **Error Isolation** — Crashing commands don't kill the bot
4. **Owner Notification** — Owner is notified when a command crashes
5. **Meta-Commands Are Hardcoded** — Cannot be deleted or overwritten
6. **Two Isolated Databases** — Commands can't corrupt user data

## 🎯 Best Practices

1. **Keep code simple** — Each command should do one thing well
2. **Handle errors** — Use try/catch for network calls
3. **Use await** — All async operations need await
4. **Test before deploying** — Use `/viewfeature` to review code
5. **Document with descriptions** — Helps you remember what each feature does
6. **Use owner_only for sensitive features** — Protect admin commands

## 🐛 Troubleshooting

### Command crashes
```bash
pm2 logs truffle-agent --lines 20
```
Check the error message and fix the code with `/editfeature`.

### AI validation fails
- Check your syntax
- Ensure you're using the correct API (ctx, db, auth, utils)
- Add missing `await` keywords
- Try again — the AI might have had a temporary issue

### Feature doesn't appear in /listfeatures
- Check if it's disabled: `/togglefeature <name>`
- Verify it was saved: `/viewfeature <name>`

---

Your bot is now a **self-modifying platform**. Add features, iterate, and deploy new capabilities without ever touching the codebase again!
