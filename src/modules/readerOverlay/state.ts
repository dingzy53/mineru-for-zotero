import { removeReaderOverlayRoot } from "./render";
import type {
  OverlayMode,
  ReaderOverlayKey,
  ReaderOverlayState,
} from "./types";
import { getReaderAttachmentKey } from "./windows";

export const fallbackStates = new Map<ReaderOverlayKey, ReaderOverlayState>();

/** Generates a unique overlay key from reader instance and attachment. */
export function getReaderOverlayKey(
  readerInstanceID: string,
  attachmentKey: string,
): ReaderOverlayKey {
  return `${readerInstanceID}:${attachmentKey}`;
}

/** Retrieves or creates overlay state for the specified attachment. */
export function getReaderOverlayState(
  readerInstanceID: string,
  attachmentKey: string,
): ReaderOverlayState {
  const key = getReaderOverlayKey(readerInstanceID, attachmentKey);
  const states = getOverlayStates();
  const existing = states.get(key);
  if (existing) {
    ensureReaderOverlayStateMaps(existing);
    return existing;
  }

  const state: ReaderOverlayState = {
    key,
    readerInstanceID,
    attachmentKey,
    mode: "off",
    selectedRawIndexes: new Set<number>(),
    selectionAnchorRawIndex: null,
    hoverRawIndex: null,
    selectPanelActive: false,
    formulaMenuActive: false,
    root: null,
    rootsByWindow: new Map<Window, HTMLElement>(),
    cleanupPositioning: null,
    cleanupPositioningByWindow: new Map<Window, () => void>(),
    renderRevision: 0,
  };
  states.set(key, state);
  return state;
}

/** Returns the corresponding overlay state for the reader's current attachment. */
export function getReaderOverlayStateForReader(
  reader: _ZoteroTypes.ReaderInstance,
): ReaderOverlayState | null {
  const attachmentKey = getReaderAttachmentKey(reader);
  if (!attachmentKey) {
    return null;
  }
  return getReaderOverlayState(reader._instanceID, attachmentKey);
}

/** Updates the reader's overlay mode without triggering a re-render. */
export function setReaderOverlayModeForReader(
  reader: _ZoteroTypes.ReaderInstance,
  mode: OverlayMode,
): ReaderOverlayState | null {
  const state = getReaderOverlayStateForReader(reader);
  if (!state) {
    return null;
  }
  state.mode = mode;
  return state;
}

/** Records the latest root for the current reader and synchronizes it to the window-indexed root map. */
export function setReaderOverlayRootForReader(
  reader: _ZoteroTypes.ReaderInstance,
  root: HTMLElement | null,
): ReaderOverlayState | null {
  const state = getReaderOverlayStateForReader(reader);
  if (!state) {
    return null;
  }
  state.root = root;
  if (root) {
    const win = root.ownerDocument?.defaultView ?? null;
    if (win) {
      ensureReaderOverlayStateMaps(state).rootsByWindow.set(win, root);
    }
  }
  return state;
}

/** Returns the count of selected boxes for the current reader. */
export function getReaderSelectedBoxCount(
  reader: _ZoteroTypes.ReaderInstance,
): number {
  return getReaderOverlayStateForReader(reader)?.selectedRawIndexes.size ?? 0;
}

/** Destroys overlay state and associated roots for the specified key. */
export function destroyReaderOverlay(key: ReaderOverlayKey): void {
  const state = getOverlayStates().get(key);
  if (!state) {
    return;
  }
  state.renderRevision += 1;
  cleanupReaderOverlayRoot(state);
  getOverlayStates().delete(key);
}

/** Destroys all overlay states under a reader instance. */
export function destroyReaderOverlaysForReader(
  reader: _ZoteroTypes.ReaderInstance,
): void {
  destroyReaderOverlaysByReaderID(reader._instanceID);
}

/** Destroys all corresponding overlay states by reader instance ID. */
export function destroyReaderOverlaysByReaderID(
  readerInstanceID: string,
): void {
  const states = getOverlayStates();
  for (const [key, state] of getOverlayStates()) {
    if (state.readerInstanceID === readerInstanceID) {
      state.renderRevision += 1;
      cleanupReaderOverlayRoot(state);
      states.delete(key);
    }
  }
}

/** Destroys all overlay states within the current plugin process. */
export function destroyAllReaderOverlays(): void {
  for (const state of getOverlayStates().values()) {
    state.renderRevision += 1;
    cleanupReaderOverlayRoot(state);
  }
  getOverlayStates().clear();
}

/** Cleans up roots and positioning cleanup references held in state. */
export function cleanupReaderOverlayRoot(state: ReaderOverlayState): void {
  ensureReaderOverlayStateMaps(state);
  state.selectPanelActive = false;
  state.formulaMenuActive = false;
  const hadPositioningByWindow = state.cleanupPositioningByWindow.size > 0;
  const hadRootsByWindow = state.rootsByWindow.size > 0;
  for (const cleanup of state.cleanupPositioningByWindow.values()) {
    cleanup();
  }
  state.cleanupPositioningByWindow.clear();
  for (const root of state.rootsByWindow.values()) {
    removeReaderOverlayRoot(root);
  }
  state.rootsByWindow.clear();
  if (!hadPositioningByWindow) {
    state.cleanupPositioning?.();
  }
  state.cleanupPositioning = null;
  if (!hadRootsByWindow) {
    removeReaderOverlayRoot(state.root);
  }
  state.root = null;
}

/** Ensures legacy state always contains newly split window map fields. */
export function ensureReaderOverlayStateMaps(
  state: ReaderOverlayState,
): ReaderOverlayState {
  state.rootsByWindow ??= new Map<Window, HTMLElement>();
  state.cleanupPositioningByWindow ??= new Map<Window, () => void>();
  state.selectPanelActive ??= false;
  state.formulaMenuActive ??= false;
  return state;
}

/** Validates that the current state still corresponds to the same render request round. */
export function isCurrentRenderState(
  state: ReaderOverlayState,
  revision: number,
  mode: OverlayMode,
): mode is Exclude<OverlayMode, "off"> {
  return (
    getOverlayStates().get(state.key) === state &&
    state.renderRevision === revision &&
    state.mode === mode &&
    mode !== "off"
  );
}

/** Returns the overlay state container held by the plugin runtime. */
export function getOverlayStates(): Map<ReaderOverlayKey, ReaderOverlayState> {
  if (typeof addon === "undefined") {
    return fallbackStates;
  }

  addon.data.readerOverlays ??= new Map<ReaderOverlayKey, ReaderOverlayState>();
  return addon.data.readerOverlays;
}
