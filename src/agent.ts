import { Context } from "grammy";
import { callLLM, type ToolDef } from "./llm";
import { tools } from "./tools";
import { getHistory, saveMessage, clearHistory, type Message } from "./db";
import { getConversionOptions } from "./converter";

const SYSTEM_PROMPT = `You are an autonomous agentic assistant with file conversion capabilities.

## File Conversion Rules (CRITICAL):

### Scenario 1: User wants to convert but NO file is attached
- If user says "convert my PDF", "make this editable", "change to PNG", etc. WITHOUT uploading a file:
- Use the \`request_file_upload\` tool to ask them to upload the file

### Scenario 2: User uploads a file with conversion intent
- When the system message says "User attached a file" AND user's text suggests conversion:
- IMMEDIATELY use the \`show_conversion_menu\` tool with job_id, current_format, and available options
- Don't ask questions — just show the menu

### Scenario 3: User replies to a file message
- If the user replies to a previously uploaded file with conversion instructions:
- Use \`show_conversion_menu\` tool immediately

## General Guidelines:
- Be concise and helpful
- For file operations, act immediately
- Use tools when necessary`;

export async function runAgent(ctx: Context, userMessage: string, jobInfo?: any): Promise<string> {
    const userId = ctx.from!.id;
    let history = await getHistory(userId);
    let systemPrompt = SYSTEM_PROMPT;
    if (jobInfo) {
        const options = getConversionOptions(jobInfo.ext);
        systemPrompt += `\n\n🚨 User attached a file. Job ID: ${jobInfo.jobId}, Format: ${jobInfo.ext}. Options: ${options.join(", ")}. Use 'show_conversion_menu' tool.`;
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

        if (!reply.tool_calls || reply.tool_calls.length === 0) return reply.content || "I'm not sure.";

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
    return "⚠️ Max steps reached.";
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
