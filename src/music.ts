import { Innertube } from "youtubei.js";
import { InlineKeyboard } from "grammy";
import { spawn } from "bun";
import { getConfig } from "./db";
import { createHash } from "crypto";
let yt: InstanceType<typeof Innertube> | null = null;

async function getYT() {
    if (!yt) {
        yt = await Innertube.create({
            generate_session_locally: true,
        });
    }
    return yt;
}

// Cache for the written cookies file (avoid rewriting on every download)
let cachedCookiesFile: { hash: string; path: string } | null = null;

/**
 * Read the raw cookie content from Turso config.
 */
async function getCookiesContent(): Promise<string | null> {
    const content = await getConfig("youtube_cookies");
    if (!content || content.trim().length === 0) return null;
    return content;
}

/**
 * Write cookie content to a temp file (yt-dlp requires a file path).
 * Caches the file so we only rewrite when content changes.
 */
async function prepareCookiesFile(): Promise<string | null> {
    const content = await getCookiesContent();
    if (!content) return null;

    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    // Reuse cached file if content unchanged
    if (
        cachedCookiesFile &&
        cachedCookiesFile.hash === hash &&
        await Bun.file(cachedCookiesFile.path).exists()
    ) {
        return cachedCookiesFile.path;
    }

    const path = `/tmp/yt_cookies_${hash}.txt`;
    await Bun.write(path, content);
    cachedCookiesFile = { hash, path };
    console.log(`[Music] 🍪 Cookies written to ${path} (${content.length} chars)`);
    return path;
}
interface MusicState {
    queue: string[];
    currentIndex: number;
    isPlaying: boolean;
    isRepeat: boolean;
    isShuffle: boolean;
    favorites: string[];
    playlist: string[];
}

const userMusicState = new Map<number, MusicState>();

function getMusicState(userId: number): MusicState {
    if (!userMusicState.has(userId)) {
        userMusicState.set(userId, {
            queue: [], currentIndex: 0, isPlaying: false,
            isRepeat: false, isShuffle: false, favorites: [], playlist: [],
        });
    }
    return userMusicState.get(userId)!;
}

function createProgressBar(current: number, total: number, width: number = 12): string {
    if (total <= 0) return "▱".repeat(width);
    const progress = Math.min(Math.floor((current / total) * width), width);
    return `${"▰".repeat(progress)}●${"▱".repeat(Math.max(width - progress - 1, 0))}`;
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function musicKeyboard(videoId: string) {
    return new InlineKeyboard()
        .text("⏮", `music:prev:${videoId}`).text("⏯", `music:play:${videoId}`).text("⏭", `music:next:${videoId}`).row()
        .text("🔀 Shuffle", `music:shuffle:${videoId}`).text("🔁 Repeat", `music:repeat:${videoId}`).row()
        .text("❤️ Favorite", `music:fav:${videoId}`).text("➕ Playlist", `music:playlist:${videoId}`).row()
        .text("🎤 Artist", `music:artist:${videoId}`).text("💿 Album", `music:album:${videoId}`).row()
        .text("🔍 Search Again", "music:search");
}

// ============================================================
// DOWNLOAD METHOD 1: youtubei.js with VALID client names
// ============================================================
async function downloadWithYoutubeiJS(videoId: string, outputPath: string): Promise<boolean> {
    const yt = await getYT();
    // Only use clients that exist in youtubei.js v11+
    const clients = ["ANDROID", "YTMUSIC", "IOS", "TV", "WEB"] as const;

    for (const client of clients) {
        try {
            console.log(`[Music] youtubei.js trying client: ${client}`);
            const stream = await yt.download(videoId, {
                type: "audio",
                quality: "bestefficiency",
                client: client as any,
            });

            const writer = Bun.file(outputPath).writer();
            let bytesWritten = 0;
            for await (const chunk of stream) {
                writer.write(chunk);
                bytesWritten += chunk.length;
            }
            await writer.end();

            if (bytesWritten > 10000) {
                console.log(`[Music] ✓ youtubei.js (${client}) got ${bytesWritten} bytes`);
                return true;
            }
        } catch (err: any) {
            console.warn(`[Music] youtubei.js ${client} failed: ${err.message}`);
        }
    }
    return false;
}

// ============================================================
// DOWNLOAD METHOD 2: yt-dlp with anti-bot player clients
// ============================================================
async function runYtDlp(videoId: string, outputPath: string, extraArgs: string[] = []): Promise<boolean> {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const baseArgs = [
        "yt-dlp",
        "--extract-audio",
        "--audio-format", "mp3",
        "--audio-quality", "0",
        "--no-playlist",
        "--no-warnings",
        "-o", outputPath.replace(/\.mp3$/, ".%(ext)s"),
        ...extraArgs,
        url,
    ];

    // Add cookies if the file exists
        // Write cookies from DB to temp file (if configured)
    const cookiesPath = await prepareCookiesFile();
    if (cookiesPath) {
        baseArgs.splice(1, 0, "--cookies", cookiesPath);
        console.log(`[Music] 🍪 yt-dlp using cookies from Turso DB`);
    }

    try {
        const proc = spawn(baseArgs, { stdout: "pipe", stderr: "pipe" });
        const [, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            console.warn(`[Music] yt-dlp failed: ${stderr.split("\n").find(l => l.includes("ERROR")) || stderr.slice(0, 200)}`);
            return false;
        }

        // yt-dlp outputs with its own extension; normalize to .mp3
        for (const ext of ["mp3", "m4a", "opus", "webm"]) {
            const altPath = outputPath.replace(/\.mp3$/, `.${ext}`);
            if (await Bun.file(altPath).exists()) {
                if (altPath !== outputPath) {
                    await Bun.write(outputPath, Bun.file(altPath));
                    await Bun.file(altPath).delete();
                }
                const size = Bun.file(outputPath).size;
                console.log(`[Music] ✓ yt-dlp got ${size} bytes`);
                return size > 10000;
            }
        }
        return false;
    } catch (err: any) {
        console.warn(`[Music] yt-dlp error: ${err.message}`);
        return false;
    }
}

async function downloadWithYtDlp(videoId: string, outputPath: string): Promise<boolean> {
    // Try different player clients to bypass bot detection
    const strategies: string[][] = [
        [], // default
        ["--extractor-args", "youtube:player_client=android"],
        ["--extractor-args", "youtube:player_client=tv"],
        ["--extractor-args", "youtube:player_client=mweb"],
        ["--extractor-args", "youtube:player_client=web_safari"],
    ];

    for (const args of strategies) {
        const label = args.length ? args[args.length - 1] : "default";
        console.log(`[Music] yt-dlp trying player_client: ${label}`);
        if (await runYtDlp(videoId, outputPath, args)) return true;
    }
    return false;
}

// ============================================================
// DOWNLOAD METHOD 3: Invidious / Piped instances fallback
// ============================================================
const INVIDIOUS_INSTANCES = [
    "https://inv.nadeko.net",
    "https://invidious.f5.si",
    "https://iv.melmac.space",
    "https://invidious.privacyredirect.com",
];

const PIPED_INSTANCES = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://api.piped.private.coffee",
];

async function downloadFromDirectUrl(url: string, outputPath: string): Promise<boolean> {
    try {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok || !res.body) return false;

        const writer = Bun.file(outputPath).writer();
        let bytesWritten = 0;
        for await (const chunk of res.body as any) {
            writer.write(chunk);
            bytesWritten += chunk.length;
            if (bytesWritten > 50 * 1024 * 1024) break; // 50MB safety cap
        }
        await writer.end();

        console.log(`[Music] ✓ Direct URL got ${bytesWritten} bytes`);
        return bytesWritten > 10000;
    } catch (err: any) {
        console.warn(`[Music] Direct URL failed: ${err.message}`);
        return false;
    }
}

async function downloadWithInvidious(videoId: string, outputPath: string): Promise<boolean> {
    // Try Piped first
    for (const instance of PIPED_INSTANCES) {
        try {
            console.log(`[Music] Trying Piped: ${instance}`);
            const res = await fetch(`${instance}/streams/${videoId}`);
            if (!res.ok) continue;
            const data = await res.json() as any;
            const audio = data.audioStreams?.find((s: any) => s.url);
            if (audio?.url) {
                if (await downloadFromDirectUrl(audio.url, outputPath)) return true;
            }
        } catch (err: any) {
            console.warn(`[Music] Piped ${instance} failed: ${err.message}`);
        }
    }

    // Then Invidious
    for (const instance of INVIDIOUS_INSTANCES) {
        try {
            console.log(`[Music] Trying Invidious: ${instance}`);
            const res = await fetch(`${instance}/api/v1/videos/${videoId}`);
            if (!res.ok) continue;
            const data = await res.json() as any;
            const audio = data.adaptiveFormats?.find((f: any) => f.type?.startsWith("audio") && f.url);
            if (audio?.url) {
                if (await downloadFromDirectUrl(audio.url, outputPath)) return true;
            }
        } catch (err: any) {
            console.warn(`[Music] Invidious ${instance} failed: ${err.message}`);
        }
    }
    return false;
}

// ============================================================
// MAIN DOWNLOAD ORCHESTRATOR
// ============================================================
async function downloadAudio(videoId: string, outputPath: string): Promise<boolean> {
    // 1. yt-dlp first (best success rate with player_client tricks)
    if (await downloadWithYtDlp(videoId, outputPath)) return true;

    // 2. youtubei.js with valid clients
    if (await downloadWithYoutubeiJS(videoId, outputPath)) return true;

    // 3. Invidious / Piped mirror instances
    if (await downloadWithInvidious(videoId, outputPath)) return true;

    console.error(`[Music] ✗ All download methods failed for ${videoId}`);
    return false;
}

// ============================================================
// SEARCH & METADATA HELPERS
// ============================================================
function findFirstSong(searchResult: any): any | null {
    if (searchResult?.contents && Array.isArray(searchResult.contents)) {
        for (const shelf of searchResult.contents) {
            if (shelf.type === "MusicShelf") {
                const title = shelf.title?.text?.toLowerCase() || "";
                if (title.includes("song") && shelf.contents?.length > 0) {
                    console.log(`[Music] Found "Songs" shelf with ${shelf.contents.length} items`);
                    return shelf.contents[0];
                }
            }
        }
        for (const shelf of searchResult.contents) {
            if (shelf.type === "MusicShelf" && shelf.contents?.length > 0) return shelf.contents[0];
            if (shelf.type === "MusicResponsiveListItem") return shelf;
        }
    }
    if (searchResult?.type === "MusicShelf" && searchResult.contents?.length > 0) {
        return searchResult.contents[0];
    }
    return null;
}

function extractVideoId(item: any): string | null {
    if (!item) return null;
    if (item.id) return String(item.id);
    if (item.video_id) return String(item.video_id);
    if (item.videoId) return String(item.videoId);
    try {
        const nav = item.overlay?.music_item_thumbnail_overlay_renderer?.content
            ?.music_play_button_renderer?.play_navigation_endpoint?.watch_endpoint?.video_id;
        if (nav) return String(nav);
    } catch {}
    return null;
}

function extractTitle(item: any): string {
    if (!item) return "Unknown Title";
    if (typeof item.title === "string") return item.title;
    if (item.title?.text) return item.title.text;
    try {
        const col = item.flex_columns?.[0];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}
    return "Unknown Title";
}

function extractArtists(item: any): string {
    if (!item) return "Unknown Artist";
    if (Array.isArray(item.artists)) return item.artists.map((a: any) => a.name || String(a)).join(", ");
    if (item.artists?.text) return item.artists.text;
    try {
        const col = item.flex_columns?.[1];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}
    return "Unknown Artist";
}

function extractAlbum(item: any): string {
    if (item?.album?.name) return item.album.name;
    if (item?.album?.text) return item.album.text;
    try {
        const col = item.flex_columns?.[2];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}
    return "Single";
}

function extractThumbnail(item: any): string {
    if (item?.thumbnail?.length) return item.thumbnail[0].url;
    if (item?.thumbnails?.length) return item.thumbnails[0].url;
    try {
        if (item.thumbnail_renderer?.thumbnails?.length) return item.thumbnail_renderer.thumbnails[0].url;
    } catch {}
    return "";
}

function escapeMd(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, "\\$&");
}

export async function searchAndPlay(query: string, userId: number): Promise<{
    caption: string;
    photo: string;
    keyboard: InlineKeyboard;
    audioPath?: string;
    videoId: string;
} | null> {
    const yt = await getYT();
    console.log(`[Music] Searching for: ${query}`);

    const search = await yt.music.search(query, { type: "song" });
    if (!search) return null;

    const song = findFirstSong(search);
    if (!song) return null;

    const videoId = extractVideoId(song);
    if (!videoId) {
        console.error("[Music] Could not extract video ID");
        return null;
    }
    console.log(`[Music] ✓ Found video ID: ${videoId}`);

    const state = getMusicState(userId);
    state.queue.push(videoId);
    state.currentIndex = state.queue.length - 1;
    state.isPlaying = true;

    const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;
    const downloadSuccess = await downloadAudio(videoId, audioPath);

    let duration = 180;
    try {
        const info = await yt.getInfo(videoId);
        duration = info.basic_info?.duration || 180;
    } catch {}

    const title = extractTitle(song);
    const artists = extractArtists(song);
    const album = extractAlbum(song);
    const thumbnail = extractThumbnail(song);

    const caption = `🎵 **Now Playing**

**${escapeMd(title)}**
${escapeMd(artists)}

💿 ${escapeMd(album)}

⏱ ${formatDuration(0)} / ${formatDuration(duration)}

${createProgressBar(0, duration, 15)}

🔊 High Quality AAC${downloadSuccess ? "" : "\n⚠️ Stream blocked on this server — try cookies setup"}`;

    return {
        caption,
        photo: thumbnail,
        keyboard: musicKeyboard(videoId),
        audioPath: downloadSuccess && await Bun.file(audioPath).exists() ? audioPath : undefined,
        videoId,
    };
}

export async function handleMusicAction(action: string, videoId: string, userId: number): Promise<string> {
    const state = getMusicState(userId);
    switch (action) {
        case "play":
            state.isPlaying = !state.isPlaying;
            return state.isPlaying ? "▶️ Resumed" : "⏸️ Paused";
        case "prev":
            if (state.currentIndex > 0) { state.currentIndex--; return "⏮ Previous track"; }
            return "⏮ No previous track";
        case "next":
            if (state.currentIndex < state.queue.length - 1) { state.currentIndex++; return "⏭ Next track"; }
            if (state.isRepeat) { state.currentIndex = 0; return "🔁 Repeating from start"; }
            return "⏭ End of queue";
        case "shuffle":
            state.isShuffle = !state.isShuffle;
            if (state.isShuffle && state.queue.length > 1) {
                const remaining = state.queue.slice(state.currentIndex + 1);
                for (let i = remaining.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
                }
                state.queue = [...state.queue.slice(0, state.currentIndex + 1), ...remaining];
            }
            return state.isShuffle ? "🔀 Shuffle enabled" : "🔀 Shuffle disabled";
        case "repeat":
            state.isRepeat = !state.isRepeat;
            return state.isRepeat ? "🔁 Repeat enabled" : "🔁 Repeat disabled";
        case "fav":
            if (!state.favorites.includes(videoId)) { state.favorites.push(videoId); return "❤️ Added to favorites"; }
            state.favorites = state.favorites.filter(id => id !== videoId);
            return "💔 Removed from favorites";
        case "playlist":
            if (!state.playlist.includes(videoId)) { state.playlist.push(videoId); return "➕ Added to playlist"; }
            return "ℹ️ Already in playlist";
        case "artist": return "🎤 Artist info coming soon";
        case "album": return "💿 Album info coming soon";
        case "search": return "🔍 Send a new search query";
        default: return "Unknown action";
    }
}
