/** Reader overlay visibility modes exposed by the toolbar. */
export type ReaderOverlayMode = "all" | "hover" | "off";

/** Localized reader toolbar message id. */
export type ReaderMessageId =
  | "reader-clear-selection"
  | "reader-copy-full-markdown"
  | "reader-copy-selected-boxes"
  | "reader-disable-plugin"
  | "reader-mode-group-label"
  | "reader-selected-boxes-label"
  | "reader-show-all-boxes"
  | "reader-show-hover-box"
  | "reader-toolbar-label";

/** Tracks whether the reader toolbar menu is open. */
export interface ReaderToolbarMenuState {
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
}

/** Stores menu state per reader instance. */
export interface ReaderToolbarPanelStore {
  ensure(readerInstanceID: string): ReaderToolbarMenuState;
  isOpen(readerInstanceID: string): boolean;
  toggle(readerInstanceID: string): void;
  close(readerInstanceID: string): void;
  delete(readerInstanceID: string): void;
  clear(): void;
}

/** Describes the position where the toolbar button should be inserted. */
export interface ReaderToolbarAnchor {
  parent: Element;
  after?: Element;
}

/** Holds cleanup handles for a main-window toolbar registration. */
export interface WindowToolbarRegistration {
  cleanup: () => void;
}

/** Holds DOM nodes and cleanup handles for a reader toolbar button. */
export interface ReaderToolbarButtonBinding {
  button: HTMLButtonElement;
  menu: HTMLDivElement;
  win: Window;
  attachmentKey: string;
  cleanup: () => void;
}

/** Holds registered windows and their toolbar lifecycle handles. */
export interface ReaderToolbarRegistration {
  windows: WeakMap<Window, WindowToolbarRegistration>;
  registeredWindows: Set<Window>;
}
