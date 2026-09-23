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
 * Parse Markdown ATX headings and generate hierarchical paths for each heading.
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
 * Optional behaviors when reading a section.
 */
export interface ReadSectionOptions {
  /**
   * Include all sibling and subordinate subsections.
   * MinerU often renders numbered subsections like "3.1" at the same heading level as their parent;
   * when enabled, the end boundary becomes the next higher-level heading, returning the full subtree.
   */
  includeSubsections?: boolean;
}

/**
 * Return section content based on heading path, including the heading title line.
 */
export function readSection(
  markdown: string,
  sectionPath: string[] | string,
  options: ReadSectionOptions = {},
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
  const endLine = options.includeSubsections
    ? findSubtreeEndLine(headings, heading)
    : findSectionEndLine(headings, heading);

  return {
    heading,
    content: lines.slice(heading.line, endLine).join("\n").trimEnd(),
  };
}

/**
 * Default boundary: the next heading at the same or higher level.
 */
function findSectionEndLine(
  headings: MarkdownHeading[],
  heading: MarkdownHeading,
): number {
  const nextHeading = headings.find(
    (candidate) =>
      candidate.line > heading.line && candidate.level <= heading.level,
  );
  return nextHeading?.line ?? Infinity;
}

/**
 * Subtree boundary: the next higher-level heading, or a sibling heading switching to another section group.
 *
 * MinerU often renders numbered subsections like "3.1" at the same heading level as their parent;
 * heading level alone cannot differentiate subsections from the next chapter. We therefore inspect
 * numeric prefixes: sibling headings with a different top-level number (e.g. "4.") terminate the current
 * group, and unnumbered sibling headings (e.g. "References") are also treated as a new section.
 */
function findSubtreeEndLine(
  headings: MarkdownHeading[],
  heading: MarkdownHeading,
): number {
  const targetNumber = leadingNumber(heading.title);
  const stopHeading = headings.find((candidate) => {
    if (candidate.line <= heading.line) {
      return false;
    }
    if (candidate.level < heading.level) {
      return true;
    }
    if (candidate.level > heading.level) {
      return false;
    }
    const candidateNumber = leadingNumber(candidate.title);
    if (candidateNumber === undefined || targetNumber === undefined) {
      return true;
    }
    return candidateNumber !== targetNumber;
  });
  return stopHeading?.line ?? Infinity;
}

/**
 * Extract leading top-level numeric prefix, e.g. "3.1. Task" returns 3.
 */
function leadingNumber(title: string): number | undefined {
  const match = /^(\d+)\b/.exec(title.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * Split paragraphs by blank lines and return keyword hits with surrounding context.
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
 * Normalize section path string and array inputs into a uniform format.
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
 * Determine whether two heading paths are identical.
 */
function samePath(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((part, index) => part === right[index])
  );
}
