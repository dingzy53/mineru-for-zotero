import { toNativePath } from "./mineruClient/path";

/**
 * PDF 页数探测。
 *
 * 使用 Zotero 内置的 pdf.js（`resource://zotero/reader/pdf/build/pdf.mjs`），
 * 避免为了数页数而把整个 `pdf-lib` 打进插件。之所以必须拿到页数：官方 MinerU
 * server 单文件上限 200 页（`CHUNK_PAGE_LIMIT`），超过需要按 `page_range` 分块。
 *
 * 为什么不用 `ChromeUtils.importESModule`：Zotero 10 / Gecko 140 的系统模块
 * realm 内置对象被冻结，而 pdf.js 顶层会执行
 * `Map.prototype.getOrInsertComputed = …` 的 polyfill，直接抛
 * `TypeError: Map.prototype is not extensible`。Zotero 的 reader 用的是
 * `<script type="module">` 在普通 realm 里加载 pdf.js；这里等价地在主窗口
 * realm 里用动态 `import()` 加载，并通过 `Zotero.getMainWindow().eval(...)`
 * 让代码在该 realm 执行（与 Tools → Developer → Run JavaScript 机制一致）。
 *
 * 计数代码把文件路径作为字符串传入，在窗口 realm 内用 `IOUtils.read()` 读取，
 * 避免跨 realm 传递 `Uint8Array`。任何失败都返回 `-1`，调用方会退化为整篇解析。
 */

const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDFJS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";

/** 主窗口只需暴露 `eval`；实际类型 `MainWindow` 与 DOM `Window` 不重合。 */
type EvalWindow = {
  eval: (source: string) => unknown;
};

export async function getPdfPageCount(filePath: string): Promise<number> {
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
    if (typeof result === "number" && result > 0) {
      ztoolkit.log(`MinerU page count source=pdfjs pages=${result}`);
      return result;
    }
    return -1;
  } catch (error) {
    ztoolkit.log("Failed to get pdf page count via Zotero pdf.js", error);
    return -1;
  }
}
