import { config } from "../../package.json";

export { createZToolkit };

/**
 * Local mini-toolkit replacing `zotero-plugin-toolkit`.
 *
 * The plugin only uses four capabilities: log / getGlobal / Clipboard / unregisterAll.
 * Bundling the full toolkit would add ~122 KB via esbuild with no tree-shaking and
 * register unused global listeners on construction (especially KeyboardManager).
 * This module preserves the `ztoolkit` global shape to keep call sites and test
 * seams unchanged.
 */

/** Prefix for Zotero debug logs to facilitate filtering plugin output. */
const LOG_PREFIX = `[${config.addonName}]`;

type TransferableLike = {
  init(context: unknown): void;
  addDataFlavor(flavor: string): void;
  setTransferData(flavor: string, data: unknown, length?: number): void;
};

type ClipboardServiceLike = {
  setData(transferable: unknown, owner: unknown, whichClipboard: number): void;
};

type XPCClasses = Record<
  string,
  {
    createInstance<T = unknown>(iid: unknown): T;
    getService<T = unknown>(iid: unknown): T;
  }
>;

function xpcClasses(): XPCClasses {
  return Components.classes as unknown as XPCClasses;
}

/**
 * Write plain text or data URL images to the system clipboard.
 *
 * Keeps behavior identical to the toolkit's `ClipboardHelper`: text uses nsISupportsString,
 * and images use `imgITools.decodeImageFromArrayBuffer` + `application/x-moz-nativeimage`.
 */
class Clipboard {
  private transferable: TransferableLike;
  private clipboardService: ClipboardServiceLike;

  constructor() {
    const classes = xpcClasses();
    this.transferable = classes[
      "@mozilla.org/widget/transferable;1"
    ].createInstance<TransferableLike>(Components.interfaces.nsITransferable);
    this.clipboardService = classes[
      "@mozilla.org/widget/clipboard;1"
    ].getService<ClipboardServiceLike>(Components.interfaces.nsIClipboard);
    this.transferable.init(null);
  }

  addText(source: string, type = "text/plain"): this {
    const str = xpcClasses()[
      "@mozilla.org/supports-string;1"
    ].createInstance<nsISupportsString>(
      Components.interfaces.nsISupportsString,
    );
    str.data = source;
    const flavor = type === "text/unicode" ? "text/plain" : type;
    this.transferable.addDataFlavor(flavor);
    this.transferable.setTransferData(flavor, str, source.length * 2);
    return this;
  }

  addImage(source: string): this {
    const parts = source.split(",");
    if (!parts[0].includes("base64")) {
      return this;
    }
    const mime = parts[0].match(/:(.*?);/)?.[1] ?? "image/png";
    const binary = atob(parts[1]);
    let length = binary.length;
    const bytes = new Uint8Array(length);
    while (length--) {
      bytes[length] = binary.charCodeAt(length);
    }
    const imgTools = xpcClasses()[
      "@mozilla.org/image/tools;1"
    ].getService<imgITools>(Components.interfaces.imgITools);
    const image = imgTools.decodeImageFromArrayBuffer(bytes.buffer, mime);
    const flavor = "application/x-moz-nativeimage";
    this.transferable.addDataFlavor(flavor);
    this.transferable.setTransferData(flavor, image, 0);
    return this;
  }

  copy(): this {
    this.clipboardService.setData(
      this.transferable,
      null,
      Components.interfaces.nsIClipboard.kGlobalClipboard,
    );
    return this;
  }
}

/** Convert arbitrary log arguments to readable text. */
function formatLogData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Error) {
    return data.stack || data.message;
  }
  if (typeof data === "object" && data !== null) {
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
  return String(data);
}

/** Write unified Zotero debug output; failures must not affect the caller. */
function log(...data: unknown[]): void {
  if (data.length === 0) {
    return;
  }
  try {
    Zotero.debug(`${LOG_PREFIX} ${data.map(formatLogData).join("\n")}`);
  } catch {
    // Diagnostics are best-effort.
  }
}

/** Check the global scope first, then fall back to the main window, matching toolkit's `getGlobal`. */
function getGlobal<T = unknown>(key: string): T {
  const value = (globalThis as Record<string, unknown>)[key];
  if (typeof value !== "undefined") {
    return value as T;
  }
  try {
    const mainWindow = Zotero.getMainWindow?.() as unknown as
      | Record<string, unknown>
      | undefined;
    return mainWindow?.[key] as T;
  } catch {
    return undefined as T;
  }
}

function createZToolkit() {
  return {
    log,
    getGlobal,
    Clipboard,
    // The local toolkit registers nothing; keep this method for backward compatibility with existing unload calls.
    unregisterAll: (): void => {},
  };
}
