import { Innertube } from "youtubei.js";
import { InlineKeyboard } from "grammy";
import { spawn } from "bun";

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

// Search and play music
export async function searchAndPlay(query: string, userId: number): Promise<{
    caption: string;
    photo: string;
    keyboard: InlineKeyboard;
    audioPath?: string;
    videoId: string;
} | null> {
    const yt = await getYT();
    
    const search = await yt.music.search(query, { type: "song" });
    
    if (!search.contents || search.contents.length === 0) {
        return null;
    }

    const song = search.contents[0];
    const videoId = song.id;
    
    // Add to queue
    const state = getMusicState(userId);
    state.queue.push(videoId);
    state.currentIndex = state.queue.length - 1;
    state.isPlaying = true;

    // Download audio
    const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;
    
    try {
        const stream = await yt.download(videoId, {
            type: "audio",
            quality: "best",
            format: "mp4",
        });

        const file = Bun.file(audioPath);
        const writer = file.writer();
        
        for await (const chunk of stream) {
            writer.write(chunk);
        }
        
        await writer.end();
    } catch (err) {
        console.error("Audio download failed:", err);
    }

    // Get more details
    const info = await yt.getInfo(videoId);
    const duration = info.basic_info.duration || 0;
    const currentTime = 78; // Simulated current time for demo

    const caption = `🎵 **Now Playing**

**${song.title}**
${song.artists?.map((a: any) => a.name).join(", ") || "Unknown Artist"}

💿 ${song.album?.name || "Single"}

⏱ ${formatDuration(currentTime)} / ${formatDuration(duration)}

${createProgressBar(currentTime, duration)}

🔊 High Quality AAC`;

    return {
        caption,
        photo: song.thumbnails?.[0]?.url || "",
        keyboard: musicKeyboard(videoId),
        audioPath,
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
            if (state.isShuffle) {
                // Shuffle the remaining queue
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