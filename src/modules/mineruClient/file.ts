import { MinerUFileAccessError } from "./errors";
import { errorMessage } from "./http";
import { toNativePath } from "./path";

/**
 * Read PDF bytes, converting underlying file access failures to MinerUFileAccessError.
 */
export async function readPdfBytes(
  readBinary: (filePath: string) => Promise<Uint8Array>,
  filePath: string,
): Promise<Uint8Array> {
  try {
    return await readBinary(filePath);
  } catch (error) {
    throw new MinerUFileAccessError(filePath, errorMessage(error));
  }
}

/**
 * Read local file bytes using file APIs available in the Zotero runtime.
 */
export async function readFileBytes(filePath: string): Promise<Uint8Array> {
  if (typeof IOUtils !== "undefined") {
    return IOUtils.read(toNativePath(filePath));
  }
  return OS.File.read(toNativePath(filePath)) as Promise<Uint8Array>;
}
