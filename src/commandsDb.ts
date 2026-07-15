import { createClient, type Client } from "@libsql/client";

const url = process.env.TURSO_COMMANDS_DATABASE_URL;
if (!url) throw new Error("TURSO_COMMANDS_DATABASE_URL is required in .env");

export const commandsDb: Client = createClient({
    url,
    authToken: process.env.TURSO_COMMANDS_AUTH_TOKEN || undefined,
});

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
    name: string,
    code: string,
    description: string,
    ownerOnly: boolean,
    createdBy: number
): Promise<void> {
    const now = Date.now();
    await commandsDb.execute({
        sql: `INSERT INTO commands (name, description, code, owner_only, enabled, created_by, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?, ?)
              ON CONFLICT(name) DO UPDATE SET
                code = excluded.code,
                description = excluded.description,
                owner_only = excluded.owner_only,
                updated_at = excluded.updated_at`,
        args: [name.replace(/^\//, ""), description, code, ownerOnly ? 1 : 0, createdBy, now, now],
    });
}

export async function updateCommandCode(name: string, code: string): Promise<boolean> {
    const res = await commandsDb.execute({
        sql: `UPDATE commands SET code = ?, updated_at = ? WHERE name = ?`,
        args: [code, Date.now(), name.replace(/^\//, "")],
    });
    return (res.rowsAffected ?? 0) > 0;
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
