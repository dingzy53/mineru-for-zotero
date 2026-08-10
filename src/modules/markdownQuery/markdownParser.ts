import {
  MarkdownHeading,
  MarkdownLocateMatch,
  MarkdownQueryError,
  MarkdownSearchMatch,
  MarkdownSectionResult,
} from "./types";
import type { NormalizedBox } from "../domain";

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TOP_LEVEL_TITLE = /^#\s+.+$/;

/**
 * 解析 Markdown ATX 标题，并为每个标题生成层级路径。
 */
export function parseHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const stack: MarkdownHeading[] = [];

  markdown.split(/\r?\n/).forEach((line, index) => {
    const match = ATX_HEADING.exec(line);
    if (!match) {
      return;
    }

    const level = match[1].length;
    const title = match[2].trim();
    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const heading: MarkdownHeading = {
      level,
      title,
      path: [...stack.map((item) => item.title), title],
      line: index,
    };
    headings.push(heading);
    stack.push(heading);
  });

  return headings;
}

/**
 * 根据 heading path 返回章节内容，包含章节标题行。
 */
export function readSection(
  markdown: string,
  sectionPath: string[] | string,
): MarkdownSectionResult {
  const path = normalizeSectionPath(sectionPath);
  const lines = markdown.split(/\r?\n/);
  const headings = parseHeadings(markdown);
  const matches = headings.filter((heading) => samePath(heading.path, path));

  if (matches.length === 0) {
    throw new MarkdownQueryError("section-not-found", 404, "section-not-found");
  }
  if (matches.length > 1) {
    throw new MarkdownQueryError(
      "ambiguous-section",
      409,
      "ambiguous-section",
      { candidates: matches },
    );
  }

  const heading = matches[0];
  const nextHeading = headings.find(
    (candidate) =>
      candidate.line > heading.line && candidate.level <= heading.level,
  );
  const endLine = nextHeading?.line ?? lines.length;

  return {
    heading,
    content: lines.slice(heading.line, endLine).join("\n").trimEnd(),
  };
}

/**
 * 按空行分隔段落，返回包含前后上下文的关键词命中。
 */
export function searchMarkdown(
  markdown: string,
  query: string,
  contextParagraphs = 1,
): MarkdownSearchMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new MarkdownQueryError("missing-query", 400, "missing-query");
  }

  const contextSize = Math.max(0, Math.floor(contextParagraphs));
  const paragraphs = markdown
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const searchableParagraphs =
    paragraphs.length > 0 && TOP_LEVEL_TITLE.test(paragraphs[0])
      ? paragraphs.slice(1)
      : paragraphs;

  return searchableParagraphs.flatMap((paragraph, index) => {
    if (!paragraph.toLowerCase().includes(normalizedQuery)) {
      return [];
    }

    const before = searchableParagraphs.slice(
      Math.max(0, index - contextSize),
      index,
    );
    const after = searchableParagraphs.slice(
      index + 1,
      index + 1 + contextSize,
    );
    return [
      {
        paragraphIndex: index,
        context: [...before, paragraph, ...after].join("\n\n"),
        before,
        hit: paragraph,
        after,
      },
    ];
  });
}

/**
 * Searches precisely parsed boxes and returns physical page number matches with context.
 */
export function searchBoxes(
  boxes: NormalizedBox[],
  query: string,
  contextBoxes = 2,
): MarkdownLocateMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    throw new MarkdownQueryError("missing-query", 400, "missing-query");
  }

  const contextSize = Math.max(0, Math.floor(contextBoxes));
  const matches: MarkdownLocateMatch[] = [];

  boxes.forEach((box, index) => {
    const textToSearch = [box.markdown, box.formula, box.tableFormats?.markdown]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    if (textToSearch.includes(normalizedQuery)) {
      const before = boxes.slice(Math.max(0, index - contextSize), index);
      const after = boxes.slice(index + 1, index + 1 + contextSize);
      const contextText = [...before, box, ...after]
        .map((b) => (b.markdown || b.formula || "").trim())
        .filter(Boolean)
        .join("\n\n");

      matches.push({
        boxIndex: index,
        page: box.page,
        type: box.type,
        hit: box.markdown || box.formula || "",
        context: contextText,
        bbox: box.bbox,
      });
    }
  });

  return matches;
}

/**
 * 统一 section path 的字符串与数组输入格式。
 */
function normalizeSectionPath(path: string[] | string): string[] {
  if (Array.isArray(path)) {
    return path.map((part) => part.trim()).filter(Boolean);
  }

  return path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 判断两个标题路径是否完全一致。
 */
function samePath(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}
