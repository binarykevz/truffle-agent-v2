import { Innertube } from "youtubei.js";
import { InlineKeyboard } from "grammy";

let yt: InstanceType<typeof Innertube> | null = null;

async function getYT() {
    if (!yt) {
        yt = await Innertube.create();
    }
    return yt;
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
    const empty = "▱".repeat(width - progress - 1);
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

/**
 * Extract the first song item from YouTube Music search results.
 * Handles the MusicShelf -> contents -> MusicResponsiveListItem structure.
 */
function findFirstSong(searchResult: any): any | null {
    // Case 1: Direct array of items
    if (Array.isArray(searchResult)) {
        for (const item of searchResult) {
            if (item.type === "MusicResponsiveListItem") return item;
            if (item.type === "MusicShelf" && item.contents?.length > 0) {
                return item.contents[0];
            }
        }
    }

    // Case 2: search.contents is an array of shelves/items
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

    // Case 3: The result itself is a shelf
    if (searchResult?.type === "MusicShelf" && searchResult.contents?.length > 0) {
        return searchResult.contents[0];
    }

    return null;
}

/**
 * Extract video ID from a MusicResponsiveListItem.
 * In youtubei.js v11+, the item has a direct `id` property.
 */
function extractVideoId(item: any): string | null {
    if (!item) return null;

    // Direct properties (most common in newer versions)
    if (item.id) return String(item.id);
    if (item.video_id) return String(item.video_id);
    if (item.videoId) return String(item.videoId);

    // Navigation endpoint (deep path used by some result formats)
    try {
        const navEndpoint = item.overlay?.music_item_thumbnail_overlay_renderer
            ?.content?.music_play_button_renderer
            ?.play_navigation_endpoint?.watch_endpoint?.video_id;
        if (navEndpoint) return String(navEndpoint);
    } catch {}

    // Fallback: try the youtubei.js native navigation method
    try {
        if (typeof item.play === "function") {
            // Some versions expose a play method that contains the video ID internally
            // We can't use this directly, but it confirms the item is playable
        }
    } catch {}

    return null;
}

function extractTitle(item: any): string {
    if (!item) return "Unknown Title";

    // Newer youtubei.js exposes .title directly as string or YTNode
    if (typeof item.title === "string") return item.title;
    if (item.title?.text) return item.title.text;
    if (item.title?.runs?.[0]?.text) return item.title.runs[0].text;

    // Fallback: flex_columns[0] usually holds the title
    try {
        const col = item.flex_columns?.[0];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}

    return "Unknown Title";
}

function extractArtists(item: any): string {
    if (!item) return "Unknown Artist";

    // Direct artists array
    if (Array.isArray(item.artists)) {
        return item.artists.map((a: any) => a.name || String(a)).join(", ");
    }
    if (item.artists?.text) return item.artists.text;
    if (item.artists?.runs?.[0]?.text) return item.artists.runs[0].text;

    // flex_columns[1] often holds the artist
    try {
        const col = item.flex_columns?.[1];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}

    return "Unknown Artist";
}

function extractAlbum(item: any): string {
    if (item?.album?.name) return item.album.name;
    if (item?.album?.text) return item.album.text;

    // Sometimes in flex_columns[2]
    try {
        const col = item.flex_columns?.[2];
        if (col?.data?.runs?.[0]?.text) return col.data.runs[0].text;
    } catch {}

    return "Single";
}

function extractThumbnail(item: any): string {
    if (item?.thumbnail?.length) return item.thumbnail[0].url;
    if (item?.thumbnails?.length) return item.thumbnails[0].url;
    
    // Try deeper paths
    try {
        if (item.thumbnail_renderer?.thumbnails?.length) {
            return item.thumbnail_renderer.thumbnails[0].url;
        }
    } catch {}

    return "";
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

    console.log(`[Music] Search type: ${search.type}, has contents: ${!!search.contents}`);

    const song = findFirstSong(search);

    if (!song) {
        console.log("[Music] Could not find any song in search results");
        return null;
    }

    console.log(`[Music] Song type: ${song.type}`);

    const videoId = extractVideoId(song);
    if (!videoId) {
        console.error("[Music] Could not extract video ID. Song keys:", Object.keys(song));
        console.error("[Music] Full song object:", JSON.stringify(song, null, 2).slice(0, 1500));
        return null;
    }

    console.log(`[Music] ✓ Found video ID: ${videoId}`);

    // Add to queue
    const state = getMusicState(userId);
    state.queue.push(videoId);
    state.currentIndex = state.queue.length - 1;
    state.isPlaying = true;

    // Download audio
    const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;

    try {
        console.log(`[Music] Downloading audio for: ${videoId}`);

        const stream = await yt.download(videoId, {
            type: "audio",
            quality: "bestaudio",
            format: "mp4",
        });

        const file = Bun.file(audioPath);
        const writer = file.writer();

        let bytesWritten = 0;
        for await (const chunk of stream) {
            writer.write(chunk);
            bytesWritten += chunk.length;
        }
        await writer.end();

        console.log(`[Music] ✓ Downloaded ${bytesWritten} bytes to ${audioPath}`);
    } catch (err: any) {
        console.error("[Music] Audio download failed:", err.message);
        // Continue - we still want to show the UI even if download failed
    }

    // Get video duration from basic info
    let duration = 180;
    try {
        const info = await yt.getInfo(videoId);
        duration = info.basic_info?.duration || info.page?.[0]?.microformat?.microformat_data?.length_seconds || 180;
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

🔊 High Quality AAC`;

    return {
        caption,
        photo: thumbnail,
        keyboard: musicKeyboard(videoId),
        audioPath: await Bun.file(audioPath).exists() ? audioPath : undefined,
        videoId,
    };
}

function escapeMd(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, "\\$&");
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