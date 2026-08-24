import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GeneratedImage {
  /** base64-encoded image bytes */
  base64: string;
  mimeType: string;
}

export function sniffMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79) return "image/webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "image/png";
}

export function extForMime(mime: string): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return ".png";
}

export function resolveUserPath(path: string, cwd: string): string {
  if (path.startsWith("~/")) return join(process.env.HOME ?? "", path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function slug(text: string, max = 60): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (s || "image").slice(0, max);
}

/** Write a generated image to outputDir (or an exact outputPath when given). Returns the absolute path. */
export async function saveImage(opts: {
  base64: string;
  mimeType: string;
  outputDir: string;
  cwd: string;
  outputPath?: string;
  overwrite?: boolean;
  prompt: string;
  index: number;
  count: number;
}): Promise<string> {
  const bytes = Buffer.from(opts.base64, "base64");
  if (opts.outputPath) {
    const target = resolveUserPath(opts.outputPath, opts.cwd);
    if (!opts.overwrite) {
      const existing = await readFile(target).catch(() => undefined);
      if (existing) throw new Error(`outputPath already exists: ${target}. Pass overwrite=true to replace it.`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return target;
  }
  const dir = isAbsolute(opts.outputDir) ? opts.outputDir : resolve(opts.cwd, opts.outputDir);
  await mkdir(dir, { recursive: true });
  const suffix = opts.count > 1 ? `-${opts.index + 1}` : "";
  const file = join(dir, `${timestamp()}-${slug(opts.prompt)}${suffix}${extForMime(opts.mimeType)}`);
  await writeFile(file, bytes);
  return file;
}

/** Read a local image file into a data URL for image-edit requests. */
export async function readImageAsDataUrl(path: string): Promise<string> {
  const bytes = await readFile(path);
  const mime = sniffMime(bytes);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
