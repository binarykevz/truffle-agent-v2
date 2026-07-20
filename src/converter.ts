import { spawn } from "bun";
import { dirname, join, parse } from "path";
import { createHash } from "crypto";
import sharp from "sharp";
import { conversionCache, hashKey } from "./cache";

export const CONVERSION_MATRIX: Record<string, string[]> = {
    "pdf": ["docx", "txt", "png", "jpg"],
    "docx": ["pdf", "txt", "html"],
    "pptx": ["pdf", "png"],
    "xlsx": ["pdf", "csv"],
    "jpg": ["png", "webp", "pdf"],
    "jpeg": ["png", "webp", "pdf"],
    "png": ["jpg", "webp", "pdf"],
    "heic": ["jpg", "png"],
    "webp": ["jpg", "png"],
    "mp3": ["wav", "ogg", "m4a"],
    "mp4": ["gif", "mp3", "avi"],
    "zip": ["7z", "tar.gz"],
    "7z": ["zip", "tar.gz"]
};

export function getConversionOptions(ext: string): string[] {
    return CONVERSION_MATRIX[ext.toLowerCase()] || [];
}

export async function convertFile(inputPath: string, sourceExt: string, targetExt: string): Promise<string> {
    const dir = dirname(inputPath);
    const baseName = parse(inputPath).name;
    const ext = sourceExt.toLowerCase();

    const fileContent = await Bun.file(inputPath).arrayBuffer();
    const contentHash = createHash("sha256").update(new Uint8Array(fileContent)).digest("hex").slice(0, 16);
    const cacheKey = hashKey(contentHash, ext, targetExt);

    const cachedPath = conversionCache.get(cacheKey);
    if (cachedPath && await Bun.file(cachedPath).exists()) {
        console.log(`[cache] Conversion hit: ${ext} → ${targetExt}`);
        return cachedPath;
    }

    const outputPath = join(dir, `${baseName}_${contentHash.slice(0, 8)}.${targetExt}`);

    if (["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) {
        await sharp(inputPath).toFormat(targetExt as any).toFile(outputPath);
    } else if (["pdf", "docx", "pptx", "xlsx"].includes(ext) || targetExt === "pdf") {
        const proc = spawn(["soffice", "--headless", "--convert-to", targetExt, "--outdir", dir, inputPath]);
        const code = await proc.exited;
        if (code !== 0) throw new Error(`LibreOffice failed. Install: sudo apt install libreoffice`);
    } else if (["mp3", "mp4", "wav", "ogg", "m4a", "avi", "gif"].includes(ext) || ["mp3", "wav", "ogg", "m4a", "gif", "avi"].includes(targetExt)) {
        const proc = spawn(["ffmpeg", "-y", "-i", inputPath, outputPath]);
        const code = await proc.exited;
        if (code !== 0) throw new Error(`FFmpeg failed. Install: sudo apt install ffmpeg`);
    } else if (["zip", "7z", "tar.gz"].includes(ext) || ["zip", "7z", "tar.gz"].includes(targetExt)) {
        if (targetExt === "7z") {
            const proc = spawn(["7z", "a", `-t7z`, outputPath, inputPath]);
            if ((await proc.exited) !== 0) throw new Error("7z failed.");
        } else if (targetExt === "zip") {
            const proc = spawn(["zip", "-j", outputPath, inputPath]);
            if ((await proc.exited) !== 0) throw new Error("zip failed.");
        } else if (targetExt === "tar.gz") {
            const proc = spawn(["tar", "-czvf", outputPath, "-C", dir, baseName + "." + ext]);
            if ((await proc.exited) !== 0) throw new Error("tar.gz failed.");
        }
    } else {
        throw new Error(`Conversion ${ext} → ${targetExt} not supported.`);
    }

    if (await Bun.file(outputPath).exists()) {
        conversionCache.set(cacheKey, outputPath);
        console.log(`[cache] Conversion cached: ${ext} → ${targetExt}`);
    }

    return outputPath;
}
