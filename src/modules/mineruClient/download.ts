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
    const curlResult = await downloadWithCurl(url, path);
    if (!curlResult.used) {
      await Zotero.File.download(url, path);
    }
    return normalizeBinary(await readFileBytes(path));
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
 * Prefer curl to download result files on Windows Zotero runtime.
 */
export async function downloadWithCurl(
  url: string,
  path: string,
): Promise<{ used: boolean; reason?: string }> {
  const platform = getRuntimePlatform();
  if (platform !== "win") {
    return { used: false, reason: `platform=${platform}` };
  }
  const processResult = await downloadWithNsIProcess(url, path);
  if (processResult.used) {
    return processResult;
  }
  const process = (
    globalThis as typeof globalThis & {
      ChromeUtils?: {
        importESModule?: (uri: string) => {
          Subprocess?: {
            call: (options: {
              command: string;
              arguments: string[];
              stdout?: string;
              stderr?: string;
            }) => Promise<{ exitCode: number; stderr?: string }>;
          };
        };
      };
    }
  ).ChromeUtils?.importESModule?.(
    "chrome://zotero/content/Subprocess.sys.mjs",
  )?.Subprocess;
  if (!process) {
    return { used: false, reason: `no subprocess; ${processResult.reason}` };
  }
  const result = await process.call({
    command: "curl.exe",
    arguments: ["-L", "--fail", "--silent", "--show-error", "-o", path, url],
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `curl.exe download failed: ${result.stderr || result.exitCode}`,
    );
  }
  return { used: true };
}

/**
 * Infer current platform from Zotero/browser runtime.
 */
export function getRuntimePlatform(): "win" | "mac" | "linux" | "unknown" {
  const runtime = globalThis as typeof globalThis & {
    AppConstants?: { platform?: string };
    Services?: { appinfo?: { OS?: string } };
    navigator?: { platform?: string };
  };
  // Prefer AppConstants.platform which is most reliable in Zotero/Firefox
  const appPlatform = runtime.AppConstants?.platform?.toLowerCase() ?? "";
  if (appPlatform === "win") return "win";
  if (appPlatform === "macosx" || appPlatform === "linux") {
    return appPlatform === "macosx" ? "mac" : "linux";
  }
  // Fallback to OS info
  const value = [runtime.Services?.appinfo?.OS, runtime.navigator?.platform]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (value.includes("darwin") || value.includes("mac")) return "mac";
  if (value.includes("linux")) return "linux";
  if (value.includes("win")) return "win";
  return "unknown";
}

/**
 * Download file by invoking native curl.exe via nsIProcess.
 */
export async function downloadWithNsIProcess(
  url: string,
  path: string,
): Promise<{ used: boolean; reason?: string }> {
  const xpcom = globalThis as typeof globalThis & {
    Components?: typeof Components;
  };
  const classes = xpcom.Components?.classes;
  const interfaces = xpcom.Components?.interfaces;
  if (!classes || !interfaces) {
    return { used: false, reason: "no Components classes/interfaces" };
  }

  const curlPath = await findCurlPath();
  if (!curlPath) {
    return { used: false, reason: "curl.exe not found" };
  }

  const classMap = classes as typeof classes &
    Record<string, { createInstance: (iid: unknown) => nsISupports }>;
  const file = classMap["@mozilla.org/file/local;1"].createInstance(
    interfaces.nsIFile,
  ) as nsIFile;
  file.initWithPath(curlPath);
  const process = classMap["@mozilla.org/process/util;1"].createInstance(
    interfaces.nsIProcess,
  ) as nsIProcess;
  process.init(file);
  process.startHidden = true;
  process.noShell = true;
  const args = ["-L", "--fail", "--silent", "--show-error", "-o", path, url];
  process.run(true, args, args.length);
  if (process.exitValue !== 0) {
    throw new Error(`curl.exe process exited with ${process.exitValue}`);
  }
  const size = await fileSize(path);
  if (size <= 0) {
    throw new Error("curl.exe produced an empty file");
  }
  return { used: true };
}

/**
 * Search for curl.exe in Windows system directories.
 */
export async function findCurlPath(): Promise<string | null> {
  const candidates = [
    "C:\\Windows\\System32\\curl.exe",
    "C:\\Windows\\Sysnative\\curl.exe",
  ];
  for (const path of candidates) {
    if (await fileExists(path)) {
      return path;
    }
  }
  return null;
}

/**
 * Check whether the Zotero runtime can access the specified file path.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return IOUtils.exists(path);
  } catch {
    return false;
  }
}

/**
 * Read file size, returning 0 on failure for diagnostic purposes.
 */
export async function fileSize(path: string): Promise<number> {
  try {
    const stat = await IOUtils.stat(path);
    return stat.size ?? 0;
  } catch {
    return 0;
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
