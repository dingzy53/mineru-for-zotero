import { PDFDocument } from "pdf-lib";
import { toNativePath } from "./mineruClient/path";

/**
 * PDF 页数探测。
 *
 * 生产环境走 Zotero 内置的 pdf.js（`resource://zotero/reader/pdf/build/pdf.mjs`），
 * 避免为了数页数而把整个 `pdf-lib` 打进插件。之所以必须拿到页数：官方 MinerU
 * server 单文件上限 200 页（`CHUNK_PAGE_LIMIT`），超过需要按 `page_range` 分块。
 *
 * Spike 阶段：内置 pdf.js 失败时仍回退 `pdf-lib`，并记录实际使用的路径，
 * 待运行时验证通过后再删除 `pdf-lib`。
 */

const PDFJS_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDFJS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";

type PdfJsDocument = {
  numPages?: number;
};

type PdfJsLoadingTask = {
  promise: Promise<PdfJsDocument>;
  destroy?: () => Promise<void>;
};

type PdfJsModule = {
  getDocument: (src: {
    data: Uint8Array;
    isEvalSupported?: boolean;
  }) => PdfJsLoadingTask;
  GlobalWorkerOptions?: { workerSrc?: string };
};

let cachedPdfJs: PdfJsModule | null | undefined;

/** 惰性加载 Zotero 内置 pdf.js；不可用时返回 null 并缓存结果。 */
function loadZoteroPdfJs(): PdfJsModule | null {
  if (cachedPdfJs !== undefined) {
    return cachedPdfJs;
  }

  try {
    const chromeUtils = (
      globalThis as typeof globalThis & {
        ChromeUtils?: {
          importESModule?: (uri: string) => unknown;
        };
      }
    ).ChromeUtils;
    const module = chromeUtils?.importESModule?.(PDFJS_MODULE_URL) as
      | PdfJsModule
      | undefined;
    if (typeof module?.getDocument === "function") {
      if (module.GlobalWorkerOptions) {
        module.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      }
      cachedPdfJs = module;
    } else {
      cachedPdfJs = null;
    }
  } catch (error) {
    ztoolkit.log("Zotero pdf.js module unavailable", error);
    cachedPdfJs = null;
  }

  return cachedPdfJs;
}

/** 使用 Zotero 内置 pdf.js 读取页数；失败返回 `-1`。 */
export async function getPdfPageCountWithZoteroPdfJs(
  filePath: string,
): Promise<number> {
  const pdfjs = loadZoteroPdfJs();
  if (!pdfjs) {
    return -1;
  }

  let loadingTask: PdfJsLoadingTask | undefined;
  try {
    const bytes = await IOUtils.read(toNativePath(filePath));
    loadingTask = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
    const document = await loadingTask.promise;
    const count = document?.numPages;
    return typeof count === "number" && count > 0 ? count : -1;
  } catch (error) {
    ztoolkit.log("Failed to get pdf page count via Zotero pdf.js", error);
    return -1;
  } finally {
    try {
      await loadingTask?.destroy?.();
    } catch {
      // pdf.js cleanup is best-effort.
    }
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
