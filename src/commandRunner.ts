import { Context } from "grammy";
import * as db from "./db";

export interface CommandAPI {
    ctx: Context;
    db: {
        getConfig: typeof db.getConfig;
        setConfig: typeof db.setConfig;
        deleteConfig: typeof db.deleteConfig;
        getAllConfig: typeof db.getAllConfig;
        addAllowedUser: typeof db.addAllowedUser;
        addAllowedGroup: typeof db.addAllowedGroup;  // ← NEW
        removeAllowedUser: typeof db.removeAllowedUser;
        listAllowedUsers: typeof db.listAllowedUsers;
        getEntry: typeof db.getEntry;                  // ← NEW
        getCommand: typeof db.getCommand;
        saveCommand: typeof db.saveCommand;
        deleteCommand: typeof db.deleteCommand;
        listCommands: typeof db.listCommands;
    };
    auth: {
        isOwner: typeof db.isOwner;
        isAllowedUser: typeof db.isAllowedUser;
        getOwner: typeof db.getOwner;
    };
    utils: { fetch: typeof fetch; Bun: typeof Bun };
}

export async function executeCommandCode(code: string, ctx: Context): Promise<void> {
    let jsCode = code;
    try {
        const transpiler = new Bun.Transpiler({ loader: "ts" });
        jsCode = transpiler.transformSync(code);
    } catch { jsCode = code; }

       const api: CommandAPI = {
        ctx,
        db: {
            getConfig: db.getConfig, setConfig: db.setConfig, deleteConfig: db.deleteConfig,
            getAllConfig: db.getAllConfig, addAllowedUser: db.addAllowedUser,
            addAllowedGroup: db.addAllowedGroup,          // ← NEW
            removeAllowedUser: db.removeAllowedUser, 
            listAllowedUsers: db.listAllowedUsers,
            getEntry: db.getEntry,                         // ← NEW
            getCommand: db.getCommand, saveCommand: db.saveCommand,
            deleteCommand: db.deleteCommand, listCommands: db.listCommands,
        },
        auth: { isOwner: db.isOwner, isAllowedUser: db.isAllowedUser, getOwner: db.getOwner },
        utils: { fetch, Bun },
    };
        const wrappedCode = `
        const { ctx, db, auth, utils } = api;
        const { getConfig, setConfig, deleteConfig, getAllConfig, addAllowedUser, addAllowedGroup, removeAllowedUser, listAllowedUsers, getEntry, getCommand, saveCommand, deleteCommand, listCommands } = db;
        const { isOwner, isAllowedUser, getOwner } = auth;
        const { fetch, Bun } = utils;
        ${jsCode}
    `;

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
    const fn = new AsyncFunction("api", wrappedCode);
    await fn(api);
}
