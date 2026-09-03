import { expect } from "chai";
import { PDFDocument } from "pdf-lib";
import type { NormalizedBox } from "../src/modules/domain";
import {
  generateLayoutPdf,
  getBoxStyle,
} from "../src/modules/layoutPdfGenerator";

describe("layoutPdfGenerator", function () {
  it("returns correct box styles for known and default types", function () {
    const titleStyle = getBoxStyle("title");
    expect(titleStyle).to.have.property("strokeColor");
    expect(titleStyle).to.have.property("fillColor");

    const formulaStyle = getBoxStyle("formula");
    expect(formulaStyle).to.have.property("strokeColor");

    const tableStyle = getBoxStyle("table");
    expect(tableStyle).to.have.property("strokeColor");

    const imageStyle = getBoxStyle("image");
    expect(imageStyle).to.have.property("strokeColor");

    const defaultStyle = getBoxStyle("unknown_custom_type");
    expect(defaultStyle).to.have.property("strokeColor");
    expect(defaultStyle).to.have.property("fillColor");
  });

  it("draws bounding boxes onto PDF pages and returns valid PDF bytes", async function () {
    const doc = await PDFDocument.create();
    doc.addPage([600, 800]);
    doc.addPage([600, 800]);
    const originalBytes = await doc.save();

    const boxes: NormalizedBox[] = [
      {
        rawIndex: 0,
        page: 1,
        type: "title",
        bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.1 },
        markdown: "# Sample Title",
        formula: null,
      },
      {
        rawIndex: 1,
        page: 1,
        type: "paragraph",
        bbox: { x: 0.1, y: 0.25, width: 0.8, height: 0.3 },
        markdown: "Sample paragraph text content.",
        formula: null,
      },
      {
        rawIndex: 2,
        page: 2,
        type: "table",
        bbox: { x: 0.15, y: 0.15, width: 0.7, height: 0.4 },
        markdown: "| A | B |\n|---|---|\n| 1 | 2 |",
        formula: null,
      },
      {
        rawIndex: 3,
        page: 2,
        type: "formula",
        bbox: { x: 0.2, y: 0.6, width: 0.6, height: 0.1 },
        markdown: "$$E = mc^2$$",
        formula: "E = mc^2",
      },
    ];

    const resultBytes = await generateLayoutPdf(originalBytes, boxes);
    expect(resultBytes).to.be.instanceOf(Uint8Array);
    expect(resultBytes.length).to.be.greaterThan(originalBytes.length);

    const reloadedDoc = await PDFDocument.load(resultBytes);
    expect(reloadedDoc.getPageCount()).to.equal(2);
  });

  it("safely handles out-of-range pages and invalid box dimensions", async function () {
    const doc = await PDFDocument.create();
    doc.addPage([500, 700]);
    const originalBytes = await doc.save();

    const boxes: NormalizedBox[] = [
      {
        rawIndex: 0,
        page: 999, // Page out of range
        type: "title",
        bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        markdown: "Out of range",
        formula: null,
      },
      {
        rawIndex: 1,
        page: 0, // Invalid page <= 0
        type: "text",
        bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        markdown: "Zero page",
        formula: null,
      },
      {
        rawIndex: 2,
        page: 1,
        type: "text",
        bbox: { x: 0.1, y: 0.1, width: 0, height: 0 }, // Zero dimensions
        markdown: "Zero dimensions",
        formula: null,
      },
    ];

    const resultBytes = await generateLayoutPdf(originalBytes, boxes);
    expect(resultBytes).to.be.instanceOf(Uint8Array);

    const reloadedDoc = await PDFDocument.load(resultBytes);
    expect(reloadedDoc.getPageCount()).to.equal(1);
  });

  it("handles Uint8Array views with offset and foreign buffers cleanly", async function () {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const bytes = await doc.save();
    // Simulate a sliced view with byteOffset
    const padded = new Uint8Array(bytes.length + 32);
    padded.set(bytes, 16);
    const view = new Uint8Array(padded.buffer, 16, bytes.length);

    const result = await generateLayoutPdf(view, [
      {
        rawIndex: 0,
        page: 1,
        type: "title",
        bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
        markdown: "Title",
        formula: null,
      },
    ]);
    expect(result).to.be.instanceOf(Uint8Array);
    const reloaded = await PDFDocument.load(result);
    expect(reloaded.getPageCount()).to.equal(1);
  });

  it("draws sequential numbers on each page for layout blocks", async function () {
    const doc = await PDFDocument.create();
    doc.addPage([500, 700]);
    doc.addPage([500, 700]);
    const originalBytes = await doc.save();

    const boxes: NormalizedBox[] = [
      {
        rawIndex: 0,
        page: 1,
        type: "title",
        bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.05 },
        markdown: "Title",
        formula: null,
      },
      {
        rawIndex: 1,
        page: 1,
        type: "text",
        bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
        markdown: "Text",
        formula: null,
      },
      {
        rawIndex: 2,
        page: 2,
        type: "table",
        bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
        markdown: "Table",
        formula: null,
      },
    ];

    const resultBytes = await generateLayoutPdf(originalBytes, boxes);
    expect(resultBytes).to.be.instanceOf(Uint8Array);
    const reloaded = await PDFDocument.load(resultBytes);
    expect(reloaded.getPageCount()).to.equal(2);
  });
});
