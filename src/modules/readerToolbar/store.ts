import type { ReaderToolbarMenuState, ReaderToolbarPanelStore } from "./types";

/** Creates an open/close state object for a reader toolbar menu. */
export function createReaderToolbarMenuState(): ReaderToolbarMenuState {
  let open = false;
  return {
    /** Returns whether this menu is currently open. */
    isOpen() {
      return open;
    },
    /** Marks this menu as open. */
    open() {
      open = true;
    },
    /** Marks this menu as closed. */
    close() {
      open = false;
    },
    /** Toggles this menu between open and closed states. */
    toggle() {
      open = !open;
    },
  };
}

/** Creates a toolbar menu state store indexed by reader instance. */
export function createReaderToolbarPanelStore(): ReaderToolbarPanelStore {
  const panels = new Map<string, ReaderToolbarMenuState>();
  return {
    /** Retrieves or creates menu state for a reader instance. */
    ensure(readerInstanceID) {
      let state = panels.get(readerInstanceID);
      if (!state) {
        state = createReaderToolbarMenuState();
        panels.set(readerInstanceID, state);
      }
      return state;
    },
    /** Returns whether the menu for a reader instance is open. */
    isOpen(readerInstanceID) {
      return panels.get(readerInstanceID)?.isOpen() ?? false;
    },
    /** Toggles the menu state for a reader instance. */
    toggle(readerInstanceID) {
      this.ensure(readerInstanceID).toggle();
    },
    /** Closes the menu for a reader instance if present. */
    close(readerInstanceID) {
      panels.get(readerInstanceID)?.close();
    },
    /** Deletes menu state associated with a reader instance. */
    delete(readerInstanceID) {
      panels.delete(readerInstanceID);
    },
    /** Clears all stored reader menu states. */
    clear() {
      panels.clear();
    },
  };
}
