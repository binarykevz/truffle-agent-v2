import { createClient, type Client } from "@libsql/client";

// ============================================================
// TURSO DATABASES (matching your .env exactly)
// ============================================================

// 1. Main Database (users, config, history)
const mainUrl = process.env.TURSO_DATABASE_URL;
if (!mainUrl) throw new Error("TURSO_DATABASE_URL is required in .env");
export const mainDb: Client = createClient({
    url: mainUrl,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

// 2. Commands Database (isolated feature code)
const commandsUrl = process.env.TURSO_COMMANDS_DATABASE_URL;
if (!commandsUrl) throw new Error("TURSO_COMMANDS_DATABASE_URL is required in .env");
export const commandsDb: Client = createClient({
    url: commandsUrl,
    authToken: process.env.TURSO_COMMANDS_AUTH_TOKEN || undefined,
});

// 3. Memory Database
const memoryUrl = process.env.TURSO_MEMORY_URL;
export const memoryDb: Client = memoryUrl 
    ? createClient({ url: memoryUrl, authToken: process.env.TURSO_MEMORY_TOKEN || undefined })
    : mainDb; // Fallback to mainDb if memory URL is empty

// ============================================================
// SCHEMA INITIALIZATION
// ============================================================

export async function initMainDB() {
    await mainDb.batch([
        `CREATE TABLE IF NOT EXISTS allowed_users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            added_by INTEGER,
            added_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS owner (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            user_id INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT,
            tool_calls TEXT,
            tool_call_id TEXT,
            name TEXT,
            timestamp INTEGER NOT NULL
        )`,
        `CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, timestamp)`,
    ], "write");
}

export async function initCommandsDB() {
    await commandsDb.batch([
        `CREATE TABLE IF NOT EXISTS commands (
            name TEXT PRIMARY KEY,
            description TEXT NOT NULL DEFAULT '',
            code TEXT NOT NULL,
            owner_only INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_by INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )`,
    ], "write");
}

export async function initMemoryDB() {
    // Initialize memory DB schema if it's separate from mainDb
    if (memoryUrl && memoryUrl !== process.env.TURSO_DATABASE_URL) {
        await memoryDb.batch([
            `CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )`,
            `CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                tool_calls TEXT,
                tool_call_id TEXT,
                name TEXT,
                timestamp INTEGER NOT NULL
            )`,
            `CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, timestamp)`,
        ], "write");
    }
}

// ============================================================
// CONFIG (using mainDb as per your .env comment)
// ============================================================

export async function getConfig(key: string): Promise<string | null> {
    const row = await mainDb.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [key] });
    return (row.rows[0]?.value as string) ?? null;
}

export async function setConfig(key: string, value: string): Promise<void> {
    await mainDb.execute({
        sql: `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [key, value, Date.now()],
    });
}

export async function deleteConfig(key: string): Promise<void> {
    await mainDb.execute({ sql: "DELETE FROM config WHERE key = ?", args: [key] });
}

export async function getAllConfig(): Promise<Record<string, string>> {
    const rows = await mainDb.execute("SELECT key, value FROM config");
    const out: Record<string, string> = {};
    for (const r of rows.rows) out[r.key as string] = r.value as string;
    return out;
}

// ============================================================
// OWNER & USERS (using mainDb)
// ============================================================

export async function seedOwner(): Promise<number | null> {
    const envOwner = process.env.OWNER_ID;
    if (!envOwner) return null;
    const ownerId = Number(envOwner);
    if (isNaN(ownerId)) return null;
    
    await mainDb.execute({
        sql: `INSERT INTO owner (id, user_id, updated_at) VALUES (1, ?, ?)
              ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, updated_at = excluded.updated_at`,
        args: [ownerId, Date.now()],
    });
    await addAllowedUser(ownerId, undefined, ownerId);
    return ownerId;
}

export async function getOwner(): Promise<number | null> {
    const row = await mainDb.execute({ sql: "SELECT user_id FROM owner WHERE id = 1" });
    return row.rows.length > 0 ? (row.rows[0].user_id as number) : null;
}

export async function isOwner(userId: number): Promise<boolean> {
    return (await getOwner()) === userId;
}

export async function addAllowedUser(userId: number, username: string | undefined, addedBy: number): Promise<boolean> {
    try {
        await mainDb.execute({
            sql: `INSERT INTO allowed_users (user_id, username, added_by, added_at) VALUES (?, ?, ?, ?)`,
            args: [userId, username ?? null, addedBy, Date.now()],
        });
        return true;
    } catch { return false; }
}

export async function removeAllowedUser(userId: number): Promise<boolean> {
    const res = await mainDb.execute({ sql: "DELETE FROM allowed_users WHERE user_id = ?", args: [userId] });
    return (res.rowsAffected ?? 0) > 0;
}

export async function isAllowedUser(userId: number): Promise<boolean> {
    if (await isOwner(userId)) return true;
    const row = await mainDb.execute({ sql: "SELECT 1 FROM allowed_users WHERE user_id = ?", args: [userId] });
    return row.rows.length > 0;
}

export async function listAllowedUsers(): Promise<{ user_id: number; username: string | null; added_at: number }[]> {
    const rows = await mainDb.execute("SELECT user_id, username, added_at FROM allowed_users ORDER BY added_at ASC");
    return rows.rows.map((r) => ({
        user_id: r.user_id as number,
        username: r.username as string | null,
        added_at: r.added_at as number,
    }));
}

// ============================================================
// HISTORY (using mainDb)
// ============================================================

export interface Message {
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    tool_calls?: any[];
    tool_call_id?: string;
    name?: string;
}

export async function getHistory(userId: number): Promise<Message[]> {
    const rows = await mainDb.execute({
        sql: "SELECT * FROM history WHERE user_id = ? ORDER BY timestamp ASC",
        args: [userId],
    });
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
    await mainDb.execute({
        sql: `INSERT INTO history (user_id, role, content, tool_calls, tool_call_id, name, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
            userId, msg.role, msg.content ?? null,
            msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
            msg.tool_call_id ?? null, msg.name ?? null, Date.now(),
        ],
    });
}

export async function clearHistory(userId: number): Promise<void> {
    await mainDb.execute({ sql: "DELETE FROM history WHERE user_id = ?", args: [userId] });
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

// ============================================================
// COMMANDS (using commandsDb)
// ============================================================

export interface StoredCommand {
    name: string;
    description: string;
    code: string;
    owner_only: number;
    enabled: number;
    created_by: number;
    created_at: number;
    updated_at: number;
}

export async function getCommand(name: string): Promise<StoredCommand | null> {
    const row = await commandsDb.execute({
        sql: "SELECT * FROM commands WHERE name = ?",
        args: [name.replace(/^\//, "")],
    });
    if (row.rows.length === 0) return null;
    const r = row.rows[0];
    return {
        name: r.name as string,
        description: r.description as string,
        code: r.code as string,
        owner_only: r.owner_only as number,
        enabled: r.enabled as number,
        created_by: r.created_by as number,
        created_at: r.created_at as number,
        updated_at: r.updated_at as number,
    };
}

export async function saveCommand(
    name: string, code: string, description: string,
    ownerOnly: boolean, createdBy: number
): Promise<void> {
    const now = Date.now();
    await commandsDb.execute({
        sql: `INSERT INTO commands (name, description, code, owner_only, enabled, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET
                code = excluded.code, description = excluded.description,
                owner_only = excluded.owner_only, updated_at = excluded.updated_at`,
        args: [name.replace(/^\//, ""), description, code, ownerOnly ? 1 : 0, createdBy, now, now],
    });
}

export async function updateCommandDescription(name: string, description: string): Promise<boolean> {
    const res = await commandsDb.execute({
        sql: `UPDATE commands SET description = ?, updated_at = ? WHERE name = ?`,
        args: [description, Date.now(), name.replace(/^\//, "")],
    });
    return (res.rowsAffected ?? 0) > 0;
}

export async function deleteCommand(name: string): Promise<boolean> {
    const res = await commandsDb.execute({
        sql: "DELETE FROM commands WHERE name = ?",
        args: [name.replace(/^\//, "")],
    });
    return (res.rowsAffected ?? 0) > 0;
}

export async function toggleCommand(name: string): Promise<{ enabled: boolean; found: boolean }> {
    const cmd = await getCommand(name);
    if (!cmd) return { enabled: false, found: false };
    const newEnabled = cmd.enabled === 1 ? 0 : 1;
    await commandsDb.execute({
        sql: `UPDATE commands SET enabled = ?, updated_at = ? WHERE name = ?`,
        args: [newEnabled, Date.now(), name.replace(/^\//, "")],
    });
    return { enabled: newEnabled === 1, found: true };
}

export async function listCommands(): Promise<StoredCommand[]> {
    const rows = await commandsDb.execute("SELECT * FROM commands ORDER BY name ASC");
    return rows.rows.map((r) => ({
        name: r.name as string,
        description: r.description as string,
        code: r.code as string,
        owner_only: r.owner_only as number,
        enabled: r.enabled as number,
        created_by: r.created_by as number,
        created_at: r.created_at as number,
        updated_at: r.updated_at as number,
    }));
}
