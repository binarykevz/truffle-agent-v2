import { type Message, getConfig } from "./db";
import { llmCache, hashKey } from "./cache";

export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, any>;
}

export async function callLLM(messages: Message[], tools: ToolDef[]): Promise<Message> {
    const apiKey = await getConfig("api_key");
    const baseUrl = await getConfig("base_url");
    const model = (await getConfig("model")) || "qwen-max";

    if (!apiKey || !baseUrl) throw new Error("api_key or base_url not configured.");

    const cacheKey = hashKey(model, messages, tools.map(t => t.name));
    const cached = llmCache.get(cacheKey);
    if (cached) {
        console.log(`[cache] LLM hit for ${cacheKey.slice(0, 8)}...`);
        return cached;
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
            model, messages,
            tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
            tool_choice: "auto", stream: false,
        }),
    });

    if (!res.ok) throw new Error(`LLM Error: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as any;
    const response = data.choices[0].message;

    llmCache.set(cacheKey, response);
    console.log(`[cache] LLM cached for ${cacheKey.slice(0, 8)}...`);
    return response;
}
