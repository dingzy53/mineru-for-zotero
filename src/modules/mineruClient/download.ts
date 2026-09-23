import { MinerUTaskError } from "./errors";
import { readFileBytes } from "./file";
import { errorMessage, normalizeBinary } from "./http";
import type { ZipEntries } from "./types";
import { readZipFile } from "./zip";

/**
 * Wait for specified milliseconds using Zotero Promise or standard timer.
 */
export async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (typeof Zotero !== "undefined" && Zotero.Promise?.delay) {
    await Zotero.Promise.delay(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Download plain file to temporary path and read bytes without attempting ZIP parsing.
 */
export async function downloadPlainFileBytes(url: string): Promise<Uint8Array> {
  const path = await createTemporaryPath("mineru-result-download");
  try {
    if (typeof Zotero !== "undefined" && Zotero.File?.download) {
      await Zotero.File.download(url, path);
      return normalizeBinary(await readFileBytes(path));
    }
    if (typeof fetch === "function") {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      return normalizeBinary(new Uint8Array(buffer));
    }
    throw new Error("No download mechanism available");
  } catch (error) {
    throw new MinerUTaskError(`file download failed: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await removeFileIfExists(path);
  }
}

/**
 * Download MinerU ZIP to temporary file and read bytes or ZIP entries.
 */
export async function zoteroDownloadFileBytes(
  url: string,
): Promise<Uint8Array | ZipEntries> {
  const bytes = await downloadPlainFileBytes(url);
  const path = await createTemporaryPath("mineru-result.zip");
  try {
    await writeDownloadedBytes(path, bytes);
    return readZipFile(path) ?? bytes;
  } finally {
    await removeFileIfExists(path);
  }
}

/**
 * Create a unique temporary file path under system temporary directory.
 */
export async function createTemporaryPath(fileName: string): Promise<string> {
  const baseDir = PathUtils.tempDir;
  const name = `${Date.now()}-${Math.random().toString(16).slice(2)}-${fileName}`;
  return PathUtils.join(baseDir, name);
}

/**
 * Remove temporary file, ignoring absence or cleanup failures.
 */
export async function removeFileIfExists(path: string): Promise<void> {
  try {
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch {
    // Temporary-file cleanup failure should not hide the parse result.
  }
}

/**
 * Write downloaded temporary bytes for ZIP reader fallback parsing.
 */
export async function writeDownloadedBytes(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  await IOUtils.write(path, bytes);
}
