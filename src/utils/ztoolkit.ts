import { config } from "../../package.json";

export { createZToolkit };

/**
 * 本地 mini-toolkit，替代 `zotero-plugin-toolkit`。
 *
 * 插件只用到 log / getGlobal / Clipboard / unregisterAll 四项能力，而整包
 * toolkit 会让 esbuild 打进 ~122 KB 且无法 tree-shake，并在构造时注册一整套
 * 未使用的全局监听（尤其 KeyboardManager）。这里保留同名同形的 `ztoolkit`
 * 全局对象，使所有调用点与测试缝无需改动。
 */

/** Zotero 调试输出前缀，便于过滤本插件日志。 */
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
 * 把文本或 data URL 图片写入系统剪贴板。
 *
 * 逻辑与 toolkit 的 `ClipboardHelper` 保持一致：文本走 nsISupportsString，
 * 图片走 `imgITools.decodeImageFromArrayBuffer` + `application/x-moz-nativeimage`。
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

/** 将任意日志参数转换为可读文本。 */
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

/** 统一写 Zotero 调试输出；任何失败都不应影响调用方。 */
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

/** 先查全局作用域，再回退主窗口，行为与 toolkit 的 `getGlobal` 一致。 */
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
    // 本地 toolkit 不注册任何东西，保留该方法以兼容既有卸载调用。
    unregisterAll: (): void => {},
  };
}
