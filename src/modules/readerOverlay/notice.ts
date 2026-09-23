import type { FluentMessageId } from "../../../typings/i10n";
import { getString } from "../../utils/locale";

/** Reads overlay localization text and falls back to built-in strings on failure. */
export function readerOverlayString(
  id: FluentMessageId,
  fallback: string,
): string {
  try {
    const value = getString(id);
    if (value && value !== id && !value.endsWith(`-${id}`)) {
      return value;
    }
  } catch {
    // Fall back to built-in text.
  }
  return fallback;
}

export function showReaderOverlayNotice(id: FluentMessageId): void {
  const text = getReaderOverlayNoticeText(id);
  try {
    const mainWin = Zotero.getMainWindow();
    if (mainWin) {
      mainWin.alert(text);
    }
  } catch {
    // Notice dialogs must not interfere with reader interactions.
  }
}

/** Returns overlay notice text with localized fallbacks for key scenarios. */
export function getReaderOverlayNoticeText(id: FluentMessageId): string {
  try {
    const value = getString(id);
    if (value && value !== id) {
      return value;
    }
  } catch {
    // Fall back to built-in text.
  }

  if (id === "reader-overlay-missing-result") {
    return (
      "This PDF does not have a MinerU parse result yet. " +
      "Parse it before enabling boxes."
    );
  }
  if (id === "reader-copy-image-missing") {
    return "This box does not have an image to copy.";
  }
  return id;
}
