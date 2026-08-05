import { Innertube } from "youtubei.js";
import { InlineKeyboard } from "grammy";

// Initialize YouTube client
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

// Unicode progress bar
function createProgressBar(current: number, total: number, width: number = 12): string {
    const progress = Math.floor((current / total) * width);
    const filled = "▰".repeat(progress);
    const empty = "▱".repeat(width - progress);
    return `${filled}●${empty}`;
}

// Format duration
function formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

// Create music keyboard
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

// Helper to extract video ID from various YouTube Music result formats
function extractVideoId(song: any): string | null {
    // Try different possible properties
    if (song.id) return song.id;
    if (song.video_id) return song.video_id;
    if (song.videoId) return song.videoId;
    
    // Check in nested structures
    if (song.playlist_item_data?.video_id) return song.playlist_item_data.video_id;
    if (song.overlay?.music_item_thumbnail_overlay_renderer?.content?.music_play_button_renderer?.play_navigation_endpoint?.watch_endpoint?.video_id) {
        return song.overlay.music_item_thumbnail_overlay_renderer.content.music_play_button_renderer.play_navigation_endpoint.watch_endpoint.video_id;
    }
    
    return null;
}

// Helper to extract title
function extractTitle(song: any): string {
    if (typeof song.title === 'string') return song.title;
    if (song.title?.text) return song.title.text;
    if (song.title?.runs?.[0]?.text) return song.title.runs[0].text;
    return "Unknown Title";
}

// Helper to extract artists
function extractArtists(song: any): string {
    if (!song.artists) return "Unknown Artist";
    if (Array.isArray(song.artists)) {
        return song.artists.map((a: any) => a.name || a).join(", ");
    }
    if (song.artists?.text) return song.artists.text;
    return "Unknown Artist";
}

// Search and play music
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
    
    if (!search.contents || search.contents.length === 0) {
        console.log("[Music] No results found");
        return null;
    }

    const song = search.contents[0];
    console.log("[Music] First result:", JSON.stringify(song, null, 2).slice(0, 500));
    
    // Extract video ID using helper
    const videoId = extractVideoId(song);
    
    if (!videoId) {
        console.error("[Music] Could not extract video ID from result");
        return null;
    }
    
    console.log(`[Music] Found video ID: ${videoId}`);
    
    // Add to queue
    const state = getMusicState(userId);
    state.queue.push(videoId);
    state.currentIndex = state.queue.length - 1;
    state.isPlaying = true;

    // Download audio
    const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;
    
    try {
        console.log(`[Music] Downloading audio for: ${videoId}`);
        
        // Use the correct download API
        const stream = await yt.download(videoId, {
            type: "audio",
            quality: "best",
        });

        console.log("[Music] Download stream created");
        
        // Write stream to file using Bun
        const file = Bun.file(audioPath);
        const writer = file.writer();
        
        let bytesWritten = 0;
        for await (const chunk of stream) {
            writer.write(chunk);
            bytesWritten += chunk.length;
        }
        
        await writer.end();
        console.log(`[Music] Downloaded ${bytesWritten} bytes to ${audioPath}`);
    } catch (err: any) {
        console.error("[Music] Audio download failed:", err.message);
        console.error(err.stack);
        // Continue anyway - we'll still show the UI
    }

    // Get more details
    let duration = 180; // Default 3 minutes
    let currentTime = 0;
    
    try {
        const info = await yt.getInfo(videoId);
        duration = info.basic_info?.duration || 180;
        console.log(`[Music] Video duration: ${duration}s`);
    } catch (err) {
        console.warn("[Music] Could not fetch video info:", err);
    }

    const title = extractTitle(song);
    const artists = extractArtists(song);
    const album = song.album?.name || "Single";
    const thumbnail = song.thumbnails?.[0]?.url || "";

    const caption = `🎵 **Now Playing**

**${title}**
${artists}

💿 ${album}

⏱ ${formatDuration(currentTime)} / ${formatDuration(duration)}

${createProgressBar(currentTime, duration, 15)}

🔊 High Quality AAC`;

    return {
        caption,
        photo: thumbnail,
        keyboard: musicKeyboard(videoId),
        audioPath: await Bun.file(audioPath).exists() ? audioPath : undefined,
        videoId,
    };
}

// Handle music control actions
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