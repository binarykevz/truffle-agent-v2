import { getConfig } from "./db";

export interface ValidationResult {
    valid: boolean;
    code: string;
    errors: string[];
    wasFixed: boolean;
    fixAttempts: number;
}

export async function validateAndFixCode(
    code: string,
    commandName: string,
    onProgress?: (message: string) => void
): Promise<ValidationResult> {
    const errors: string[] = [];
    let currentCode = code;
    let wasFixed = false;
    const MAX_ATTEMPTS = 2;

    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
        const transpileResult = tryTranspile(currentCode);
        if (transpileResult.success) {
            const parseResult = tryParseAsFunction(currentCode);
            if (parseResult.success) {
                return { valid: true, code: currentCode, errors, wasFixed, fixAttempts: attempt };
            }
            errors.push(`Parse error: ${parseResult.error}`);
        } else {
            errors.push(`Transpile error: ${transpileResult.error}`);
        }

        if (attempt >= MAX_ATTEMPTS) break;

        onProgress?.(`🔧 Auto-fixing code (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        const fixedCode = await askLLMToFixCode(currentCode, errors[errors.length - 1], commandName);
        if (!fixedCode) {
            errors.push("LLM failed to return fixed code");
            break;
        }
        currentCode = fixedCode;
        wasFixed = true;
    }

    return { valid: false, code: currentCode, errors, wasFixed, fixAttempts: errors.length };
}

function tryTranspile(code: string): { success: boolean; error?: string } {
    try {
        const transpiler = new Bun.Transpiler({ loader: "ts" });
        transpiler.transformSync(code);
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
}

function tryParseAsFunction(code: string): { success: boolean; error?: string } {
    try {
        const wrapped = `(async function test() {
            const ctx = null, db = null, auth = null, utils = null;
            const { getConfig, setConfig, deleteConfig, getAllConfig, addAllowedUser, removeAllowedUser, listAllowedUsers, getCommand, saveCommand, deleteCommand, listCommands } = db || {};
            const { isOwner, isAllowedUser, getOwner } = auth || {};
            const { fetch, Bun } = utils || {};
            ${code}
        })`;
        new Function(wrapped);
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
}

async function askLLMToFixCode(code: string, error: string, commandName: string): Promise<string | null> {
    try {
        const apiKey = await getConfig("api_key");
        const baseUrl = await getConfig("base_url");
        const model = (await getConfig("model")) || "qwen-max";
        if (!apiKey || !baseUrl) return null;

        const systemPrompt = `You are a code validator for a Telegram bot command system.
The code will be executed as the body of an async function with these variables in scope:
- ctx: Grammy Context (ctx.reply, ctx.from, ctx.match, ctx.message, ctx.replyWithDocument, etc.)
- db: { getConfig, setConfig, deleteConfig, getAllConfig, addAllowedUser, removeAllowedUser, listAllowedUsers, getCommand, saveCommand, deleteCommand, listCommands }
- auth: { isOwner, isAllowedUser, getOwner }
- utils: { fetch, Bun }

Command name: /${commandName}

Rules:
- Return ONLY the fixed code, no explanation, no markdown fences.
- Keep the same functionality, just fix syntax/logic errors.
- Use await ctx.reply(...) to send messages.
- Code must be valid TypeScript/JavaScript.
- Do not add imports - all APIs are already in scope.`;

        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Fix this code:\n\n\`\`\`\n${code}\n\`\`\`\n\nError:\n${error}` },
                ],
                temperature: 0.1,
            }),
        });

        if (!res.ok) return null;
        const data = (await res.json()) as any;
        let fixed = data.choices?.[0]?.message?.content?.trim();
        if (!fixed) return null;
        fixed = fixed.replace(/^```(?:typescript|js|javascript)?\n?/i, "").replace(/\n?```$/i, "").trim();
        return fixed;
    } catch (e) {
        console.error("LLM fix request failed:", e);
        return null;
    }
}

export function quickSyntaxCheck(code: string): { valid: boolean; error?: string } {
    const transpile = tryTranspile(code);
    if (!transpile.success) return transpile;
    return tryParseAsFunction(code);
}