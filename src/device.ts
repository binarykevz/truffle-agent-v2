import { existsSync } from "fs";

export function isTermux(): boolean {
    return existsSync("/data/data/com.termux") || !!process.env.TERMUX_VERSION || process.platform === "android";
}

export const APP_REGISTRY: Record<string, { android: string; ios: string; web: string; package?: string }> = {
    whatsapp: { android: "whatsapp://", ios: "whatsapp://", web: "https://wa.me/", package: "com.whatsapp" },
    telegram: { android: "tg://", ios: "tg://", web: "https://t.me/", package: "org.telegram.messenger" },
    gmail: { android: "gmail://", ios: "googlegmail://", web: "https://mail.google.com", package: "com.google.android.gm" },
    youtube: { android: "vnd.youtube://", ios: "vnd.youtube://", web: "https://youtube.com", package: "com.google.android.youtube" },
    maps: { android: "geo:0,0", ios: "maps://", web: "https://maps.google.com", package: "com.google.android.apps.maps" },
    chrome: { android: "googlechrome://", ios: "googlechrome://", web: "https://google.com", package: "com.android.chrome" },
    instagram: { android: "instagram://", ios: "instagram://", web: "https://instagram.com", package: "com.instagram.android" },
    twitter: { android: "twitter://", ios: "twitter://", web: "https://twitter.com", package: "com.twitter.android" },
    facebook: { android: "fb://", ios: "fb://", web: "https://facebook.com", package: "com.facebook.katana" },
    spotify: { android: "spotify:", ios: "spotify:", web: "https://open.spotify.com", package: "com.spotify.music" },
    dialer: { android: "tel:", ios: "tel:", web: "" },
    sms: { android: "sms:", ios: "sms:", web: "" },
};

export async function launchOnTermux(appName: string, extra: string = ""): Promise<string> {
    const key = appName.toLowerCase();
    const app = APP_REGISTRY[key];
    if (app?.android) {
        const uri = app.android + extra;
        const proc = Bun.spawn(["am", "start", "-a", "android.intent.action.VIEW", "-d", uri], { stdout: "pipe", stderr: "pipe" });
        const err = await new Response(proc.stderr).text();
        await proc.exited;
        if (err.toLowerCase().includes("no activity found")) throw new Error(`No app on device can handle "${appName}"`);
        return `✅ Launched ${appName} on your device.`;
    }
    if (appName.includes(".")) {
        const proc = Bun.spawn(["monkey", "-p", appName, "-c", "android.intent.category.LAUNCHER", "1"], { stdout: "pipe", stderr: "pipe" });
        const output = await new Response(proc.stderr).text();
        await proc.exited;
        if (output.includes("no activities") || output.includes("Error")) throw new Error(`Package "${appName}" not found.`);
        return `✅ Launched package ${appName}.`;
    }
    throw new Error(`Unknown app "${appName}". Provide a known name or Android package name.`);
}

export async function listInstalledApps(): Promise<string[]> {
    const proc = Bun.spawn(["pm", "list", "packages", "-3"], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    return out.split("\n").map((line) => line.replace("package:", "").trim()).filter(Boolean).sort();
}

export function getKnownApps(): string[] { return Object.keys(APP_REGISTRY); }
