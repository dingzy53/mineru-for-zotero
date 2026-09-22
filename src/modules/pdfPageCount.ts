import { PDFDocument } from "pdf-lib";
import { toNativePath } from "./mineruClient/path";

/**
 * 使用纯 JS 的 pdf-lib 读取 PDF 页数。
 *
 * MinerU 4 的 V1 API 通过 `files[].page_range` 处理大文件分片，插件不再在
 * 本地切分 PDF，只保留页数探测用于决定分片数量。
 */
export async function getPdfPageCount(filePath: string): Promise<number> {
  try {
    const bytes = await IOUtils.read(toNativePath(filePath));
    const pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
    });
    return pdfDoc.getPageCount();
  } catch (e) {
    ztoolkit.log("Failed to get pdf page count via pdf-lib", e);
    return -1;
  }
}
