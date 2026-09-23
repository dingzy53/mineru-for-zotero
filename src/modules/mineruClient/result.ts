import type { MinerUImageFile } from "../domain";
import { isSafeRelativePath } from "./path";
import type { ZipEntries } from "./types";
import { decodeText } from "./zip";

/**
 * Known middle JSON file names in ZIP archives, ordered by priority.
 */
const MIDDLE_JSON_NAMES = ["middle_json.json", "layout.json"];

/**
 * Read the most appropriate raw JSON result from a MinerU result ZIP.
 */
export function readRawResultFromZip(zip: ZipEntries): unknown | null {
  let firstJson: unknown | null = null;

  for (const [name, entry] of zip) {
    const normalized = name.replace(/\\/g, "/");
    if (normalized === "full.md" || normalized === "markdown.md") {
      continue;
    }
    if (!normalized.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(decodeText(entry.bytes)) as unknown;
      firstJson ??= parsed;
      if (hasPageBoxData(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  for (const candidate of MIDDLE_JSON_NAMES) {
    const entry = zip.get(candidate);
    if (!entry) {
      continue;
    }
    try {
      return JSON.parse(decodeText(entry.bytes)) as unknown;
    } catch {
      continue;
    }
  }

  return firstJson;
}

/**
 * Extract saveable image assets from a MinerU result ZIP.
 */
export function readImagesFromZip(
  zip: ZipEntries,
): MinerUImageFile[] | undefined {
  const images: MinerUImageFile[] = [];
  for (const [name, entry] of zip) {
    const imagePath = getZipImagePath(name);
    if (!imagePath) {
      continue;
    }
    images.push({ path: imagePath, bytes: entry.bytes });
  }
  return images.length > 0 ? images : undefined;
}

/**
 * Read Markdown content from the result ZIP (new member `markdown.md`, legacy `full.md`).
 */
export function readMarkdownFromZip(zip: ZipEntries): string {
  const entry =
    zip.get("markdown.md") ??
    zip.get("full.md") ??
    Array.from(zip.entries()).find(([name]) =>
      name.toLowerCase().endsWith(".md"),
    )?.[1];
  return entry ? decodeText(entry.bytes) : "";
}

/**
 * Convert an in-ZIP image entry into a relative image path for storage.
 */
export function getZipImagePath(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)images\/(.+)$/);
  if (!match) {
    return null;
  }
  const relative = match[1];
  if (!isSafeRelativePath(relative)) {
    return null;
  }
  return relative;
}

/**
 * Determine whether raw MinerU JSON contains normalizable page box data.
 */
export function hasPageBoxData(value: unknown): boolean {
  const raw = value as { pages?: unknown; pdf_info?: unknown };
  const pages = Array.isArray(raw.pages)
    ? raw.pages
    : Array.isArray(raw.pdf_info)
      ? raw.pdf_info
      : [];
  return pages.some((page) => {
    if (!page || typeof page !== "object") {
      return false;
    }
    if (Array.isArray((page as { blocks?: unknown }).blocks)) {
      return (page as { blocks: unknown[] }).blocks.some(hasBlockGeometry);
    }
    const rawPage = page as {
      para_blocks?: unknown;
      layout_dets?: unknown;
    };
    return [rawPage.para_blocks, rawPage.layout_dets].some(
      (blocks) => Array.isArray(blocks) && blocks.some(hasBlockGeometry),
    );
  });
}

/**
 * Determine whether a single block carries bbox or poly geometry information.
 */
export function hasBlockGeometry(value: unknown): boolean {
  const block = value as { bbox?: unknown; poly?: unknown };
  return (
    (Array.isArray(block.bbox) && block.bbox.length >= 4) ||
    (Array.isArray(block.poly) && block.poly.length >= 4)
  );
}
