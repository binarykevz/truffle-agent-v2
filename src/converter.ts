import { spawn } from "bun";
import { dirname, join, parse } from "path";
import sharp from "sharp";

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
    const outputPath = join(dir, `${baseName}.${targetExt}`);
    const ext = sourceExt.toLowerCase();

    if (["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) {
        try {
            await sharp(inputPath).toFormat(targetExt as any).toFile(outputPath);
            return outputPath;
        } catch (e: any) { throw new Error(`Image conversion failed: ${e.message}`); }
    }

    if (["pdf", "docx", "pptx", "xlsx"].includes(ext) || targetExt === "pdf") {
        const proc = spawn(["soffice", "--headless", "--convert-to", targetExt, "--outdir", dir, inputPath]);
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) throw new Error(`LibreOffice failed (code ${code}): ${err}\n💡 Fix: sudo apt install libreoffice`);
        const libreOutput = join(dir, `${baseName}.${targetExt}`);
        if (await Bun.file(libreOutput).exists()) return libreOutput;
        throw new Error("LibreOffice finished but output file not found.");
    }

    if (["mp3", "mp4", "wav", "ogg", "m4a", "avi", "gif"].includes(ext) || ["mp3", "wav", "ogg", "m4a", "gif", "avi"].includes(targetExt)) {
        const proc = spawn(["ffmpeg", "-y", "-i", inputPath, outputPath]);
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        if (code !== 0) throw new Error(`FFmpeg failed (code ${code}): ${err}\n💡 Fix: sudo apt install ffmpeg`);
        return outputPath;
    }

    if (["zip", "7z", "tar.gz"].includes(ext) || ["zip", "7z", "tar.gz"].includes(targetExt)) {
        if (targetExt === "7z") {
            const proc = spawn(["7z", "a", `-t7z`, outputPath, inputPath]);
            if ((await proc.exited) !== 0) throw new Error("7z failed. 💡 Fix: sudo apt install p7zip-full");
            return outputPath;
        } else if (targetExt === "zip") {
            const proc = spawn(["zip", "-j", outputPath, inputPath]);
            if ((await proc.exited) !== 0) throw new Error("zip failed. 💡 Fix: sudo apt install zip");
            return outputPath;
        } else if (targetExt === "tar.gz") {
            const proc = spawn(["tar", "-czvf", outputPath, "-C", dir, baseName + "." + ext]);
            if ((await proc.exited) !== 0) throw new Error("tar.gz failed.");
            return outputPath;
        }
    }
    throw new Error(`Conversion from ${ext} to ${targetExt} is not supported.`);
}
