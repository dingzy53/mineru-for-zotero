import { formatBoxesForCopy } from "../copyFormatter";
import { getMinerUStorageRoot } from "../preferenceScript";
import { createStorage } from "../storage";
import type { AttachmentRef } from "../domain";
import type { NormalizedBox } from "./types";
import { getReaderOverlayStateForReader } from "./state";
import { getReaderAttachmentRef } from "./windows";

/** Copies selected boxes for the current reader; falls back to copying full markdown if none are selected. */
export async function copySelectedBoxesForReader(
  reader: _ZoteroTypes.ReaderInstance,
): Promise<string | null> {
  const state = getReaderOverlayStateForReader(reader);
  const attachment = getReaderAttachmentRef(reader);
  if (!state || !attachment) {
    return null;
  }

  const storage = createStorage(getMinerUStorageRoot());
  const text =
    state.selectedRawIndexes.size === 0
      ? await storage.readPreferredMarkdown(attachment)
      : formatSelectedBoxesForCopy(
          await storage.readBoxes(attachment),
          state.selectedRawIndexes,
        );
  copyText(text);
  return text || null;
}

/** Filters boxes by original rawIndex and reuses unified formatting logic to generate copy text. */
export function formatSelectedBoxesForCopy(
  boxes: NormalizedBox[],
  selectedRawIndexes: Set<number>,
): string {
  return formatBoxesForCopy(
    boxes.filter((box) => selectedRawIndexes.has(box.rawIndex)),
  );
}

/** Writes text to Zotero clipboard; stays silent on empty string. */
export function copyText(text: string): void {
  if (!text) {
    return;
  }
  new ztoolkit.Clipboard().addText(text, "text/unicode").copy();
}

/** Copies parsed image corresponding to visual box, returning true on success. */
export async function copyBoxImageFromStorage(
  box: NormalizedBox,
  attachment: Pick<AttachmentRef, "libraryID" | "key"> | undefined,
): Promise<boolean> {
  if (!attachment || !isImageCopyBox(box)) {
    return false;
  }

  const imagePath = getBoxImagePath(box);
  if (!imagePath) {
    return false;
  }

  try {
    const dataURL = await createStorage(
      getMinerUStorageRoot(),
    ).readImageDataURL(attachment, imagePath);
    if (!dataURL) {
      return false;
    }
    new ztoolkit.Clipboard().addImage(dataURL).copy();
    return true;
  } catch (error) {
    ztoolkit.log("failed to copy MinerU box image", error);
    return false;
  }
}

/** Determines whether the current box should preferentially be copied as an image. */
export function isImageCopyBox(box: NormalizedBox): boolean {
  return [
    "figure",
    "image",
    "image_body",
    "chart",
    "chart_body",
    "table",
    "table_body",
  ].includes(box.type.trim().toLowerCase());
}

/** Extracts the first MinerU image link from box markdown. */
export function extractFirstMinerUImagePath(markdown: string): string | null {
  for (const pattern of [
    /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
  ]) {
    const match = pattern.exec(markdown);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function getBoxImagePath(box: NormalizedBox): string | null {
  const normalizedPath = normalizeBoxImagePath(box.imagePath);
  if (normalizedPath) {
    return normalizedPath;
  }
  return extractFirstMinerUImagePath(box.markdown);
}

function normalizeBoxImagePath(path: string | null | undefined): string | null {
  const value = path?.trim();
  if (!value) {
    return null;
  }
  return value.startsWith("images/") ? value : `images/${value}`;
}
