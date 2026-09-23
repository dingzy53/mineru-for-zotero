import { getReaderOverlayStateForReader } from "./state";

/** Determines whether the current reader's overlay root set needs to re-synchronize windows. */
export function readerOverlayNeedsWindowSync(
  reader: _ZoteroTypes.ReaderInstance,
): boolean {
  const state = getReaderOverlayStateForReader(reader);
  if (!state || state.mode === "off") {
    return false;
  }

  const windows = getReaderOverlayWindows(reader);
  if (windows.length !== state.rootsByWindow.size) {
    return true;
  }

  return windows.some((win) => !state.rootsByWindow.has(win));
}

/** Returns the overlay window that the current reader should ultimately operate on. */
export function getReaderOverlayWindow(
  reader: _ZoteroTypes.ReaderInstance,
): Window | null {
  return getReaderOverlayWindows(reader).at(-1) ?? null;
}

/** Enumerates all windows corresponding to the reader and its same-origin nested iframes. */
export function getReaderOverlayWindows(
  reader: _ZoteroTypes.ReaderInstance,
): Window[] {
  const windows = new Set<Window>();
  for (const view of getReaderViews(reader)) {
    const win = view?._iframeWindow ?? null;
    if (win) {
      addReaderOverlayWindowWithDescendants(windows, win);
    }
  }

  if (reader._iframeWindow) {
    addReaderOverlayWindowWithDescendants(windows, reader._iframeWindow);
  }

  return [...windows];
}

/** Recursively adds current window and its same-origin child frames to the window set. */
export function addReaderOverlayWindowWithDescendants(
  windows: Set<Window>,
  win: Window,
): void {
  if (windows.has(win)) {
    return;
  }
  windows.add(win);

  const doc = getWindowDocument(win);
  const frames =
    typeof doc?.querySelectorAll === "function"
      ? (Array.from(doc.querySelectorAll("iframe, frame")) as Element[])
      : [];
  for (const frame of frames) {
    const childWindow = getFrameContentWindow(frame);
    if (childWindow) {
      addReaderOverlayWindowWithDescendants(windows, childWindow);
    }
  }
}

/** Safely reads frame contentWindow, accepting only accessible and ready same-origin windows. */
export function getFrameContentWindow(frame: Element): Window | null {
  try {
    const win = (frame as HTMLIFrameElement | HTMLFrameElement).contentWindow;
    if (!win?.document?.documentElement) {
      return null;
    }
    return win;
  } catch {
    return null;
  }
}

/** Collects the set of views exposed by Zotero reader across different versions and split views. */
export function getReaderViews(
  reader: _ZoteroTypes.ReaderInstance,
): Array<{ _iframeWindow?: Window | null } | null> {
  const value = reader as _ZoteroTypes.ReaderInstance & {
    _views?: Array<{ _iframeWindow?: Window | null }>;
    _readerViews?: Array<{ _iframeWindow?: Window | null }>;
    _secondaryView?: { _iframeWindow?: Window | null };
  };
  const view = (reader._lastView ?? reader._primaryView ?? null) as {
    _iframeWindow?: Window | null;
  } | null;

  return [
    ...(Array.isArray(value._views) ? value._views : []),
    ...(Array.isArray(value._readerViews) ? value._readerViews : []),
    reader._primaryView as { _iframeWindow?: Window | null } | null,
    value._secondaryView ?? null,
    view,
  ];
}

/** Returns the window chain that positioning needs to monitor for keyboard and pointer events. */
export function getReaderOverlayEventWindows(win: Window): Window[] {
  const windows = new Set<Window>();
  let current: Window | null = win;
  while (current && !windows.has(current)) {
    windows.add(current);
    const parent = getParentWindow(current);
    if (!parent || parent === current) {
      break;
    }
    current = parent;
  }
  return [...windows];
}

/** Safely reads window.document, avoiding cross-origin or dead object exceptions. */
export function getWindowDocument(win: Window): Document | null {
  try {
    return win.document ?? null;
  } catch {
    return null;
  }
}

/** Safely reads the parent window reference. */
export function getParentWindow(win: Window): Window | null {
  try {
    return win.parent ?? null;
  } catch {
    return null;
  }
}

/** Resolves key from the reader's current attachment. */
export function getReaderAttachmentKey(
  reader: _ZoteroTypes.ReaderInstance,
): string | null {
  const key = reader._item?.key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Returns attachment reference information required for storage access. */
export function getReaderAttachmentRef(
  reader: _ZoteroTypes.ReaderInstance,
): { libraryID: number; key: string } | null {
  const item = reader._item;
  const key = item?.key;
  const libraryID = item?.libraryID;
  if (typeof key !== "string" || !key || typeof libraryID !== "number") {
    return null;
  }
  return { libraryID, key };
}

/** Returns the reader document container where the overlay root should be mounted. */
export function getReaderOverlayMountContainer(doc: Document): Element | null {
  return doc.body ?? doc.documentElement;
}
