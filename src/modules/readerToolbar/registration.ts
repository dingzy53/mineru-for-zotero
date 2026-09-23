import {
  destroyReaderOverlaysByReaderID,
  readerOverlayNeedsWindowSync,
  renderReaderOverlayForReader,
} from "../readerOverlay";
import { ensureReaderToolbarAssetsLoaded } from "./assets";
import {
  cleanupWindowBindings,
  destroyButtonBinding,
  ensureButtonBinding,
  getButtonBindingsSnapshot,
  getWindowReaders,
} from "./binding";
import { createReaderToolbarPanelStore } from "./store";
import type {
  ReaderToolbarPanelStore,
  ReaderToolbarRegistration,
  WindowToolbarRegistration,
} from "./types";

const panelStore = createReaderToolbarPanelStore();

/** Registers MinerU toolbar button integration for a Zotero main window. */
export async function registerReaderToolbar(
  win: _ZoteroTypes.MainWindow,
): Promise<void> {
  await ensureReaderToolbarAssetsLoaded();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  addon.data.readerToolbar ??= {
    windows: new WeakMap<Window, WindowToolbarRegistration>(),
    registeredWindows: new Set<Window>(),
  };

  if (addon.data.readerToolbar.registeredWindows.has(win)) {
    return;
  }

  const registration = registerReaderToolbarWindow(win, panelStore);
  addon.data.readerToolbar.windows.set(win, registration);
  addon.data.readerToolbar.registeredWindows.add(win);
}

/** Unregisters toolbar integration for a single window or all registered windows. */
export function unregisterReaderToolbar(win?: Window): void {
  const registration = addon.data.readerToolbar;
  if (!registration) {
    return;
  }

  if (win && registration.registeredWindows.has(win)) {
    registration.windows.get(win)?.cleanup();
    registration.registeredWindows.delete(win);
  }

  if (!win) {
    for (const registeredWindow of registration.registeredWindows) {
      registration.windows.get(registeredWindow)?.cleanup();
    }
    registration.registeredWindows.clear();
  }

  if (!win || registration.registeredWindows.size === 0) {
    addon.data.readerToolbar = undefined;
    for (const [readerInstanceID] of getButtonBindingsSnapshot()) {
      destroyButtonBinding(readerInstanceID);
    }
    panelStore.clear();
  }
}

/** Starts observer- and timer-based toolbar synchronization for a Zotero main window. */
export function registerReaderToolbarWindow(
  win: _ZoteroTypes.MainWindow,
  store: ReaderToolbarPanelStore = panelStore,
): WindowToolbarRegistration {
  let timer = 0;
  let destroyed = false;
  // Resynchronize toolbar bindings after Zotero modifies the reader toolbar DOM.
  const observer = new win.MutationObserver(() => {
    syncWindowToolbar(win, store);
  });

  /** Observes reader DOM mutations to identify toolbar insertion anchors. */
  const start = () => {
    if (destroyed) {
      return;
    }
    observer.observe(win.document.documentElement, {
      childList: true,
      subtree: true,
    });
    syncWindowToolbar(win, store);
    // Periodically capture reader lifecycle changes not surfaced via DOM mutations.
    timer = win.setInterval(() => {
      syncWindowToolbar(win, store);
    }, 500);
  };

  /** Stops observers, timers, and bindings held for this window. */
  const stop = () => {
    destroyed = true;
    observer.disconnect();
    if (timer) {
      win.clearInterval(timer);
      timer = 0;
    }
    cleanupWindowBindings(win, store);
  };

  start();
  return { cleanup: stop };
}

/** Synchronizes toolbar bindings with currently open PDF readers in the window. */
export function syncWindowToolbar(
  win: _ZoteroTypes.MainWindow,
  store: ReaderToolbarPanelStore = panelStore,
): void {
  const readers = getWindowReaders(win);
  const activeIDs = new Set<string>();

  for (const reader of readers) {
    const binding = ensureButtonBinding(win, reader, store);
    if (binding) {
      activeIDs.add(reader._instanceID);
      if (readerOverlayNeedsWindowSync(reader)) {
        void renderReaderOverlayForReader(reader);
      }
    }
  }

  for (const [readerInstanceID, binding] of getButtonBindingsSnapshot()) {
    if (binding.win !== win) {
      continue;
    }
    if (!activeIDs.has(readerInstanceID)) {
      destroyButtonBinding(readerInstanceID);
      destroyReaderOverlaysByReaderID(readerInstanceID);
      store.delete(readerInstanceID);
    }
  }
}
