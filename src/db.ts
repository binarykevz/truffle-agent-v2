import { createClient, type Client } from "@libsql/client";
import { configCache, commandCache } from "./cache";

// ============================================================
// TURSO DATABASES
// ============================================================

const mainUrl = process.env.TURSO_DATABASE_URL;
if (!mainUrl) throw new Error("TURSO_DATABASE_URL is required in .env");
export const mainDb: Client = createClient({
    url: mainUrl,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

const commandsUrl = process.env.TURSO_COMMANDS_DATABASE_URL;
if (!commandsUrl) throw new Error("TURSO_COMMANDS_DATABASE_URL is required in .env");
export const commandsDb: Client = createClient({
    url: commandsUrl,
    authToken: process.env.TURSO_COMMANDS_AUTH_TOKEN || undefined,
});

const memoryUrl = process.env.TURSO_MEMORY_URL;
export const memoryDb: Client = memoryUrl
    ? createClient({ url: memoryUrl, authToken: process.env.TURSO_MEMORY_TOKEN || undefined })
    : mainDb;

// ============================================================
// SCHEMA INITIALIZATION
// ============================================================

export async function initMainDB() {
    await mainDb.batch([
        `CREATE TABLE IF NOT EXISTS allowed_users (
            user_id INTEGER PRIMARY KEY,
            type TEXT NOT NULL DEFAULT 'user',
            username TEXT,
            title TEXT,
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

    // Migration: add 'type' and 'title' columns if they don't exist (for existing DBs)
    try {
        await mainDb.execute({ sql: "ALTER TABLE allowed_users ADD COLUMN type TEXT NOT NULL DEFAULT 'user'", args: [] });
    } catch {}
    try {
        await mainDb.execute({ sql: "ALTER TABLE allowed_users ADD COLUMN title TEXT", args: [] });
    } catch {}
    
    // Backfill: set type='user' for existing rows without type
    await mainDb.execute({ 
        sql: "UPDATE allowed_users SET type = 'user' WHERE type IS NULL OR type = ''", 
        args: [] 
    });
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
// CONFIG (with cache)
// ============================================================

export async function getConfig(key: string): Promise<string | null> {
    const cached = configCache.get(key);
    if (cached !== undefined) return cached;

    const row = await mainDb.execute({ sql: "SELECT value FROM config WHERE key = ?", args: [key] });
    const value = (row.rows[0]?.value as string) ?? null;
    if (value !== null) configCache.set(key, value);
    return value;
}

export async function setConfig(key: string, value: string): Promise<void> {
    await mainDb.execute({
        sql: `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        args: [key, value, Date.now()],
    });
    configCache.set(key, value);
}

export async function deleteConfig(key: string): Promise<void> {
    await mainDb.execute({ sql: "DELETE FROM config WHERE key = ?", args: [key] });
    configCache.delete(key);
}

export async function getAllConfig(): Promise<Record<string, string>> {
    const rows = await mainDb.execute({ sql: "SELECT key, value FROM config", args: [] });
    const out: Record<string, string> = {};
    for (const r of rows.rows) out[r.key as string] = r.value as string;
    return out;
}

// ============================================================
// ALLOWED USERS & GROUPS
// ============================================================

export async function addAllowedUser(
    userId: number, 
    username: string | undefined, 
    addedBy: number
): Promise<boolean> {
    try {
        await mainDb.execute({
            sql: `INSERT INTO allowed_users (user_id, type, username, title, added_by, added_at) 
                  VALUES (?, 'user', ?, NULL, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET 
                    type = 'user',
                    username = COALESCE(excluded.username, allowed_users.username),
                    added_by = excluded.added_by`,
            args: [userId, username ?? null, addedBy, Date.now()],
        });
        return true;
    } catch (e) { 
        console.error("addAllowedUser error:", e);
        return false; 
    }
}

export async function addAllowedGroup(
    groupId: number,
    title: string | undefined,
    username: string | undefined,
    addedBy: number
): Promise<boolean> {
    try {
        await mainDb.execute({
            sql: `INSERT INTO allowed_users (user_id, type, username, title, added_by, added_at) 
                  VALUES (?, 'group', ?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET 
                    type = 'group',
                    title = COALESCE(excluded.title, allowed_users.title),
                    username = COALESCE(excluded.username, allowed_users.username),
                    added_by = excluded.added_by`,
            args: [groupId, username ?? null, title ?? null, addedBy, Date.now()],
        });
        return true;
    } catch (e) { 
        console.error("addAllowedGroup error:", e);
        return false; 
    }
}

export async function removeAllowedUser(userId: number): Promise<boolean> {
    const res = await mainDb.execute({ 
        sql: "DELETE FROM allowed_users WHERE user_id = ?", 
        args: [userId] 
    });
    return (res.rowsAffected ?? 0) > 0;
}

/**
 * Check if a user is allowed.
 * - Owner is always allowed
 * - User is allowed if their ID is in allowed_users as type='user'
 * - User is allowed if the current chat (group) is in allowed_users as type='group'
 */
export async function isAllowedUser(userId: number, chatId?: number): Promise<boolean> {
    // Owner is always allowed
    if (await isOwner(userId)) return true;
    
    // Check if user is individually allowed
    const userRow = await mainDb.execute({ 
        sql: "SELECT 1 FROM allowed_users WHERE user_id = ? AND type = 'user'", 
        args: [userId] 
    });
    if (userRow.rows.length > 0) return true;
    
    // Check if the current chat (group) is allowed
    if (chatId && chatId < 0) {
        const groupRow = await mainDb.execute({ 
            sql: "SELECT 1 FROM allowed_users WHERE user_id = ? AND type = 'group'", 
            args: [chatId] 
        });
        if (groupRow.rows.length > 0) return true;
    }
    
    return false;
}

export async function listAllowedUsers(): Promise<{
    users: { user_id: number; username: string | null; added_at: number }[];
    groups: { chat_id: number; title: string | null; username: string | null; added_at: number }[];
}> {
    const rows = await mainDb.execute({ 
        sql: "SELECT user_id, type, username, title, added_at FROM allowed_users ORDER BY added_at ASC", 
        args: [] 
    });
    
    const users: any[] = [];
    const groups: any[] = [];
    
    for (const r of rows.rows) {
        const type = r.type as string;
        if (type === 'group') {
            groups.push({
                chat_id: r.user_id as number,
                title: r.title as string | null,
                username: r.username as string | null,
                added_at: r.added_at as number,
            });
        } else {
            users.push({
                user_id: r.user_id as number,
                username: r.username as string | null,
                added_at: r.added_at as number,
            });
        }
    }
    
    return { users, groups };
}

export async function getEntry(userId: number): Promise<{ type: string; username: string | null; title: string | null } | null> {
    const row = await mainDb.execute({ 
        sql: "SELECT type, username, title FROM allowed_users WHERE user_id = ?", 
        args: [userId] 
    });
    if (row.rows.length === 0) return null;
    const r = row.rows[0];
    return {
        type: r.type as string,
        username: r.username as string | null,
        title: r.title as string | null,
    };
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
// COMMANDS (with cache)
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
    const normalizedName = name.replace(/^\//, "");
    const cached = commandCache.get(normalizedName);
    if (cached !== undefined) return cached;

    const row = await commandsDb.execute({
        sql: "SELECT * FROM commands WHERE name = ?",
        args: [normalizedName],
    });
    if (row.rows.length === 0) {
        commandCache.set(normalizedName, null);
        return null;
    }
    const r = row.rows[0];
    const cmd: StoredCommand = {
        name: r.name as string,
        description: r.description as string,
        code: r.code as string,
        owner_only: r.owner_only as number,
        enabled: r.enabled as number,
        created_by: r.created_by as number,
        created_at: r.created_at as number,
        updated_at: r.updated_at as number,
    };
    commandCache.set(normalizedName, cmd);
    return cmd;
}

export async function saveCommand(
    name: string, code: string, description: string,
    ownerOnly: boolean, createdBy: number
): Promise<void> {
    const normalizedName = name.replace(/^\//, "");
    const now = Date.now();
    await commandsDb.execute({
        sql: `INSERT INTO commands (name, description, code, owner_only, enabled, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET
                code = excluded.code, description = excluded.description,
                owner_only = excluded.owner_only, updated_at = excluded.updated_at`,
        args: [normalizedName, description, code, ownerOnly ? 1 : 0, createdBy, now, now],
    });
    commandCache.delete(normalizedName);
}

export async function updateCommandDescription(name: string, description: string): Promise<boolean> {
    const normalizedName = name.replace(/^\//, "");
    const res = await commandsDb.execute({
        sql: `UPDATE commands SET description = ?, updated_at = ? WHERE name = ?`,
        args: [description, Date.now(), normalizedName],
    });
    if ((res.rowsAffected ?? 0) > 0) commandCache.delete(normalizedName);
    return (res.rowsAffected ?? 0) > 0;
}

export async function deleteCommand(name: string): Promise<boolean> {
    const normalizedName = name.replace(/^\//, "");
    const res = await commandsDb.execute({
        sql: "DELETE FROM commands WHERE name = ?",
        args: [normalizedName],
    });
    commandCache.delete(normalizedName);
    return (res.rowsAffected ?? 0) > 0;
}

export async function toggleCommand(name: string): Promise<{ enabled: boolean; found: boolean }> {
    const normalizedName = name.replace(/^\//, "");
    const cmd = await getCommand(normalizedName);
    if (!cmd) return { enabled: false, found: false };
    const newEnabled = cmd.enabled === 1 ? 0 : 1;
    await commandsDb.execute({
        sql: `UPDATE commands SET enabled = ?, updated_at = ? WHERE name = ?`,
        args: [newEnabled, Date.now(), normalizedName],
    });
    commandCache.delete(normalizedName);
    return { enabled: newEnabled === 1, found: true };
}

export async function listCommands(): Promise<StoredCommand[]> {
    const rows = await commandsDb.execute({
        sql: "SELECT * FROM commands ORDER BY name ASC",
        args: [],
    });
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
