import { Context } from "grammy";
import { callLLM, type ToolDef } from "./llm";
import { tools } from "./tools";
import { getHistory, saveMessage, clearHistory, type Message } from "./db";
import { getConversionOptions } from "./converter";

const SYSTEM_PROMPT = `You are an autonomous agentic assistant. You can:
- Crawl the web for research
- Generate and deploy TypeScript programs
- Send messages to the OpenClaw agent via webhook
- Open apps on the user's device (WhatsApp, Gmail, YouTube, etc.)
- List installed apps (if running on Termux/Android)
- Handle file conversions interactively

Guidelines:
- When the user asks to open an app, use the "open_app" tool.
- For phone calls, use app="dialer" with extra="+1234567890".
- For SMS, use app="sms" with extra="+1234567890".
- When the user wants to interact with OpenClaw, use "openclaw_action".
- Think step-by-step. Use tools when necessary. Keep responses concise.`;

export async function runAgent(ctx: Context, userMessage: string, jobInfo?: any): Promise<string> {
    const userId = ctx.from!.id;
    let history = await getHistory(userId);

    let systemPrompt = SYSTEM_PROMPT;
    if (jobInfo) {
        const options = getConversionOptions(jobInfo.ext);
        systemPrompt += `\n\n🚨 ATTENTION: The user has attached a file.
        Job ID: ${jobInfo.jobId}
        File Name: ${jobInfo.fileName}
        Current Format: ${jobInfo.ext}
        Available Conversion Options: ${options.join(", ")}
        Your task: Acknowledge the file naturally, and IMMEDIATELY use the 'show_conversion_menu' tool to let the user choose their desired output format.`;
    }

    if (history.length === 0) history.push({ role: "system", content: systemPrompt });
    history.push({ role: "user", content: userMessage });
    await saveMessage(userId, { role: "user", content: userMessage });

    const toolDefs: ToolDef[] = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

    for (let i = 0; i < 5; i++) {
        await ctx.replyWithChatAction("typing");
        history = validateForLLM(history);
        const reply = await callLLM(history, toolDefs);
        history.push(reply);
        await saveMessage(userId, reply);

        if (!reply.tool_calls || reply.tool_calls.length === 0) return reply.content || "I'm not sure how to respond to that.";

        for (const toolCall of reply.tool_calls) {
            const toolName = toolCall.function.name;
            let toolArgs: any = {};
            try { toolArgs = JSON.parse(toolCall.function.arguments || "{}"); } catch { toolArgs = {}; }
            const tool = tools.find((t) => t.name === toolName);
            let result: any = "Tool not found";
            if (tool) {
                try { result = await tool.execute(toolArgs, ctx); } catch (err: any) { result = `Error: ${err.message}`; }
            }
            const toolMsg: Message = { role: "tool", content: typeof result === "string" ? result : JSON.stringify(result), tool_call_id: toolCall.id, name: toolName };
            history.push(toolMsg);
            await saveMessage(userId, toolMsg);
        }
    }
    return "⚠️ I reached the maximum number of steps. Please try again.";
}

export async function resetAgent(userId: number) { await clearHistory(userId); }

function validateForLLM(messages: Message[]): Message[] {
    const copy = [...messages];
    while (copy.length > 0) {
        const last = copy[copy.length - 1];
        if (last.role === "assistant" && last.tool_calls && last.tool_calls.length > 0) { copy.pop(); continue; }
        if (last.role === "tool") {
            const match = copy.slice(0, -1).reverse().find((m) => m.role === "assistant" && m.tool_calls?.some((tc: any) => tc.id === last.tool_call_id));
            if (!match) { copy.pop(); continue; }
        }
        break;
    }
    return copy;
}
