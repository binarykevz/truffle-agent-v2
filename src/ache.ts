import { LRUCache } from "lru-cache";
import { createHash } from "crypto";

// LLM Response Cache
export const llmCache = new LRUCache<string, any>({
    max: 500,
    ttl: 1000 * 60 * 60 * 2,
    sizeCalculation: (value) => JSON.stringify(value).length,
    maxSize: 10 * 1024 * 1024,
});

// Command Lookup Cache
export const commandCache = new LRUCache<string, any>({
    max: 200,
    ttl: 1000 * 60 * 5,
});

// Config Cache
export const configCache = new LRUCache<string, string>({
    max: 100,
    ttl: 1000 * 60 * 2,
});

// File Conversion Cache
export const conversionCache = new LRUCache<string, string>({
    max: 100,
    ttl: 1000 * 60 * 60 * 24,
});

// User File Cache (for reply-to-file)
export interface CachedFile {
    messageId: number;
    filePath: string;
    fileName: string;
    ext: string;
    userId: number;
    timestamp: number;
}

export const userFileCache = new LRUCache<number, CachedFile[]>({
    max: 1000,
    ttl: 1000 * 60 * 60 * 24,
});

export function hashKey(...parts: any[]): string {
    const content = parts.map(p =>
        typeof p === "string" ? p : JSON.stringify(p)
    ).join("|");
    return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

export function getCacheStats() {
    return {
        llm: { size: llmCache.size, maxSize: llmCache.max },
        commands: { size: commandCache.size, maxSize: commandCache.max },
        config: { size: configCache.size, maxSize: configCache.max },
        conversion: { size: conversionCache.size, maxSize: conversionCache.max },
        userFiles: { size: userFileCache.size, maxSize: userFileCache.max },
    };
}

export function clearAllCaches() {
    llmCache.clear();
    commandCache.clear();
    configCache.clear();
    conversionCache.clear();
    userFileCache.clear();
}
