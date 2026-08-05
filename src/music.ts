import { Innertube } from "youtubei.js";
import { InlineKeyboard } from "grammy";
import { spawn } from "bun";

let yt: InstanceType<typeof Innertube> | null = null;

async function getYT() {
    if (!yt) {
        yt = await Innertube.create({
            cache: new UniversalCache(false),
            generate_session_locally: true,
        });
    }
    return yt;
}

// Simple in-memory cache for youtubei.js
class UniversalCache {
    private cache = new Map<string, any>();
    constructor(private enabled: boolean) {}
    get(key: string) { return this.cache.get(key); }
    set(key: string, value: any) { this.cache.set(key, value); }
    remove(key: string) { this.cache.delete(key); }
    has(key: string) { return this.cache.has(key); }
    clear() { this.cache.clear(); }
}

// Music player state per user
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
            queue: [],
            currentIndex: 0,
            isPlaying: false,
            isRepeat: false,
            isShuffle: false,
            favorites: [],
            playlist: [],
        });
    }
    return userMusicState.get(userId)!;
}

function createProgressBar(current: number, total: number, width: number = 12): string {
    if (total <= 0) return "▱".repeat(width);
    const progress = Math.min(Math.floor((current / total) * width), width);
    const filled = "▰".repeat(progress);
    const empty = "▱".repeat(Math.max(width - progress - 1, 0));
    return `${filled}●${empty}`;
}

function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

export function musicKeyboard(videoId: string) {
    return new InlineKeyboard()
        .text("⏮", `music:prev:${videoId}`)
        .text("⏯", `music:play:${videoId}`)
        .text("⏭", `music:next:${videoId}`)
        .row()
        .text("🔀 Shuffle", `music:shuffle:${videoId}`)
        .text("🔁 Repeat", `music:repeat:${videoId}`)
        .row()
        .text("❤️ Favorite", `music:fav:${videoId}`)
        .text("➕ Playlist", `music:playlist:${videoId}`)
        .row()
        .text("🎤 Artist", `music:artist:${videoId}`)
        .text("💿 Album", `music:album:${videoId}`)
        .row()
        .text("🔍 Search Again", "music:search");
}

// ============================================================
// DOWNLOAD METHODS
// ============================================================

/**
 * Method 1: Try youtubei.js direct download
 */
async function downloadWithYoutubeiJS(videoId: string, outputPath: string): Promise<boolean> {
    try {
        const yt = await getYT();
        console.log(`[Music] Attempting download with youtubei.js: ${videoId}`);

        const stream = await yt.download(videoId, {
            type: "audio",
            quality: "bestaudio",
            format: "mp4",
            client: "WEB_REMIX", // Use YouTube Music client which has fewer restrictions
        });

        const file = Bun.file(outputPath);
        const writer = file.writer();

        let bytesWritten = 0;
        for await (const chunk of stream) {
            writer.write(chunk);
            bytesWritten += chunk.length;
        }
        await writer.end();

        console.log(`[Music] ✓ youtubei.js downloaded ${bytesWritten} bytes`);
        return bytesWritten > 10000; // Consider successful if we got real data
    } catch (err: any) {
        console.warn(`[Music] youtubei.js download failed: ${err.message}`);
        return false;
    }
}

/**
 * Method 2: Fallback to yt-dlp (more reliable for restricted videos)
 */
async function downloadWithYtDlp(videoId: string, outputPath: string): Promise<boolean> {
    try {
        console.log(`[Music] Attempting download with yt-dlp: ${videoId}`);
        const url = `https://www.youtube.com/watch?v=${videoId}`;

        const proc = spawn([
            "yt-dlp",
            "--extract-audio",
            "--audio-format", "mp3",
            "--audio-quality", "0",
            "--no-playlist",
            "--no-warnings",
            "-o", outputPath.replace(".mp3", ".%(ext)s"),
            url,
        ], {
            stdout: "pipe",
            stderr: "pipe",
        });

        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;

        if (exitCode !== 0) {
            console.warn(`[Music] yt-dlp failed (exit ${exitCode}):`, stderr.slice(0, 300));
            return false;
        }

        // yt-dlp may save as .mp3 directly or with a different extension
        const expectedPath = outputPath.replace(".mp3", ".mp3");
        if (await Bun.file(expectedPath).exists()) {
            const size = Bun.file(expectedPath).size;
            console.log(`[Music] ✓ yt-dlp downloaded ${size} bytes`);
            return size > 10000;
        }

        // Try common alternative extensions yt-dlp might use
        for (const ext of ["mp3", "m4a", "webm", "opus"]) {
            const altPath = outputPath.replace(".mp3", `.${ext}`);
            if (await Bun.file(altPath).exists()) {
                // Rename to our expected path
                const file = Bun.file(altPath);
                await Bun.write(outputPath, file);
                await Bun.file(altPath).delete();
                const size = Bun.file(outputPath).size;
                console.log(`[Music] ✓ yt-dlp downloaded ${size} bytes (was .${ext})`);
                return size > 10000;
            }
        }

        console.warn("[Music] yt-dlp finished but output file not found");
        return false;
    } catch (err: any) {
        console.warn(`[Music] yt-dlp error: ${err.message}`);
        return false;
    }
}

/**
 * Method 3: Try youtubei.js with different clients
 */
async function downloadWithAlternateClients(videoId: string, outputPath: string): Promise<boolean> {
    const yt = await getYT();
    const clients = ["ANDROID_MUSIC", "IOS", "WEB"] as const;

    for (const client of clients) {
        try {
            console.log(`[Music] Trying youtubei.js with client: ${client}`);
            const stream = await yt.download(videoId, {
                type: "audio",
                quality: "bestaudio",
                client: client as any,
            });

            const file = Bun.file(outputPath);
            const writer = file.writer();
            let bytesWritten = 0;

            for await (const chunk of stream) {
                writer.write(chunk);
                bytesWritten += chunk.length;
            }
            await writer.end();

            if (bytesWritten > 10000) {
                console.log(`[Music] ✓ Downloaded with ${client}: ${bytesWritten} bytes`);
                return true;
            }
        } catch (err: any) {
            console.warn(`[Music] Client ${client} failed: ${err.message}`);
        }
    }

    return false;
}

/**
 * Main download function that tries multiple methods
 */
async function downloadAudio(videoId: string, outputPath: string): Promise<boolean> {
    // Method 1: youtubei.js with WEB_REMIX (YouTube Music)
    if (await downloadWithYoutubeiJS(videoId, outputPath)) {
        return true;
    }

    // Method 2: yt-dlp (most reliable for restricted videos)
    if (await downloadWithYtDlp(videoId, outputPath)) {
        return true;
    }

    // Method 3: youtubei.js with alternate clients
    if (await downloadWithAlternateClients(videoId, outputPath)) {
        return true;
    }

    console.error(`[Music] All download methods failed for ${videoId}`);
    return false;
}

// ============================================================
// SEARCH & PLAY
// ============================================================

function findFirstSong(searchResult: any): any | null {
    if (Array.isArray(searchResult)) {
        for (const item of searchResult) {
            if (item.type === "MusicResponsiveListItem") return item;
            if (item.type === "MusicShelf" && item.contents?.length > 0) {
                return item.contents[0];
            }
        }
    }

    if (searchResult?.contents && Array.isArray(searchResult.contents)) {
        // First try to find a "Songs" shelf specifically
        for (const shelf of searchResult.contents) {
            if (shelf.type === "MusicShelf") {
                const title = shelf.title?.text?.toLowerCase() || "";
                if (title.includes("song") && shelf.contents?.length > 0) {
                    console.log(`[Music] Found "Songs" shelf with ${shelf.contents.length} items`);
                    return shelf.contents[0];
                }
            }
        }
        // Fallback: use first shelf with any contents
        for (const shelf of searchResult.contents) {
            if (shelf.type === "MusicShelf" && shelf.contents?.length > 0) {
                console.log(`[Music] Using shelf "${shelf.title?.text}" with ${shelf.contents.length} items`);
                return shelf.contents[0];
            }
            if (shelf.type === "MusicResponsiveListItem") {
                return shelf;
            }
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
        const navEndpoint = item.overlay?.music_item_thumbnail_overlay_renderer
            ?.content?.music_play_button_renderer
            ?.play_navigation_endpoint?.watch_endpoint?.video_id;
        if (navEndpoint) return String(navEndpoint);
    } catch {}

    return null;
}

function extractTitle(item: any): string {
    if (!item) return "Unknown Title";
    if (typeof item.title === "string") return item.title;
    if (item.title?.text) return item.title.text;
    if (item.title?.runs?.[0]?.text) return item.title.runs[0].text;

    try {
        const col = item.flex_columns?.[0];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}

    return "Unknown Title";
}

function extractArtists(item: any): string {
    if (!item) return "Unknown Artist";
    if (Array.isArray(item.artists)) {
        return item.artists.map((a: any) => a.name || String(a)).join(", ");
    }
    if (item.artists?.text) return item.artists.text;
    if (item.artists?.runs?.[0]?.text) return item.artists.runs[0].text;

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
        if (item.thumbnail_renderer?.thumbnails?.length) {
            return item.thumbnail_renderer.thumbnails[0].url;
        }
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

    if (!search) {
        console.log("[Music] Search returned null");
        return null;
    }

    const song = findFirstSong(search);

    if (!song) {
        console.log("[Music] Could not find any song in search results");
        return null;
    }

    console.log(`[Music] Song type: ${song.type}`);

    const videoId = extractVideoId(song);
    if (!videoId) {
        console.error("[Music] Could not extract video ID. Song keys:", Object.keys(song));
        return null;
    }

    console.log(`[Music] ✓ Found video ID: ${videoId}`);

    // Add to queue
    const state = getMusicState(userId);
    state.queue.push(videoId);
    state.currentIndex = state.queue.length - 1;
    state.isPlaying = true;

    // Download audio with multiple fallback methods
    const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;
    const downloadSuccess = await downloadAudio(videoId, audioPath);

    // Get video duration
    let duration = 180;
    try {
        const info = await yt.getInfo(videoId);
        duration = info.basic_info?.duration || 180;
        console.log(`[Music] Video duration: ${duration}s`);
    } catch (err: any) {
        console.warn("[Music] Could not fetch video info:", err.message);
    }

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

🔊 High Quality AAC${downloadSuccess ? "" : "\n⚠️ Audio stream unavailable, showing preview only"}`;

    return {
        caption,
        photo: thumbnail,
        keyboard: musicKeyboard(videoId),
        audioPath: downloadSuccess && await Bun.file(audioPath).exists() ? audioPath : undefined,
        videoId,
    };
}

export async function handleMusicAction(
    action: string,
    videoId: string,
    userId: number
): Promise<string> {
    const state = getMusicState(userId);

    switch (action) {
        case "play":
            state.isPlaying = !state.isPlaying;
            return state.isPlaying ? "▶️ Resumed" : "⏸️ Paused";
        case "prev":
            if (state.currentIndex > 0) {
                state.currentIndex--;
                return "⏮ Previous track";
            }
            return "⏮ No previous track";
        case "next":
            if (state.currentIndex < state.queue.length - 1) {
                state.currentIndex++;
                return "⏭ Next track";
            } else if (state.isRepeat) {
                state.currentIndex = 0;
                return "🔁 Repeating from start";
            }
            return "⏭ End of queue";
        case "shuffle":
            state.isShuffle = !state.isShuffle;
            if (state.isShuffle && state.queue.length > 1) {
                const remaining = state.queue.slice(state.currentIndex + 1);
                for (let i = remaining.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
                }
                state.queue = [
                    ...state.queue.slice(0, state.currentIndex + 1),
                    ...remaining,
                ];
            }
            return state.isShuffle ? "🔀 Shuffle enabled" : "🔀 Shuffle disabled";
        case "repeat":
            state.isRepeat = !state.isRepeat;
            return state.isRepeat ? "🔁 Repeat enabled" : "🔁 Repeat disabled";
        case "fav":
            if (!state.favorites.includes(videoId)) {
                state.favorites.push(videoId);
                return "❤️ Added to favorites";
            } else {
                state.favorites = state.favorites.filter((id) => id !== videoId);
                return "💔 Removed from favorites";
            }
        case "playlist":
            if (!state.playlist.includes(videoId)) {
                state.playlist.push(videoId);
                return "➕ Added to playlist";
            }
            return "ℹ️ Already in playlist";
        case "artist":
            return "🎤 Artist info coming soon";
        case "album":
            return "💿 Album info coming soon";
        case "search":
            return "🔍 Send a new search query";
        default:
            return "Unknown action";
    }
}