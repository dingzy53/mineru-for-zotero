import { sanitizeErrorDetail } from "./http";

/**
 * Extract file name from local path, falling back to a default PDF file name when missing.
 */
export function basename(path: string): string {
  return (
    path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "file.pdf"
  );
}

/**
 * Normalize MinerU base URL by stripping trailing slashes.
 */
export function normalizeBaseURL(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Convert file URL or Windows forward-slash drive path to Zotero native path.
 */
export function toNativePath(path: string): string {
  if (path.startsWith("file://")) {
    return toNativePath(decodeFileURLPath(path));
  }
  if (/^[a-z]:\//i.test(path)) {
    return path.replace(/\//g, "\\");
  }
  return path;
}

function decodeFileURLPath(path: string): string {
  try {
    const url = new URL(path);
    if (url.protocol !== "file:") {
      return path;
    }
    const filePath = decodeURIComponent(url.pathname);
    return /^\/[a-z]:\//i.test(filePath) ? filePath.slice(1) : filePath;
  } catch {
    return path;
  }
}

/**
 * Generate a summary of response bytes for diagnosing empty responses or ZIP parsing failures.
 */
export function summarizeBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "empty response";
  }
  const prefix = bytes.slice(0, 240);
  const text = sanitizeErrorDetail(new TextDecoder().decode(prefix));
  const hex = Array.from(bytes.slice(0, 16))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
  return text ? `${text}; hex ${hex}` : `hex ${hex}`;
}

/**
 * Determine whether an in-ZIP path is a safe relative path.
 */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || /^[a-z]:/i.test(path)) {
    return false;
  }
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}
