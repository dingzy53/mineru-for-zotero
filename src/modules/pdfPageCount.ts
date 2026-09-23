import { toNativePath } from "./mineruClient/path";

/**
 * PDF page count detection.
 *
 * Uses Zotero's bundled pdf.js (`resource://zotero/reader/pdf/build/pdf.mjs`)
 * to avoid bundling the heavy `pdf-lib` into the plugin. Knowing the page count
 * is necessary because the official MinerU server has a 200-page limit per file
 * (`CHUNK_PAGE_LIMIT`), beyond which chunking by `page_range` is required.
 *
 * Why not `ChromeUtils.importESModule`: in Zotero 10 / Gecko 140, system module
 * realm built-ins are frozen, while pdf.js's top level executes a polyfill
 * `Map.prototype.getOrInsertComputed = ...`, throwing
 * `TypeError: Map.prototype is not extensible`. Zotero's own reader loads pdf.js
 * using `<script type="module">` in a standard content realm. Equivalently, we use
 * a dynamic `import()` in the main window realm and execute it via
 * `Zotero.getMainWindow().eval(...)` (matching Tools → Developer → Run JavaScript).
 *
 * The page counting code passes the file path as a string and reads it via
 * `IOUtils.read()` within the window realm to avoid passing `Uint8Array` across realms.
 * Any failure returns `-1`, causing the caller to fall back to unchunked full parsing.
 */

const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDFJS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";

/** The main window only needs to expose `eval`; actual `MainWindow` type differs from DOM `Window`. */
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
