import { PDFDocument } from "pdf-lib";
import { toNativePath } from "./mineruClient/path";

/**
 * PDF 页数探测。
 *
 * 生产环境走 Zotero 内置的 pdf.js（`resource://zotero/reader/pdf/build/pdf.mjs`），
 * 避免为了数页数而把整个 `pdf-lib` 打进插件。之所以必须拿到页数：官方 MinerU
 * server 单文件上限 200 页（`CHUNK_PAGE_LIMIT`），超过需要按 `page_range` 分块。
 *
 * 为什么不用 `ChromeUtils.importESModule`：Zotero 10 / Gecko 140 的系统模块
 * realm 内置对象被冻结，而 pdf.js 顶层会执行
 * `Map.prototype.getOrInsertComputed = …` 的 polyfill，直接抛
 * `TypeError: Map.prototype is not extensible`。Zotero 的 reader 用的是
 * `<script type="module">` 在普通 realm 里加载 pdf.js；这里等价地在主窗口
 * realm 里用动态 `import()` 加载。
 *
 * Spike 阶段：内置 pdf.js 失败时仍回退 `pdf-lib`，并记录实际使用的路径，
 * 待运行时验证通过后再删除 `pdf-lib`。
 */

const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDFJS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";

/** 主窗口只需暴露 `eval`；实际类型 `MainWindow` 与 DOM `Window` 不重合。 */
type EvalWindow = {
  eval: (source: string) => unknown;
};

/**
 * 使用 Zotero 内置 pdf.js 读取页数；失败返回 `-1`。
 *
 * 计数代码在主窗口 realm 中执行：那里 `Map.prototype` 可扩展，且 `IOUtils`
 * 可直接读取本地文件，避免跨 realm 传递 `Uint8Array`。
 */
export async function getPdfPageCountWithZoteroPdfJs(
  filePath: string,
): Promise<number> {
  const mainWindow = Zotero.getMainWindow?.() as unknown as
    | EvalWindow
    | undefined;
  if (!mainWindow?.eval) {
    return -1;
  }

  const nativePath = toNativePath(filePath);
  const source = `(async () => {
    const pdfjs = await import(${JSON.stringify(PDFJS_MODULE_URL)});
    pdfjs.GlobalWorkerOptions.workerSrc = ${JSON.stringify(PDFJS_WORKER_URL)};
    const bytes = await IOUtils.read(${JSON.stringify(nativePath)});
    const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
    const document = await task.promise;
    const count = document.numPages;
    await task.destroy();
    return count;
  })()`;

  try {
    const result = (await mainWindow.eval(source)) as unknown;
    return typeof result === "number" && result > 0 ? result : -1;
  } catch (error) {
    ztoolkit.log("Failed to get pdf page count via Zotero pdf.js", error);
    return -1;
  }
}

export async function getPdfPageCount(filePath: string): Promise<number> {
  const viaPdfJs = await getPdfPageCountWithZoteroPdfJs(filePath);
  if (viaPdfJs > 0) {
    ztoolkit.log(`MinerU page count source=pdfjs pages=${viaPdfJs}`);
    return viaPdfJs;
  }

  // Spike fallback: remove once the built-in pdf.js path is verified.
  try {
    const bytes = await IOUtils.read(toNativePath(filePath));
    const pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
    });
    const count = pdfDoc.getPageCount();
    ztoolkit.log(`MinerU page count source=pdf-lib pages=${count}`);
    return count;
  } catch (e) {
    ztoolkit.log("Failed to get pdf page count via pdf-lib", e);
    return -1;
  }
}
