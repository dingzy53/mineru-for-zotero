import { PDFDocument, rgb, StandardFonts, type RGB } from "pdf-lib";
import type { MinerUBoxType, NormalizedBox } from "./domain";

export interface BboxStyle {
  strokeColor?: RGB;
  fillColor: RGB;
  borderWidth?: number;
  strokeOpacity?: number;
  fillOpacity?: number;
}

const DEFAULT_STYLE: BboxStyle = {
  strokeColor: rgb(0.4, 0.4, 1.0),
  fillColor: rgb(0.4, 0.4, 1.0),
  fillOpacity: 0.3,
};

const TYPE_STYLES: Record<string, BboxStyle> = {
  title: {
    strokeColor: rgb(0.4, 0.4, 1.0),
    fillColor: rgb(0.4, 0.4, 1.0),
    fillOpacity: 0.3,
  },
  text: {
    strokeColor: rgb(0.6, 0.0, 0.298),
    fillColor: rgb(0.6, 0.0, 0.298),
    fillOpacity: 0.3,
  },
  paragraph: {
    strokeColor: rgb(0.6, 0.0, 0.298),
    fillColor: rgb(0.6, 0.0, 0.298),
    fillOpacity: 0.3,
  },
  abstract: {
    strokeColor: rgb(0.6, 0.0, 0.298),
    fillColor: rgb(0.6, 0.0, 0.298),
    fillOpacity: 0.3,
  },
  formula: {
    strokeColor: rgb(0.0, 1.0, 0.0),
    fillColor: rgb(0.0, 1.0, 0.0),
    fillOpacity: 0.3,
  },
  interline_equation: {
    strokeColor: rgb(0.0, 1.0, 0.0),
    fillColor: rgb(0.0, 1.0, 0.0),
    fillOpacity: 0.3,
  },
  inline_equation: {
    strokeColor: rgb(0.0, 1.0, 0.0),
    fillColor: rgb(0.0, 1.0, 0.0),
    fillOpacity: 0.3,
  },
  table: {
    strokeColor: rgb(0.8, 0.8, 0.0),
    fillColor: rgb(0.8, 0.8, 0.0),
    fillOpacity: 0.3,
  },
  table_body: {
    strokeColor: rgb(0.8, 0.8, 0.0),
    fillColor: rgb(0.8, 0.8, 0.0),
    fillOpacity: 0.3,
  },
  table_caption: {
    strokeColor: rgb(1.0, 1.0, 0.4),
    fillColor: rgb(1.0, 1.0, 0.4),
    fillOpacity: 0.3,
  },
  table_footnote: {
    strokeColor: rgb(0.9, 1.0, 0.8),
    fillColor: rgb(0.9, 1.0, 0.8),
    fillOpacity: 0.3,
  },
  image: {
    strokeColor: rgb(0.6, 1.0, 0.2),
    fillColor: rgb(0.6, 1.0, 0.2),
    fillOpacity: 0.3,
  },
  figure: {
    strokeColor: rgb(0.6, 1.0, 0.2),
    fillColor: rgb(0.6, 1.0, 0.2),
    fillOpacity: 0.3,
  },
  image_body: {
    strokeColor: rgb(0.6, 1.0, 0.2),
    fillColor: rgb(0.6, 1.0, 0.2),
    fillOpacity: 0.3,
  },
  image_caption: {
    strokeColor: rgb(0.4, 0.7, 1.0),
    fillColor: rgb(0.4, 0.7, 1.0),
    fillOpacity: 0.3,
  },
  image_footnote: {
    strokeColor: rgb(1.0, 0.7, 0.4),
    fillColor: rgb(1.0, 0.7, 0.4),
    fillOpacity: 0.3,
  },
  chart: {
    strokeColor: rgb(0.6, 1.0, 0.2),
    fillColor: rgb(0.6, 1.0, 0.2),
    fillOpacity: 0.3,
  },
  chart_caption: {
    strokeColor: rgb(0.4, 0.7, 1.0),
    fillColor: rgb(0.4, 0.7, 1.0),
    fillOpacity: 0.3,
  },
  chart_footnote: {
    strokeColor: rgb(1.0, 0.7, 0.4),
    fillColor: rgb(1.0, 0.7, 0.4),
    fillOpacity: 0.3,
  },
  code: {
    strokeColor: rgb(0.4, 0.0, 0.8),
    fillColor: rgb(0.4, 0.0, 0.8),
    fillOpacity: 0.3,
  },
  code_body: {
    strokeColor: rgb(0.4, 0.0, 0.8),
    fillColor: rgb(0.4, 0.0, 0.8),
    fillOpacity: 0.3,
  },
  code_caption: {
    strokeColor: rgb(0.8, 0.6, 1.0),
    fillColor: rgb(0.8, 0.6, 1.0),
    fillOpacity: 0.3,
  },
  code_footnote: {
    strokeColor: rgb(0.9, 0.8, 1.0),
    fillColor: rgb(0.9, 0.8, 1.0),
    fillOpacity: 0.3,
  },
  list: {
    strokeColor: rgb(0.16, 0.66, 0.36),
    fillColor: rgb(0.16, 0.66, 0.36),
    fillOpacity: 0.3,
  },
  list_item: {
    strokeColor: rgb(0.16, 0.66, 0.36),
    fillColor: rgb(0.16, 0.66, 0.36),
    fillOpacity: 0.3,
  },
  index: {
    strokeColor: rgb(0.16, 0.66, 0.36),
    fillColor: rgb(0.16, 0.66, 0.36),
    fillOpacity: 0.3,
  },
  reference: {
    strokeColor: rgb(0.6, 0.0, 0.298),
    fillColor: rgb(0.6, 0.0, 0.298),
    fillOpacity: 0.3,
  },
  citation: {
    strokeColor: rgb(0.6, 0.0, 0.298),
    fillColor: rgb(0.6, 0.0, 0.298),
    fillOpacity: 0.3,
  },
  discarded: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    fillOpacity: 0.3,
  },
  header: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    fillOpacity: 0.3,
  },
  footer: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    fillOpacity: 0.3,
  },
  page_number: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    fillOpacity: 0.3,
  },
  footnote: {
    strokeColor: rgb(0.62, 0.62, 0.62),
    fillColor: rgb(0.62, 0.62, 0.62),
    fillOpacity: 0.3,
  },
};

export function getBoxStyle(type: MinerUBoxType): BboxStyle {
  const normalized = String(type || "")
    .trim()
    .toLowerCase();
  return TYPE_STYLES[normalized] ?? DEFAULT_STYLE;
}

/**
 * 在原始 PDF 页面上绘制 MinerU 解析得出的布局识别块与序号，生成带框标注 PDF。
 */
export async function generateLayoutPdf(
  pdfBytes: Uint8Array,
  boxes: NormalizedBox[],
): Promise<Uint8Array> {
  // Ensure the underlying buffer belongs to the current execution realm so
  // SpiderMonkey cross-compartment TypedArray instanceof checks in pdf-lib pass.
  const cleanBuffer = new ArrayBuffer(pdfBytes.byteLength);
  new Uint8Array(cleanBuffer).set(pdfBytes);
  const cleanBytes = new Uint8Array(cleanBuffer);

  const pdfDoc = await PDFDocument.load(cleanBytes, {
    ignoreEncryption: true,
  });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageCount = pdfDoc.getPageCount();

  const pageCounters = new Map<number, number>();

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

    const currentCount = (pageCounters.get(pageIndex) || 0) + 1;
    pageCounters.set(pageIndex, currentCount);

    const style = getBoxStyle(box.type);

    // Draw filled translucent rectangle matching MinerU draw_layout_bbox
    page.drawRectangle({
      x: rectX,
      y: rectY,
      width: rectW,
      height: rectH,
      color: style.fillColor,
      opacity: style.fillOpacity ?? 0.3,
    });

    // Draw red block number on top-right corner matching MinerU draw_bbox_with_number
    const text = String(currentCount);
    const textSize = 10;
    const textWidth = font.widthOfTextAtSize(text, textSize);
    let textX = rectX + rectW + 2;
    if (textX + textWidth > width - 2) {
      textX = Math.max(2, rectX + rectW - textWidth - 2);
    }
    const textY = Math.min(
      height - textSize - 2,
      Math.max(2, rectY + rectH - textSize),
    );

    page.drawText(text, {
      x: textX,
      y: textY,
      size: textSize,
      font,
      color: rgb(1, 0, 0),
    });
  }

  return await pdfDoc.save();
}
