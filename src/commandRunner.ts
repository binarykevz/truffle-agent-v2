import { Context } from "grammy";
import * as mainDb from "./db";
import * as cmdsDb from "./commandsDb";

export interface CommandAPI {
    ctx: Context;
    db: {
        getConfig: typeof mainDb.getConfig;
        setConfig: typeof mainDb.setConfig;
        deleteConfig: typeof mainDb.deleteConfig;
        getAllConfig: typeof mainDb.getAllConfig;
        addAllowedUser: typeof mainDb.addAllowedUser;
        removeAllowedUser: typeof mainDb.removeAllowedUser;
        listAllowedUsers: typeof mainDb.listAllowedUsers;
        getCommand: typeof cmdsDb.getCommand;
        saveCommand: typeof cmdsDb.saveCommand;
        deleteCommand: typeof cmdsDb.deleteCommand;
        listCommands: typeof cmdsDb.listCommands;
    };
    auth: {
        isOwner: typeof mainDb.isOwner;
        isAllowedUser: typeof mainDb.isAllowedUser;
        getOwner: typeof mainDb.getOwner;
    };
    utils: {
        fetch: typeof fetch;
        Bun: typeof Bun;
    };
}

export async function executeCommandCode(code: string, ctx: Context): Promise<void> {
    let jsCode = code;
    try {
        const transpiler = new Bun.Transpiler({ loader: "ts" });
        jsCode = transpiler.transformSync(code);
    } catch {
        jsCode = code;
    }

    const api: CommandAPI = {
        ctx,
        db: {
            getConfig: mainDb.getConfig,
            setConfig: mainDb.setConfig,
            deleteConfig: mainDb.deleteConfig,
            getAllConfig: mainDb.getAllConfig,
            addAllowedUser: mainDb.addAllowedUser,
            removeAllowedUser: mainDb.removeAllowedUser,
            listAllowedUsers: mainDb.listAllowedUsers,
            getCommand: cmdsDb.getCommand,
            saveCommand: cmdsDb.saveCommand,
            deleteCommand: cmdsDb.deleteCommand,
            listCommands: cmdsDb.listCommands,
        },
        auth: {
            isOwner: mainDb.isOwner,
            isAllowedUser: mainDb.isAllowedUser,
            getOwner: mainDb.getOwner,
        },
        utils: { fetch, Bun },
    };

    const wrappedCode = `
        const { ctx, db, auth, utils } = api;
        const { getConfig, setConfig, deleteConfig, getAllConfig, addAllowedUser, removeAllowedUser, listAllowedUsers, getCommand, saveCommand, deleteCommand, listCommands } = db;
        const { isOwner, isAllowedUser, getOwner } = auth;
        const { fetch, Bun } = utils;
        ${jsCode}
    `;

    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as any;
    const fn = new AsyncFunction("api", wrappedCode);
    await fn(api);
}
