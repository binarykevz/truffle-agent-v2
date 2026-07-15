import { createClient, type Client } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
if (!url) throw new Error("TURSO_DATABASE_URL is required in .env");

export const db: Client = createClient({
    url,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

export async function initDB() {
    await db.batch([
        `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS allowed_users (user_id INTEGER PRIMARY KEY, username TEXT, added_by INTEGER, added_at INTEGER NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, role TEXT NOT NULL, content TEXT, tool_calls TEXT, tool_call_id TEXT, name TEXT, timestamp INTEGER NOT NULL)`,
        `CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, timestamp)`,
    ], "write");
}

// ============================================================
// CONFIG
// ============================================================

export async function getConfig(key: string): Promise<string | null> {
    const row = await db.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [key] });
    return (row.rows[0]?.value as string) ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
    await db.execute({
        sql: `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [key, value, Date.now()],
    });
}

export async function deleteConfig(key: string): Promise<void> {
    await db.execute({ sql: "DELETE FROM config WHERE key = ?", args: [key] });
}

export async function getAllConfig(): Promise<Record<string, string>> {
    const rows = await db.execute("SELECT key, value FROM config");
    const out: Record<string, string> = {};
    for (const r of rows.rows) out[r.key as string] = r.value as string;
    return out;
}

// ============================================================
// OWNER
// ============================================================

export async function seedOwner(): Promise<number | null> {
    const envOwner = process.env.OWNER_ID;
    if (!envOwner) return null;
    const ownerId = Number(envOwner);
    if (isNaN(ownerId)) return null;
    await setConfig("owner_id", String(ownerId));
    await addAllowedUser(ownerId, undefined, ownerId);
    return ownerId;
}

export async function getOwner(): Promise<number | null> {
    const val = await getConfig("owner_id");
    return val ? Number(val) : null;
}

export async function isOwner(userId: number): Promise<boolean> {
    return (await getOwner()) === userId;
}

// ============================================================
// ALLOWED USERS
// ============================================================

export async function addAllowedUser(userId: number, username: string | undefined, addedBy: number): Promise<boolean> {
    try {
        await db.execute({ sql: `INSERT INTO allowed_users (user_id, username, added_by, added_at) VALUES (?, ?, ?, ?)`, args: [userId, username ?? null, addedBy, Date.now()] });
        return true;
    } catch { return false; }
}

export async function removeAllowedUser(userId: number): Promise<boolean> {
    const res = await db.execute({ sql: "DELETE FROM allowed_users WHERE user_id = ?", args: [userId] });
    return (res.rowsAffected ?? 0) > 0;
}

export async function isAllowedUser(userId: number): Promise<boolean> {
    if (await isOwner(userId)) return true;
    const row = await db.execute({ sql: "SELECT 1 FROM allowed_users WHERE user_id = ?", args: [userId] });
    return row.rows.length > 0;
}

export async function listAllowedUsers(): Promise<{ user_id: number; username: string | null; added_at: number }[]> {
    const rows = await db.execute("SELECT user_id, username, added_at FROM allowed_users ORDER BY added_at ASC");
    return rows.rows.map((r) => ({ user_id: r.user_id as number, username: r.username as string | null, added_at: r.added_at as number }));
}

// ============================================================
// HISTORY
// ============================================================

export interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}

export async function getHistory(userId: number): Promise<Message[]> {
    const rows = await db.execute({ sql: "SELECT * FROM history WHERE user_id = ? ORDER BY timestamp ASC", args: [userId] });
    const messages: Message[] = rows.rows.map((r) => {
        const msg: Message = { role: r.role as Message["role"], content: r.content as string | null };
        if (r.tool_calls) msg.tool_calls = JSON.parse(r.tool_calls as string);
        if (r.tool_call_id) msg.tool_call_id = r.tool_call_id as string;
        if (r.name) msg.name = r.name as string;
        return msg;
    });
    return sanitizeHistory(messages);
}

export async function saveMessage(userId: number, msg: Message): Promise<void> {
    await db.execute({
        sql: `INSERT INTO history (user_id, role, content, tool_calls, tool_call_id, name, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [userId, msg.role, msg.content ?? null, msg.tool_calls ? JSON.stringify(msg.tool_calls) : null, msg.tool_call_id ?? null, msg.name ?? null, Date.now()],
    });
}

export async function clearHistory(userId: number): Promise<void> {
    await db.execute({ sql: "DELETE FROM history WHERE user_id = ?", args: [userId] });
}

function sanitizeHistory(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    let lastSafePoint = 0;
    let pendingToolIds = new Set<string>();
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "assistant" && msg.tool_calls?.length) {
            pendingToolIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
        } else if (msg.role === "tool" && msg.tool_call_id) {
            pendingToolIds.delete(msg.tool_call_id);
        }
        if (pendingToolIds.size === 0) lastSafePoint = i + 1;
    }
    let safe = messages.slice(0, lastSafePoint);
    const MAX = 40;
    if (safe.length > MAX) {
        const sys = safe.find((m) => m.role === "system");
        const rest = safe.filter((m) => m.role !== "system").slice(-MAX + 1);
        safe = sys ? [sys, ...rest] : rest;
    }
    return safe;
}
