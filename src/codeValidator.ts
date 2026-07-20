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

        const systemPrompt = `You are a code validator for a Telegram bot command.
Code runs as async function body with: ctx, db, auth, utils in scope.
Command name: /${commandName}

CRITICAL: Return ONLY the fixed code. NO explanations, NO changelog, NO markdown fences.
Just raw TypeScript/JavaScript code.`;

        const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: `Fix this code:\n\n${code}\n\nError:\n${error}` },
                ],
                temperature: 0.1,
            }),
        });

        if (!res.ok) return null;
        const data = (await res.json()) as any;
        let fixed = data.choices?.[0]?.message?.content?.trim();
        if (!fixed) return null;

        fixed = fixed.replace(/^```(?:typescript|ts|js|javascript)?\n?/i, "").replace(/\n?```$/i, "").trim();
        fixed = fixed.replace(/\*\*Changes made:\*\*[\s\S]*$/i, "").trim();
        fixed = fixed.replace(/## Changes[\s\S]*$/i, "").trim();
        fixed = fixed.replace(/Changelog:[\s\S]*$/i, "").trim();
        fixed = fixed.replace(/Explanation:[\s\S]*$/i, "").trim();

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
