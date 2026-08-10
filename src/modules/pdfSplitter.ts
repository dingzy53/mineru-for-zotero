import { toNativePath } from "./mineruClient/path";
import { PDFDocument } from "pdf-lib";

export async function runPdftkCommand(args: string[]): Promise<string> {
  let Subprocess: any;
  try {
    Subprocess = (globalThis as any).ChromeUtils.importESModule(
      "resource://gre/modules/Subprocess.sys.mjs",
    ).Subprocess;
  } catch (e) {
    try {
      Subprocess = (globalThis as any).ChromeUtils.import(
        "resource://gre/modules/Subprocess.jsm",
      ).Subprocess;
    } catch (e2) {
      throw new Error("Subprocess not available");
    }
  }

  async function readAll(pipe: any) {
    let result = "";
    let chunk;
    while ((chunk = await pipe.readString())) {
      result += chunk;
    }
    return result;
  }

  if (Subprocess) {
    // Try native pdftk first
    try {
      const proc = await Subprocess.call({
        command: "pdftk",
        arguments: args,
      });
      const output = await readAll(proc.stdout);
      await proc.wait();
      return output;
    } catch (e) {
      // On macOS/Linux, try common absolute paths since GUI apps don't inherit PATH
      const isWindows =
        (globalThis as any).AppConstants?.platform === "win" ||
        ((globalThis as any).Services?.appinfo?.OS || "")
          .toLowerCase()
          .includes("win");
      if (isWindows) {
        throw e;
      }

      const commonPaths = [
        "/opt/homebrew/bin/pdftk",
        "/opt/homebrew/pdftk",
        "/usr/local/bin/pdftk",
        "/usr/bin/pdftk",
      ];

      let lastError = e;
      for (const pdftkPath of commonPaths) {
        try {
          const proc = await Subprocess.call({
            command: pdftkPath,
            arguments: args,
          });
          const output = await readAll(proc.stdout);
          await proc.wait();
          return output;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    }
  }
  throw new Error("Subprocess execution failed completely");
}

export async function getPdfPageCount(filePath: string): Promise<number> {
  const nativePath = toNativePath(filePath);

  try {
    const uint8Array = await IOUtils.read(nativePath);
    const pdfDoc = await PDFDocument.load(uint8Array, {
      ignoreEncryption: true,
    });
    return pdfDoc.getPageCount();
  } catch (e) {
    ztoolkit.log("Failed to get pdf page count via pdf-lib, trying pdftk", e);
  }

  // Fallback to pdftk
  try {
    const output = await runPdftkCommand([nativePath, "dump_data"]);
    const match = output.match(/NumberOfPages:\s*(\d+)/);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
  } catch (e) {
    ztoolkit.log("Failed to get pdf page count via pdftk", e);
  }

  return -1;
}

export async function splitPdf(
  filePath: string,
  targetPath: string,
  startPage: number, // 1-indexed
  endPage: number, // 1-indexed
): Promise<boolean> {
  const nativePath = toNativePath(filePath);
  const nativeTarget = toNativePath(targetPath);

  try {
    const uint8Array = await IOUtils.read(nativePath);

    const pdfDoc = await PDFDocument.load(uint8Array, {
      ignoreEncryption: true,
    });
    const newPdfDoc = await PDFDocument.create();

    const pageIndices = [];
    for (let i = startPage - 1; i < endPage; i++) {
      pageIndices.push(i);
    }

    const copiedPages = await newPdfDoc.copyPages(pdfDoc, pageIndices);
    for (const page of copiedPages) {
      newPdfDoc.addPage(page);
    }

    const pdfBytes = await newPdfDoc.save();
    await IOUtils.write(nativeTarget, pdfBytes);
    return true;
  } catch (e) {
    ztoolkit.log("Failed to split pdf via pdf-lib, trying pdftk", e);
  }

  // Fallback to pdftk
  try {
    await runPdftkCommand([
      nativePath,
      "cat",
      `${startPage}-${endPage}`,
      "output",
      nativeTarget,
    ]);
    return true;
  } catch (e) {
    ztoolkit.log("Failed to split pdf via pdftk", e);
  }

  return false;
}
