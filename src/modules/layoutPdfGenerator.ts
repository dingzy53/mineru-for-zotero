import { PDFDocument, rgb, type RGB } from "pdf-lib";
import type { MinerUBoxType, NormalizedBox } from "./domain";

export interface BboxStyle {
  strokeColor: RGB;
  fillColor: RGB;
  borderWidth?: number;
  strokeOpacity?: number;
  fillOpacity?: number;
}

const DEFAULT_STYLE: BboxStyle = {
  strokeColor: rgb(0.13, 0.39, 0.92), // MinerU blue
  fillColor: rgb(0.13, 0.39, 0.92),
  borderWidth: 1,
  strokeOpacity: 0.85,
  fillOpacity: 0.15,
};

const TYPE_STYLES: Record<string, BboxStyle> = {
  title: {
    strokeColor: rgb(0.4, 0.4, 1.0),
    fillColor: rgb(0.4, 0.4, 1.0),
    borderWidth: 1.2,
    strokeOpacity: 0.9,
    fillOpacity: 0.2,
  },
  text: {
    strokeColor: rgb(0.6, 0.0, 0.3),
    fillColor: rgb(0.6, 0.0, 0.3),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.15,
  },
  paragraph: {
    strokeColor: rgb(0.6, 0.0, 0.3),
    fillColor: rgb(0.6, 0.0, 0.3),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.15,
  },
  abstract: {
    strokeColor: rgb(0.6, 0.0, 0.3),
    fillColor: rgb(0.6, 0.0, 0.3),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.15,
  },
  formula: {
    strokeColor: rgb(0.0, 0.8, 0.2),
    fillColor: rgb(0.0, 0.8, 0.2),
    borderWidth: 1,
    strokeOpacity: 0.9,
    fillOpacity: 0.2,
  },
  interline_equation: {
    strokeColor: rgb(0.0, 0.8, 0.2),
    fillColor: rgb(0.0, 0.8, 0.2),
    borderWidth: 1,
    strokeOpacity: 0.9,
    fillOpacity: 0.2,
  },
  inline_equation: {
    strokeColor: rgb(0.0, 0.8, 0.2),
    fillColor: rgb(0.0, 0.8, 0.2),
    borderWidth: 1,
    strokeOpacity: 0.9,
    fillOpacity: 0.2,
  },
  table: {
    strokeColor: rgb(0.8, 0.8, 0.0),
    fillColor: rgb(0.8, 0.8, 0.0),
    borderWidth: 1.2,
    strokeOpacity: 0.9,
    fillOpacity: 0.2,
  },
  image: {
    strokeColor: rgb(0.4, 0.7, 1.0),
    fillColor: rgb(0.4, 0.7, 1.0),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  figure: {
    strokeColor: rgb(0.4, 0.7, 1.0),
    fillColor: rgb(0.4, 0.7, 1.0),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  chart: {
    strokeColor: rgb(0.4, 0.7, 1.0),
    fillColor: rgb(0.4, 0.7, 1.0),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  code: {
    strokeColor: rgb(0.4, 0.0, 0.8),
    fillColor: rgb(0.4, 0.0, 0.8),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  list: {
    strokeColor: rgb(0.16, 0.66, 0.36),
    fillColor: rgb(0.16, 0.66, 0.36),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  index: {
    strokeColor: rgb(0.16, 0.66, 0.36),
    fillColor: rgb(0.16, 0.66, 0.36),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  reference: {
    strokeColor: rgb(0.85, 0.47, 0.02),
    fillColor: rgb(0.85, 0.47, 0.02),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  citation: {
    strokeColor: rgb(0.85, 0.47, 0.02),
    fillColor: rgb(0.85, 0.47, 0.02),
    borderWidth: 1,
    strokeOpacity: 0.85,
    fillOpacity: 0.18,
  },
  discarded: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    borderWidth: 1,
    strokeOpacity: 0.7,
    fillOpacity: 0.15,
  },
  header: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    borderWidth: 1,
    strokeOpacity: 0.7,
    fillOpacity: 0.15,
  },
  footer: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    borderWidth: 1,
    strokeOpacity: 0.7,
    fillOpacity: 0.15,
  },
  page_number: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    borderWidth: 1,
    strokeOpacity: 0.7,
    fillOpacity: 0.15,
  },
  footnote: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    borderWidth: 1,
    strokeOpacity: 0.7,
    fillOpacity: 0.15,
  },
};

export function getBoxStyle(type: MinerUBoxType): BboxStyle {
  const normalized = String(type || "")
    .trim()
    .toLowerCase();
  return TYPE_STYLES[normalized] ?? DEFAULT_STYLE;
}

/**
 * 在原始 PDF 页面上绘制 MinerU 解析得出的布局识别框，生成带框标注 PDF。
 */
export async function generateLayoutPdf(
  pdfBytes: Uint8Array,
  boxes: NormalizedBox[],
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pageCount = pdfDoc.getPageCount();

  for (const box of boxes) {
    const pageIndex = box.page - 1;
    if (pageIndex < 0 || pageIndex >= pageCount) {
      continue;
    }

    const page = pdfDoc.getPage(pageIndex);
    const { width, height } = page.getSize();

    const rectX = Math.max(0, Math.min(width, box.bbox.x * width));
    const rectY = Math.max(
      0,
      Math.min(height, height - (box.bbox.y + box.bbox.height) * height),
    );
    const rectW = Math.max(0, Math.min(width - rectX, box.bbox.width * width));
    const rectH = Math.max(
      0,
      Math.min(height - rectY, box.bbox.height * height),
    );

    if (rectW <= 0 || rectH <= 0) {
      continue;
    }

    const style = getBoxStyle(box.type);

    page.drawRectangle({
      x: rectX,
      y: rectY,
      width: rectW,
      height: rectH,
      borderColor: style.strokeColor,
      borderWidth: style.borderWidth ?? 1,
      borderOpacity: style.strokeOpacity ?? 0.85,
      color: style.fillColor,
      opacity: style.fillOpacity ?? 0.15,
    });
  }

  return await pdfDoc.save();
}
