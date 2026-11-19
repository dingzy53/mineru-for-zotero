import type { MinerUImageFile } from "./domain";

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const MARKDOWN_DATA_IMAGE =
  /(!\[[^\]]*\]\()\s*data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)\s*(\))/gi;

const HTML_DATA_IMAGE =
  /(<img\b[^>]*?\bsrc=(["']))\s*data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)\s*(\2[^>]*>)/gi;

const ANY_MARKDOWN_DATA_IMAGE =
  /(!\[[^\]]*\]\()\s*data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\s*(\))/gi;

const ANY_HTML_DATA_IMAGE =
  /<img\b[^>]*?\bsrc=(["'])\s*data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+\s*\1[^>]*>/gi;

export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(value >> 18) & 63];
    output += BASE64_ALPHABET[(value >> 12) & 63];
    output +=
      index + 1 < bytes.length ? BASE64_ALPHABET[(value >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[value & 63] : "=";
  }
  return output;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) {
    return new Uint8Array(0);
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const byteLength = Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  const out = new Uint8Array(byteLength);
  let outIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = Math.max(0, BASE64_ALPHABET.indexOf(clean[i] ?? "A"));
    const b = Math.max(0, BASE64_ALPHABET.indexOf(clean[i + 1] ?? "A"));
    const cChar = clean[i + 2];
    const dChar = clean[i + 3];
    const c =
      !cChar || cChar === "=" ? 0 : Math.max(0, BASE64_ALPHABET.indexOf(cChar));
    const d =
      !dChar || dChar === "=" ? 0 : Math.max(0, BASE64_ALPHABET.indexOf(dChar));
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (outIndex < byteLength) out[outIndex++] = (triple >> 16) & 0xff;
    if (outIndex < byteLength) out[outIndex++] = (triple >> 8) & 0xff;
    if (outIndex < byteLength) out[outIndex++] = triple & 0xff;
  }
  return out;
}

function unpadded(b64: string): string {
  return b64.replace(/\s+/g, "").replace(/=+$/, "");
}

function extForFormat(format: string): string {
  const lower = format.toLowerCase();
  return lower === "jpeg" ? "jpg" : lower;
}

/**
 * Rewrite inline `data:image/...;base64,...` links in Markdown to `images/<file>`.
 *
 * Local MinerU 4.0.x embeds every figure in `content.md` as base64 even when
 * the ZIP also carries the image files. Matching the base64 payload against
 * `existingImages` links the saved file; any unmatched inline image is decoded
 * and added to `images` so `content.md` never stores megabytes of base64.
 */
export function extractInlineImages(
  markdown: string,
  existingImages: MinerUImageFile[] = [],
): { markdown: string; images: MinerUImageFile[] } {
  if (!/data:image\//i.test(markdown)) {
    return { markdown, images: existingImages };
  }

  const images = [...existingImages];
  const byKey = new Map<string, string>();
  const usedPaths = new Set<string>();
  for (const image of existingImages) {
    const rel = image.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel) continue;
    usedPaths.add(rel);
    const key = unpadded(bytesToBase64(image.bytes));
    if (key && !byKey.has(key)) {
      byKey.set(key, rel);
    }
  }

  let nextIndex = 1;
  const resolveImagePath = (format: string, rawBase64: string): string => {
    const clean = rawBase64.replace(/\s+/g, "");
    const key = unpadded(clean);
    const existing = byKey.get(key);
    if (existing) {
      return existing;
    }
    const ext = extForFormat(format);
    let candidate = `inline-${nextIndex}.${ext}`;
    while (usedPaths.has(candidate)) {
      nextIndex += 1;
      candidate = `inline-${nextIndex}.${ext}`;
    }
    nextIndex += 1;
    usedPaths.add(candidate);
    byKey.set(key, candidate);
    images.push({ path: candidate, bytes: base64ToBytes(clean) });
    return candidate;
  };

  const rewritten = markdown
    .replace(
      MARKDOWN_DATA_IMAGE,
      (_all, prefix: string, format: string, b64: string, suffix: string) =>
        `${prefix}images/${resolveImagePath(format, b64)}${suffix}`,
    )
    .replace(
      HTML_DATA_IMAGE,
      (
        _all,
        prefix: string,
        _quote: string,
        format: string,
        b64: string,
        suffix: string,
      ) => `${prefix}images/${resolveImagePath(format, b64)}${suffix}`,
    );

  return { markdown: rewritten, images };
}

/**
 * Strip any residual inline `data:image/...;base64,...` URIs before counting
 * words or serving Markdown to MCP clients (covers pre-existing local results
 * already stored on disk).
 */
export function stripInlineDataImages(markdown: string): string {
  if (!/data:image\//i.test(markdown)) {
    return markdown;
  }
  return markdown
    .replace(ANY_MARKDOWN_DATA_IMAGE, "$1embedded image omitted$2")
    .replace(ANY_HTML_DATA_IMAGE, "[embedded image omitted]");
}
