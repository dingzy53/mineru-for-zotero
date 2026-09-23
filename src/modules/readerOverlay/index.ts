import { getMinerUStorageRoot } from "../preferenceScript";
import { createStorage } from "../storage";
import { logReaderOverlayDiagnostic } from "./diagnostics";
import { showReaderOverlayNotice } from "./notice";
import {
  createReaderOverlayPositioningController,
  positionPageLayers,
} from "./positioning";
import { buildReaderOverlayRoot } from "./render";
import { setHoveredBox, syncSelectedBoxClasses } from "./selection";
import {
  cleanupReaderOverlayRoot,
  destroyReaderOverlay,
  getReaderOverlayStateForReader,
  isCurrentRenderState,
  setReaderOverlayModeForReader,
} from "./state";
import { ensureReaderOverlayStyles } from "./styles";
import type { NormalizedBox, ReaderOverlayState } from "./types";
import {
  getReaderAttachmentRef,
  getReaderOverlayMountContainer,
  getReaderOverlayWindows,
} from "./windows";

export { copySelectedBoxesForReader, formatSelectedBoxesForCopy } from "./copy";
export { getReaderOverlayNoticeText } from "./notice";
export {
  createFallbackPageRect,
  createReaderOverlayPositioningController,
  findPageElement,
  positionPageLayers,
} from "./positioning";
export {
  buildReaderOverlayRoot,
  computeBoxStyle,
  createBoxIndexBadge,
  getBoxIndexLabel,
  removeReaderOverlayRoot,
} from "./render";
export { clearReaderOverlaySelectionForReader } from "./selection";
export {
  destroyAllReaderOverlays,
  destroyReaderOverlay,
  destroyReaderOverlaysByReaderID,
  destroyReaderOverlaysForReader,
  getReaderOverlayKey,
  getReaderOverlayState,
  getReaderOverlayStateForReader,
  getReaderSelectedBoxCount,
  setReaderOverlayModeForReader,
  setReaderOverlayRootForReader,
} from "./state";
export { ensureReaderOverlayStyles } from "./styles";
export {
  getReaderOverlayWindow,
  getReaderOverlayWindows,
  readerOverlayNeedsWindowSync,
} from "./windows";
export type {
  PageRect,
  ReaderOverlayBoxStyle,
  ReaderOverlayKey,
  ReaderOverlayPositioningController,
  ReaderOverlayPositioningControllerOptions,
  ReaderOverlaySelectionOptions,
  ReaderOverlayState,
} from "./types";

/** Sets the reader overlay mode and triggers the corresponding re-render. */
export async function applyReaderOverlayMode(
  reader: _ZoteroTypes.ReaderInstance,
  mode: import("./types").OverlayMode,
): Promise<ReaderOverlayState | null> {
  const state = setReaderOverlayModeForReader(reader, mode);
  if (!state) {
    return null;
  }
  state.renderRevision += 1;
  await renderReaderOverlayForReader(reader, state.renderRevision);
  return state;
}

/** Reads boxes for the current attachment and renders the overlay into all relevant reader windows. */
export async function renderReaderOverlayForReader(
  reader: _ZoteroTypes.ReaderInstance,
  expectedRevision?: number,
): Promise<ReaderOverlayState | null> {
  const state = getReaderOverlayStateForReader(reader);
  if (!state) {
    return null;
  }

  const revision = expectedRevision ?? state.renderRevision;
  const mode = state.mode;
  if (mode === "off") {
    destroyReaderOverlay(state.key);
    return state;
  }

  const windows = getReaderOverlayWindows(reader);
  const attachment = getReaderAttachmentRef(reader);
  if (windows.length === 0 || !attachment) {
    cleanupReaderOverlayRoot(state);
    state.root = null;
    return state;
  }

  let boxes: NormalizedBox[];
  try {
    boxes = await createStorage(getMinerUStorageRoot()).readBoxes(attachment);
  } catch (error) {
    logReaderOverlayDiagnostic("failed to read MinerU boxes", {
      readerInstanceID: reader._instanceID,
      attachmentKey: attachment.key,
      error: error instanceof Error ? error.message : String(error),
    });
    showReaderOverlayNotice("reader-overlay-missing-result");
    state.mode = "off";
    cleanupReaderOverlayRoot(state);
    state.root = null;
    return state;
  }

  if (!isCurrentRenderState(state, revision, mode)) {
    return state;
  }

  cleanupReaderOverlayRoot(state);
  for (const win of windows) {
    const doc = win.document ?? null;
    if (!doc?.documentElement) {
      continue;
    }

    const mountContainer = getReaderOverlayMountContainer(doc);
    const selectionOptions = createSelectionOptions(state, attachment);
    const { root, cleanup: cleanupObserver } = buildReaderOverlayRoot(
      doc,
      boxes,
      mode,
      selectionOptions,
    );
    ensureReaderOverlayStyles(doc);
    positionPageLayers(doc, root);
    mountContainer?.append(root);

    const cleanupPositioning = createReaderOverlayPositioningController({
      doc,
      win,
      root,
      reposition: () => positionPageLayers(doc, root),
      selectionOptions,
    }).cleanup;
    const cleanup = () => {
      cleanupObserver();
      cleanupPositioning();
    };
    state.rootsByWindow.set(win, root);
    state.cleanupPositioningByWindow.set(win, cleanup);
    state.root = root;
    state.cleanupPositioning = cleanup;
  }
  return state;
}

/** Constructs shared selection options for rendering and positioning based on the current state. */
function createSelectionOptions(
  state: ReaderOverlayState,
  attachment: { libraryID: number; key: string },
): import("./types").ReaderOverlaySelectionOptions {
  return {
    attachment,
    selectedRawIndexes: state.selectedRawIndexes,
    getSelectionAnchorRawIndex: () => state.selectionAnchorRawIndex,
    setSelectionAnchorRawIndex: (rawIndex) => {
      state.selectionAnchorRawIndex = rawIndex;
    },
    onSelectionChange: () => syncSelectedBoxClasses(state),
    isSelectPanelActive: () => state.selectPanelActive,
    onSelectPanelActiveChange: (active) => {
      syncSelectPanelActiveClasses(state, active);
    },
    isFormulaMenuActive: () => state.formulaMenuActive,
    onFormulaMenuActiveChange: (active) => {
      syncFormulaMenuActiveClasses(state, active);
    },
  };
}

/** Synchronizes the select-copy panel interaction lock to prevent split/iframe roots from continuing to activate underlying boxes. */
function syncSelectPanelActiveClasses(
  state: ReaderOverlayState,
  active: boolean,
): void {
  state.selectPanelActive = active;
  for (const root of state.rootsByWindow.values()) {
    root.classList.toggle("mineru-copy-select-panel-active", active);
    if (active) {
      setHoveredBox(root, null);
    }
  }
}

/** Synchronizes the formula copy menu interaction lock to prevent boxes beneath floating menus from receiving hover hits. */
function syncFormulaMenuActiveClasses(
  state: ReaderOverlayState,
  active: boolean,
): void {
  state.formulaMenuActive = active;
  for (const root of state.rootsByWindow.values()) {
    root.classList.toggle("mineru-copy-formula-menu-active", active);
    if (active) {
      setHoveredBox(root, null);
    }
  }
}
