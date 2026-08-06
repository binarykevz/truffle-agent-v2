import YTMusic from "ytmusic-api";
import { InlineKeyboard } from "grammy";
import { getConfig } from "./db";

// Singleton YTMusic instance (re-initialized when cookies change)
let ytmusic: YTMusic | null = null;
let lastCookiesHash: string | null = null;

/**
 * Get or create the YTMusic instance with current cookies from Turso.
 * Re-initializes automatically when cookies change.
 */
async function getYTMusic(): Promise<YTMusic> {
    const cookies = await getConfig("youtube_cookies");
    const hash = cookies ? Bun.hash(cookies).toString() : null;

    // Reinitialize if cookies changed or no instance exists
    if (!ytmusic || hash !== lastCookiesHash) {
        ytmusic = new YTMusic();
        try {
            await ytmusic.initialize(cookies || undefined);
            lastCookiesHash = hash;
            console.log(`[Music] ✓ YTMusic initialized${cookies ? " with cookies" : " (anonymous)"}`);
        } catch (err: any) {
            console.error("[Music] YTMusic init failed:", err.message);
            // Continue anyway - might still work for some features
        }
    }

    return ytmusic;
}

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

function escapeMd(text: string): string {
    return text.replace(/[_*`\[\]()~>#+\-=|{}.!\\]/g, "\\$&");
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
 * Get audio stream URL directly from YouTube's InnerTube API.
 * Uses Android Music client which bypasses most bot restrictions.
 */
async function getStreamUrlDirect(videoId: string): Promise<string | null> {
    const cookies = await getConfig("youtube_cookies");

    // YouTube InnerTube API key (public, used by all YouTube clients)
    const apiKey = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    const playerUrl = `https://music.youtube.com/youtubei/v1/player?key=${apiKey}`;

    // Try multiple client contexts (Android Music is least restricted)
    const clients = [
        {
            name: "ANDROID_MUSIC",
            version: "7.27.52",
            userAgent: "com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14; US) gzip",
            clientNameId: "21",
            extra: { androidSdkVersion: 34 },
        },
        {
            name: "WEB_REMIX",
            version: "1.20241127.01.00",
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            clientNameId: "67",
            extra: {},
        },
        {
            name: "TVHTML5",
            version: "7.20241126.00.00",
            userAgent: "Mozilla/5.0 (PlayStation; PlayStation 5/2.50) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15",
            clientNameId: "7",
            extra: {},
        },
    ];

    for (const client of clients) {
        try {
            console.log(`[Music] Trying ${client.name} player client...`);

            const body = {
                context: {
                    client: {
                        clientName: client.name,
                        clientVersion: client.version,
                        hl: "en",
                        gl: "US",
                        ...client.extra,
                    },
                },
                videoId: videoId,
                contentCheckOk: true,
                racyCheckOk: true,
            };

            const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "User-Agent": client.userAgent,
                "X-YouTube-Client-Name": client.clientNameId,
                "X-YouTube-Client-Version": client.version,
                "Origin": "https://music.youtube.com",
                "Referer": "https://music.youtube.com/",
            };

            if (cookies) {
                headers["Cookie"] = cookies;
            }

            const response = await fetch(playerUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                console.warn(`[Music] ${client.name} request failed: ${response.status}`);
                continue;
            }

            const data = await response.json() as any;

            // Check playability
            const status = data.playabilityStatus?.status;
            if (status !== "OK") {
                console.warn(`[Music] ${client.name}: not playable (${status}) - ${data.playabilityStatus?.reason || "unknown"}`);
                continue;
            }

            // Get audio formats
            const formats = [
                ...(data.streamingData?.adaptiveFormats || []),
                ...(data.streamingData?.formats || []),
            ];

            const audioFormats = formats.filter((f: any) =>
                f.mimeType?.startsWith("audio/")
            );

            if (audioFormats.length === 0) {
                console.warn(`[Music] ${client.name}: no audio formats`);
                continue;
            }

            // Sort by bitrate (highest quality first)
            audioFormats.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
            const bestAudio = audioFormats[0];

            // Direct URL available (Android/TV clients usually provide this)
            if (bestAudio.url) {
                console.log(`[Music] ✓ ${client.name}: got direct stream URL (${bestAudio.mimeType}, ${Math.round((bestAudio.bitrate || 0) / 1000)}kbps)`);
                return bestAudio.url;
            }

            // Handle signatureCipher (rare with Android client, common with Web)
            if (bestAudio.signatureCipher) {
                console.warn(`[Music] ${client.name}: signatureCipher detected, attempting parse`);
                const params = new URLSearchParams(bestAudio.signatureCipher);
                const url = params.get("url");
                if (url) {
                    return url; // May need signature, but often works
                }
            }
        } catch (err: any) {
            console.warn(`[Music] ${client.name} error: ${err.message}`);
        }
    }

    console.error(`[Music] All player clients failed for ${videoId}`);
    return null;
}

// ============================================================
// SEARCH & PLAY
// ============================================================

export async function searchAndPlay(query: string, userId: number): Promise<{
    caption: string;
    photo: string;
    keyboard: InlineKeyboard;
    audioPath?: string;
    videoId: string;
} | null> {
    try {
        const yt = await getYTMusic();
        console.log(`[Music] Searching for: ${query}`);

        const songs = await yt.searchSongs(query);

        if (!songs || songs.length === 0) {
            console.log("[Music] No songs found");
            return null;
        }

        const song = songs[0];
        const videoId = song.videoId;

        console.log(`[Music] ✓ Found: ${song.name} by ${song.artist?.name || "Unknown"} (${videoId})`);

        // Add to queue
        const state = getMusicState(userId);
        state.queue.push(videoId);
        state.currentIndex = state.queue.length - 1;
        state.isPlaying = true;


// ============================================================
        // GET STREAM URL (direct InnerTube API approach)
        // ============================================================
        const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;
        let downloadSuccess = false;
        let streamUrl: string | null = null;

        try {
            // Method 1: Check if streamUrl is already in search results
            if ((song as any).streamUrl) {
                streamUrl = (song as any).streamUrl;
                console.log(`[Music] ✓ Stream URL from search results`);
            } else {
                // Method 2: Direct InnerTube player request (bypasses ytmusic-api)
                streamUrl = await getStreamUrlDirect(videoId);
            }

            // Download the audio stream
            if (streamUrl) {
                console.log(`[Music] Downloading audio stream...`);
                const response = await fetch(streamUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                        "Referer": "https://music.youtube.com/",
                    },
                });

                if (response.ok && response.body) {
                    const arrayBuffer = await response.arrayBuffer();
                    await Bun.write(audioPath, arrayBuffer);
                    const size = Bun.file(audioPath).size;
                    console.log(`[Music] ✓ Downloaded ${size} bytes`);
                    downloadSuccess = size > 10000;
                } else {
                    console.warn(`[Music] Stream download failed: HTTP ${response.status}`);
                }
            } else {
                console.warn("[Music] No stream URL available");
            }
        } catch (err: any) {
            console.error("[Music] Audio download failed:", err.message);
        }
        
        

        // Build caption
        const title = song.name || "Unknown Title";
        const artist = song.artist?.name || "Unknown Artist";
        const album = song.album?.name || "Single";
        const duration = song.duration || 180;
        const thumbnail = song.thumbnails?.[song.thumbnails.length - 1]?.url || 
                         (song as any).thumbnail || "";

        const caption = `🎵 **Now Playing**

**${escapeMd(title)}**
${escapeMd(artist)}

💿 ${escapeMd(album)}

⏱ ${formatDuration(0)} / ${formatDuration(duration)}

${createProgressBar(0, duration)}

🔊 High Quality AAC${downloadSuccess ? "" : "\n\n⚠️ Audio stream unavailable"}`;

        return {
            caption,
            photo: thumbnail,
            keyboard: musicKeyboard(videoId),
            audioPath: downloadSuccess ? audioPath : undefined,
            videoId,
        };
    } catch (err: any) {
        console.error("[Music] searchAndPlay error:", err.message);
        console.error(err.stack);
        return null;
    }
}

// ============================================================
// MUSIC CONTROLS
// ============================================================

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

// ============================================================
// COOKIE VALIDATION
// ============================================================

export async function testCookies(): Promise<{ valid: boolean; message: string }> {
    try {
        const cookies = await getConfig("youtube_cookies");
        const yt = new YTMusic();
        await yt.initialize(cookies || undefined);

        // Test with a known working search
        const results = await yt.searchSongs("Never Gonna Give You Up");
        
        if (!results || results.length === 0) {
            return { valid: false, message: "Search returned no results" };
        }

        const song = results[0];
        
        // Try to get stream URL (the real test)
        const streamUrl = await yt.getStreamUrl(song.videoId);
        
        if (!streamUrl) {
            return { valid: false, message: "Could not get stream URL" };
        }

        // Force re-init on next call since we created a new instance
        lastCookiesHash = null;

        return {
            valid: true,
            message: `Test song: ${song.name} by ${song.artist?.name || "Unknown"}`,
        };
    } catch (err: any) {
        return { valid: false, message: err.message };
    }
}
