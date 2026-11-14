import { assert } from "chai";
import {
  parseHeadings,
  readSection,
  searchBoxes,
  searchMarkdown,
  stripInlineTags,
  toPlainSearchText,
} from "../src/modules/markdownQuery/markdownParser";
import { MarkdownQueryError } from "../src/modules/markdownQuery/types";

const markdown = [
  "# Example Paper",
  "",
  "Lead paragraph.",
  "",
  "## Introduction",
  "",
  "Intro body.",
  "",
  "### Background",
  "",
  "Background body mentions Retrieval.",
  "",
  "## Methods",
  "",
  "Method body mentions retrieval again.",
].join("\n");

// MinerU often renders numbered subsections at the same level as their parent,
// so 3 and 3.1 both become level-2 headings.
const sameLevelMarkdown = [
  "# Doc",
  "",
  "## 3. System Model",
  "",
  "System intro.",
  "",
  "## 3.1. Task Model",
  "",
  "Task body.",
  "",
  "## 3.2. Power Model",
  "",
  "Power body.",
  "",
  "## 4. Algorithm",
  "",
  "Algorithm body.",
].join("\n");

const taggedPaper = [
  "# Paper",
  "",
  "Global CO<sub>2</sub> emissions rose by 10<sup>3</sup> t, a trans-",
  "formative change across",
  "many sectors.",
  "",
  "<table><tr><td>CO2</td><td>emissions</td></tr></table>",
  "",
  "Literal CO2 emissions paragraph.",
].join("\n");

describe("markdownParser", function () {
  it("extracts ATX headings with paths", function () {
    assert.deepEqual(parseHeadings(markdown), [
      { level: 1, title: "Example Paper", path: ["Example Paper"], line: 0 },
      {
        level: 2,
        title: "Introduction",
        path: ["Example Paper", "Introduction"],
        line: 4,
      },
      {
        level: 3,
        title: "Background",
        path: ["Example Paper", "Introduction", "Background"],
        line: 8,
      },
      {
        level: 2,
        title: "Methods",
        path: ["Example Paper", "Methods"],
        line: 12,
      },
    ]);
  });

  it("returns a section by exact heading path", function () {
    const section = readSection(markdown, ["Example Paper", "Introduction"]);

    assert.deepEqual(section.heading.path, ["Example Paper", "Introduction"]);
    assert.equal(
      section.content,
      "## Introduction\n\nIntro body.\n\n### Background\n\nBackground body mentions Retrieval.",
    );
  });

  it("stops at same-level headings by default", function () {
    const section = readSection(sameLevelMarkdown, ["Doc", "3. System Model"]);

    assert.equal(section.content, "## 3. System Model\n\nSystem intro.");
  });

  it("includes same-level subsections when requested", function () {
    const section = readSection(sameLevelMarkdown, ["Doc", "3. System Model"], {
      includeSubsections: true,
    });

    assert.equal(
      section.content,
      [
        "## 3. System Model",
        "",
        "System intro.",
        "",
        "## 3.1. Task Model",
        "",
        "Task body.",
        "",
        "## 3.2. Power Model",
        "",
        "Power body.",
      ].join("\n"),
    );
  });

  it("includes everything below a level-one heading when requested", function () {
    const section = readSection(sameLevelMarkdown, ["Doc"], {
      includeSubsections: true,
    });

    assert.include(section.content, "Algorithm body.");
  });

  it("stops the subtree at unnumbered same-level headings", function () {
    const markdown = [
      "# Doc",
      "",
      "## 3. System Model",
      "",
      "System intro.",
      "",
      "## 3.1. Task Model",
      "",
      "Task body.",
      "",
      "## Notes",
      "",
      "Notes body.",
    ].join("\n");
    const section = readSection(markdown, ["Doc", "3. System Model"], {
      includeSubsections: true,
    });

    assert.equal(
      section.content,
      "## 3. System Model\n\nSystem intro.\n\n## 3.1. Task Model\n\nTask body.",
    );
  });

  it("returns section-not-found for a missing section", function () {
    assert.throws(
      () => readSection(markdown, ["Example Paper", "Discussion"]),
      MarkdownQueryError,
      "section-not-found",
    );
  });

  it("searches paragraphs case-insensitively with context", function () {
    assert.deepEqual(searchMarkdown(markdown, "retrieval", 1), [
      {
        paragraphIndex: 4,
        context:
          "### Background\n\nBackground body mentions Retrieval.\n\n## Methods",
        before: ["### Background"],
        hit: "Background body mentions Retrieval.",
        after: ["## Methods"],
      },
      {
        paragraphIndex: 6,
        context: "## Methods\n\nMethod body mentions retrieval again.",
        before: ["## Methods"],
        hit: "Method body mentions retrieval again.",
        after: [],
      },
    ]);
  });

  describe("plain-text matching", function () {
    it("reduces text to what a reader sees", function () {
      assert.equal(
        toPlainSearchText("H<sub>2</sub>O  and\n<b>bold</b> trans-\nform"),
        "h2o and bold transform",
      );
      assert.equal(toPlainSearchText("<td>a</td><td>b</td>"), "a b");
      assert.equal(
        toPlainSearchText("x < y and well-known"),
        "x < y and well-known",
      );
    });

    it("strips inline tags but keeps tables", function () {
      assert.equal(
        stripInlineTags(
          "CO<sub>2</sub> and <b>bold</b> <table><tr><td>x</td></tr></table>",
        ),
        "CO2 and bold <table><tr><td>x</td></tr></table>",
      );
    });

    it("finds a query that spans an inline tag, returning the original text", function () {
      const matches = searchMarkdown(taggedPaper, "CO2 emissions", 0);

      assert.deepEqual(
        matches.map((match) => match.paragraphIndex),
        [0, 1, 2],
      );
      assert.include(matches[0].hit, "CO<sub>2</sub> emissions");
    });

    it("finds a query that spans a line break or a hyphenated word", function () {
      assert.lengthOf(
        searchMarkdown(taggedPaper, "change across many sectors"),
        1,
      );
      assert.lengthOf(
        searchMarkdown(taggedPaper, "a transformative change"),
        1,
      );
      assert.lengthOf(searchMarkdown(taggedPaper, "10 3 t"), 0);
    });

    it("treats a query written with the tags like its plain form", function () {
      assert.deepEqual(
        searchMarkdown(taggedPaper, "co<sub>2</sub>").map(
          (match) => match.paragraphIndex,
        ),
        [0, 1, 2],
      );
    });

    it("locates boxes through plain-text matching", function () {
      const box = (markdown: string, page: number) =>
        ({
          markdown,
          page,
          type: "text",
          bbox: { x: 0, y: 0, width: 1, height: 1 },
        }) as never;

      const matches = searchBoxes(
        [box("Intro", 0), box("CO<sub>2</sub> emissions\nrose", 3)],
        "co2 emissions rose",
        0,
      );

      assert.deepEqual(
        matches.map((match) => [match.page, match.hit]),
        [[3, "CO<sub>2</sub> emissions\nrose"]],
      );
    });
  });

  it("rejects empty search queries", function () {
    assert.throws(
      () => searchMarkdown(markdown, "   "),
      MarkdownQueryError,
      "missing-query",
    );
  });
});
