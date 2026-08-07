import { getConfig } from "./db";

const API_BASE = "https://truffle-music.onrender.com";

// ============================================================
// HELPERS
// ============================================================
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

function toHDThumbnail(url: string): string {
    if (!url) return url;
    if (url.includes("_hd")) return url;
    return url.replace(/(\.[a-zA-Z0-9]+)$/, "_hd$1");
}

/**
 * Check if a thumbnail URL actually exists (returns 200).
 */
async function thumbnailExists(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: "HEAD" });
        if (res.ok) return true;
        // Some CDNs reject HEAD; try a tiny GET
        const getRes = await fetch(url, { headers: { Range: "bytes=0-1" } });
        return getRes.ok || getRes.status === 206;
    } catch {
        return false;
    }
}

/**
 * Build an HD quality ladder and return the best working thumbnail.
 * Prefers _hd variants, then maxres, then hqdefault as a guaranteed fallback.
 */
async function getHDThumbnail(item: any, videoId: string): Promise<string> {
    let raw = getField(item, ["thumbnail", "thumbnails", "image", "img", "cover", "thumb"]);

    if (Array.isArray(raw)) {
        raw = raw[raw.length - 1]?.url || raw[0]?.url || null;
    } else if (raw && typeof raw === "object") {
        raw = raw.url || null;
    }

    const candidates: string[] = [];

    // 1. API thumbnail upgraded to _hd (highest preference)
    if (typeof raw === "string" && raw) candidates.push(toHDThumbnail(raw));
    // 2. API original thumbnail
    if (typeof raw === "string" && raw) candidates.push(raw);
    // 3. YouTube HD ladder
    candidates.push(`https://i.ytimg.com/vi/${videoId}/maxresdefault_hd.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/hqdefault_hd.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/sddefault_hd.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/sddefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`); // guaranteed

    // Return the first candidate that actually exists
    for (const url of candidates) {
        if (await thumbnailExists(url)) {
            console.log(`[Music] 🖼️ HD thumbnail: ${url.split("/").pop()}`);
            return url;
        }
    }

    // Absolute fallback (always exists on YouTube)
    return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// ============================================================
// SEARCH (uses /search?q=)
// ============================================================
export interface MusicResult {
    videoId: string;
    title: string;
    artist: string;
    description: string;
    duration: string;
    durationSec: number;
    thumbnail: string;
    audioPath?: string;
}

export async function searchAndPlay(query: string, _userId: number): Promise<MusicResult | null> {
    try {
        // 1. Search
        const searchUrl = `${API_BASE}/search?q=${encodeURIComponent(query)}`;
        console.log(`[Music] Searching: ${searchUrl}`);

        const res = await fetch(searchUrl);
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

        // 2. Parse metadata
        const videoId = String(getField(item, ["video_id", "videoId", "id", "videoID"]));
        if (!videoId) {
            console.error("[Music] Could not extract video_id");
            return null;
        }

        const title = String(getField(item, ["title", "name", "song"]) || "Unknown Title");
        const artist = String(getField(item, ["artist", "author", "channel"]) || "Unknown Artist");
        const description = String(getField(item, ["description", "desc"]) || "");
        const durationRaw = getField(item, ["duration", "length", "duration_text", "durationText"]);
        const durationSec = parseDurationToSeconds(durationRaw);
        const duration = typeof durationRaw === "string" && durationRaw.includes(":")
            ? durationRaw
            : formatDuration(durationSec);
              const thumbnail = await getHDThumbnail(item, videoId);

        console.log(`[Music] ✓ Found: ${title} by ${artist} (${videoId})`);

        // 3. Download MP3
        const audioPath = `/tmp/music_${videoId}_${Date.now()}.mp3`;
        const dlUrl = `${API_BASE}/dl?id=${encodeURIComponent(videoId)}`;
        console.log(`[Music] Downloading: ${dlUrl}`);

        let downloadSuccess = false;
        try {
            const dlRes = await fetch(dlUrl);
            if (dlRes.ok) {
                const contentType = dlRes.headers.get("content-type") || "";

                if (contentType.includes("application/json")) {
                    const dlData = await dlRes.json();
                    const fileUrl = getField(dlData, ["url", "download_url", "downloadUrl", "link", "audio", "file", "src"]);
                    if (fileUrl) {
                        const fileRes = await fetch(fileUrl);
                        if (fileRes.ok) {
                            await Bun.write(audioPath, await fileRes.arrayBuffer());
                            downloadSuccess = Bun.file(audioPath).size > 10000;
                        }
                    }
                } else {
                    await Bun.write(audioPath, await dlRes.arrayBuffer());
                    downloadSuccess = Bun.file(audioPath).size > 10000;
                }
                console.log(`[Music] ✓ Downloaded: ${Bun.file(audioPath).size} bytes`);
            }
        } catch (err: any) {
            console.error("[Music] Download error:", err.message);
        }

        return {
            videoId,
            title,
            artist,
            description,
            duration,
            durationSec,
            thumbnail,
            audioPath: downloadSuccess ? audioPath : undefined,
        };
    } catch (err: any) {
        console.error("[Music] searchAndPlay error:", err.message);
        return null;
    }
}

// ============================================================
// TEST API (used by /testcookies)
// ============================================================
export async function testCookies(): Promise<{ valid: boolean; message: string }> {
    try {
        const searchUrl = `${API_BASE}/search?q=${encodeURIComponent("Never Gonna Give You Up")}`;
        const res = await fetch(searchUrl);
        if (!res.ok) return { valid: false, message: `API returned ${res.status}` };

        const data = await res.json();
        const results = toResults(data);
        if (results.length === 0) return { valid: false, message: "Search returned no results" };

        const videoId = String(getField(results[0], ["video_id", "videoId", "id"]));
        const title = String(getField(results[0], ["title", "name"]) || "Unknown");

        const dlRes = await fetch(`${API_BASE}/dl?id=${encodeURIComponent(videoId)}`);

        return {
            valid: true,
            message: `Search ✓ (${title}) | Download: ${dlRes.ok ? "✓ reachable" : "⚠️ failed"}`,
        };
    } catch (err: any) {
        return { valid: false, message: err.message };
    }
}
