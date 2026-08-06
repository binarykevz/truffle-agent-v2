import { InlineKeyboard } from "grammy";

// ============================================================
// CUSTOM TRUFFLE-MUSIC API
// ============================================================
const API_BASE = "https://truffle-music.onrender.com";

// ============================================================
// PLAYER STATE (per user)
// ============================================================
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

// ============================================================
// UI HELPERS
// ============================================================
function createProgressBar(current: number, total: number, width: number = 15): string {
    if (total <= 0) return "▱".repeat(width);
    const progress = Math.min(Math.floor((current / total) * width), width);
    return `${"▰".repeat(progress)}●${"▱".repeat(Math.max(width - progress - 1, 0))}`;
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseDurationToSeconds(d: any): number {
    if (typeof d === "number") return d;
    if (typeof d === "string") {
        const parts = d.split(":").map(Number);
        if (parts.length === 2 && !parts.some(isNaN)) return parts[0] * 60 + parts[1];
        if (parts.length === 3 && !parts.some(isNaN)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        const num = parseInt(d);
        if (!isNaN(num)) return num;
    }
    return 180;
}

function escapeMd(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, "\\$&");
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
// FIELD EXTRACTION (handles different API response shapes)
// ============================================================
function getField(item: any, keys: string[]): any {
    for (const k of keys) {
        if (item?.[k] !== undefined && item?.[k] !== null) return item[k];
    }
    return undefined;
}

function toResults(data: any): any[] {
    if (Array.isArray(data)) return data;
    for (const key of ["results", "data", "items", "songs", "result", "videos"]) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    return [];
}

/**
 * Convert a thumbnail URL to its HD (_hd) variant.
 * e.g. .../hqdefault.jpg -> .../hqdefault_hd.jpg
 */
function toHDThumbnail(url: string): string {
    if (!url) return url;
    if (url.includes("_hd")) return url;
    return url.replace(/(\.[a-zA-Z0-9]+)$/, "_hd$1");
}

/**
 * Extract thumbnail string from various shapes, then upgrade to _hd.
 */
function extractThumbnail(item: any, videoId: string): string {
    let raw = getField(item, ["thumbnail", "thumbnails", "image", "img", "cover", "thumb"]);

    // If it's an array of {url,...}, pick the largest/last
    if (Array.isArray(raw)) {
        raw = raw[raw.length - 1]?.url || raw[0]?.url || null;
    } else if (raw && typeof raw === "object") {
        raw = raw.url || null;
    }

    if (typeof raw === "string" && raw) {
        return toHDThumbnail(raw);
    }

    // Fallback to a known-good YouTube HD thumbnail
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ============================================================
// SEARCH (uses /search?q=)
// ============================================================
export interface MusicResult {
    videoId: string;
    title: string;
    description: string;
    duration: string;
    durationSec: number;
    thumbnail: string;
}

async function searchMusic(query: string): Promise<MusicResult | null> {
    const url = `${API_BASE}/search?q=${encodeURIComponent(query)}`;
    console.log(`[Music] Searching: ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
        console.error(`[Music] Search failed: HTTP ${res.status}`);
        return null;
    }

    const data = await res.json();
    const results = toResults(data);

    if (results.length === 0) {
        console.log("[Music] No results");
        return null;
    }

    const item = results[0];
    console.log(`[Music] Raw first result keys: ${Object.keys(item).join(", ")}`);

    const videoId = String(getField(item, ["video_id", "videoId", "id", "videoID", "videoID"]));
    if (!videoId) {
        console.error("[Music] Could not extract video_id");
        return null;
    }

    const title = String(getField(item, ["title", "name", "song"]) || "Unknown Title");
    const description = String(getField(item, ["description", "desc", "author", "channel", "artist"]) || "");
    const durationRaw = getField(item, ["duration", "length", "duration_text", "durationText"]);
    const durationSec = parseDurationToSeconds(durationRaw);
    const duration = typeof durationRaw === "string" && durationRaw.includes(":")
        ? durationRaw
        : formatDuration(durationSec);
    const thumbnail = extractThumbnail(item, videoId);

    console.log(`[Music] ✓ Found: ${title} (${videoId})`);

    return { videoId, title, description, duration, durationSec, thumbnail };
}

// ============================================================
// DOWNLOAD MP3 (uses /dl?id=)
// ============================================================
async function downloadMp3(videoId: string, outputPath: string): Promise<boolean> {
    const url = `${API_BASE}/dl?id=${encodeURIComponent(videoId)}`;
    console.log(`[Music] Downloading: ${url}`);

    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error(`[Music] Download failed: HTTP ${res.status}`);
            return false;
        }

        const contentType = res.headers.get("content-type") || "";

        // Case 1: API returns JSON with a download URL
        if (contentType.includes("application/json")) {
            const data = await res.json();
            const dlUrl = getField(data, ["url", "download_url", "downloadUrl", "link", "audio", "file", "src", "path"]);
            if (!dlUrl) {
                console.error("[Music] JSON response has no download URL. Keys:", Object.keys(data).join(", "));
                return false;
            }
            console.log(`[Music] Got download URL from JSON`);
            const fileRes = await fetch(dlUrl);
            if (!fileRes.ok) return false;
            const buf = await fileRes.arrayBuffer();
            await Bun.write(outputPath, buf);
            const size = Bun.file(outputPath).size;
            console.log(`[Music] ✓ Downloaded ${size} bytes`);
            return size > 10000;
        }

        // Case 2: API returns the MP3 binary directly
        const buf = await res.arrayBuffer();
        await Bun.write(outputPath, buf);
        const size = Bun.file(outputPath).size;
        console.log(`[Music] ✓ Downloaded ${size} bytes (binary)`);
        return size > 10000;
    } catch (err: any) {
        console.error("[Music] Download error:", err.message);
        return false;
    }
}

// ============================================================
// SEARCH & PLAY (main entry)
// ============================================================
export async function searchAndPlay(query: string, userId: number): Promise<{
    caption: string;
    photo: string;
    keyboard: InlineKeyboard;
    audioPath?: string;
    videoId: string;
} | null> {
    try {
        const song = await searchMusic(query);
        if (!song) return null;

        // Add to queue
        const state = getMusicState(userId);
        state.queue.push(song.videoId);
        state.currentIndex = state.queue.length - 1;
        state.isPlaying = true;

        // Download the MP3
        const audioPath = `/tmp/music_${song.videoId}_${Date.now()}.mp3`;
        const downloadSuccess = await downloadMp3(song.videoId, audioPath);

        // Build stylish caption
        const descLine = song.description ? `\n_${escapeMd(song.description.slice(0, 120))}_\n` : "\n";

        const caption = `🎵 **Now Playing**

**${escapeMd(song.title)}**${descLine}
⏱ ${formatDuration(0)} / ${song.duration}

${createProgressBar(0, song.durationSec)}

🔊 High Quality MP3${downloadSuccess ? "" : "\n\n⚠️ Download failed — the API may be busy"}`;

        return {
            caption,
            photo: song.thumbnail,
            keyboard: musicKeyboard(song.videoId),
            audioPath: downloadSuccess ? audioPath : undefined,
            videoId: song.videoId,
        };
    } catch (err: any) {
        console.error("[Music] searchAndPlay error:", err.message);
        return null;
    }
}

// ============================================================
// TEST THE API (used by /testcookies)
// ============================================================
export async function testCookies(): Promise<{ valid: boolean; message: string }> {
    try {
        const song = await searchMusic("Never Gonna Give You Up");
        if (!song) return { valid: false, message: "Search returned no results" };

        const dlOk = await (async () => {
            const url = `${API_BASE}/dl?id=${encodeURIComponent(song.videoId)}`;
            const res = await fetch(url, { method: "GET" });
            return res.ok;
        })();

        return {
            valid: true,
            message: `Search ✓ (${song.title}) | Download endpoint: ${dlOk ? "✓ reachable" : "⚠️ not reachable"}`,
        };
    } catch (err: any) {
        return { valid: false, message: err.message };
    }
}

// ============================================================
// MUSIC CONTROLS
// ============================================================
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
