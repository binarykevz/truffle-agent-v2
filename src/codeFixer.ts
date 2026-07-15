import { getConfig } from "./db";

export interface CodeFixResult {
    success: boolean;
    correctedCode: string;
    changelog: string[];
    error?: string;
}

const API_SURFACE_DOCS = `
Available variables in the command code:
- ctx: Grammy Context object
  - ctx.reply(text, options) — send text message
  - ctx.replyWithDocument(file, options) — send document
  - ctx.replyWithPhoto(photo, options) — send photo
  - ctx.from.id — user's Telegram ID
  - ctx.from.first_name — user's first name
  - ctx.from.username — user's username
  - ctx.match — text after the command
  - ctx.message — the message object
  - ctx.editMessageText(text) — edit the last message
  - ctx.answerCallbackQuery() — acknowledge button clicks
  - ctx.replyWithChatAction(action) — show typing/uploading status

- db: Database helpers
  - db.getConfig(key) → string | null
  - db.setConfig(key, value) → void
  - db.deleteConfig(key) → void
  - db.getAllConfig() → Record<string, string>
  - db.addAllowedUser(userId, username, addedBy) → boolean
  - db.removeAllowedUser(userId) → boolean
  - db.listAllowedUsers() → array
  - db.getCommand(name) → StoredCommand | null
  - db.saveCommand(name, code, description, ownerOnly, createdBy) → void
  - db.deleteCommand(name) → boolean
  - db.listCommands() → array

- auth: Authentication helpers
  - auth.isOwner(userId) → boolean
  - auth.isAllowedUser(userId) → boolean
  - auth.getOwner() → number | null

- utils: Utilities
  - utils.fetch(url, options) — standard fetch
  - utils.Bun — Bun runtime object

Rules:
- Use "await" for all async operations
- Use template literals for string interpolation
- Escape backticks in strings with \\\`
- Escape newlines in strings with \\n
- Always handle errors with try/catch when appropriate
- Use ctx.reply() to send responses to the user
`;

export async function fixAndValidateCode(code: string, commandName: string): Promise<CodeFixResult> {
    const apiKey = await getConfig("api_key");
    const baseUrl = await getConfig("base_url");
    const model = (await getConfig("model")) || "qwen-max";

    if (!apiKey || !baseUrl) {
        return { success: false, correctedCode: code, changelog: [], error: "LLM not configured. Cannot validate code." };
    }

    const systemPrompt = `You are a code reviewer for a Telegram bot. Validate and fix user-submitted command code.

${API_SURFACE_DOCS}

When reviewing code:
1. Check for syntax errors
2. Ensure correct API usage (ctx, db, auth, utils)
3. Fix any missing "await" keywords
4. Fix string escaping issues
5. Ensure the code actually does something useful
6. Return ONLY the corrected code wrapped in a code block, followed by a brief changelog

If the code is already correct, return it unchanged and say "Code validated successfully".`;

    const userPrompt = `Command name: /${commandName}

Code to review:
\`\`\`
${code}
\`\`\`

Return the corrected code in a code block and a changelog of what you fixed.`;

    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                temperature: 0.1,
            }),
        });

        if (!res.ok) {
            return { success: false, correctedCode: code, changelog: [], error: `LLM validation failed: ${res.status}` };
        }

        const data = (await res.json()) as any;
        const response = data.choices[0].message.content.trim();

        const codeMatch = response.match(/```(?:typescript|js|javascript)?\n([\s\S]*?)\n```/);
        const correctedCode = codeMatch ? codeMatch[1].trim() : response;

        const changelogMatch = response.match(/```[\s\S]*?```\s*([\s\S]*)/);
        const changelogText = changelogMatch ? changelogMatch[1].trim() : "";
        const changelog = changelogText
            .split("\n")
            .map((line) => line.replace(/^[-*•]\s*/, "").trim())
            .filter((line) => line.length > 0 && line.length < 200);

        return {
            success: true,
            correctedCode,
            changelog: changelog.length > 0 ? changelog : ["Code validated successfully"],
        };
    } catch (err: any) {
        return { success: false, correctedCode: code, changelog: [], error: `Code validation error: ${err.message}` };
    }
}
