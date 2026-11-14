import { MarkdownQueryError } from "../markdownQuery/types";
import type {
  AttachmentSummary,
  CollectionStatus,
  CollectionSummary,
  ItemSummary,
  LibrarySummary,
  MarkdownHeading,
  MarkdownLocateMatch,
  MarkdownSearchMatch,
  StatusAttachment,
  TagSummary,
} from "../markdownQuery/types";

/**
 * Text shown to agents. Every tool answers in plain text built here: short
 * labelled lines for metadata, then the Markdown itself, unescaped.
 */

/** The parts of a Markdown query response every reading tool prints. */
export interface PaperHeader {
  item: ItemSummary;
  attachment: { key: string; fileName: string };
  result: { mode: "precise" | "lite"; file?: string };
}

/** A parse task as `MarkdownQueryService.getTasks()` reports it. */
export interface TaskSummary {
  id: string;
  libraryID: number;
  key: string;
  title?: string;
  status: string;
  progress?: number;
  detail?: string;
  error?: string;
  updatedAt?: number;
}

/** Longest box text printed for one `locate` match. */
const LOCATE_HIT_CHARS = 500;

/** Title, keys and parse mode of the paper a reading tool answered for. */
export function formatPaperHeader(paper: PaperHeader): string[] {
  const mode =
    paper.result.mode === "lite"
      ? "lite (text only; no page positions)"
      : "precise";
  return [
    `Title: ${paper.item.title || "unknown"}`,
    `Item: ${paper.item.key} | PDF: ${paper.attachment.key} (${paper.attachment.fileName}) | Parse: ${mode}`,
  ];
}

/** Libraries, then the collections of one library as slash paths. */
export function formatCollections(
  libraries: LibrarySummary[],
  libraryID: number,
  collections: CollectionSummary[],
): string {
  const byKey = new Map(collections.map((col) => [col.key, col]));
  const pathOf = (col: CollectionSummary): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (
      let current: CollectionSummary | undefined = col;
      current && !seen.has(current.key);
      current = current.parentKey ? byKey.get(current.parentKey) : undefined
    ) {
      seen.add(current.key);
      names.unshift(current.name);
    }
    return names.join("/");
  };
  const rows = collections
    .map((col) => ({ path: pathOf(col), key: col.key }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return [
    `Libraries: ${libraries.length}`,
    ...libraries.map(
      (lib) => `- library_id ${lib.libraryID}: ${lib.name} (${lib.type})`,
    ),
    "",
    `Collections in library ${libraryID}: ${rows.length}`,
    "Line format: path | collection key",
    ...rows.map((row) => `- ${row.path} | ${row.key}`),
  ].join("\n");
}

/** Tag names, with item counts when Zotero reports them. */
export function formatTags(libraryID: number, tags: TagSummary[]): string {
  return [
    `Tags in library ${libraryID}: ${tags.length}`,
    ...tags.map((tag) =>
      tag.numItems === undefined
        ? `- ${tag.tag}`
        : `- ${tag.tag} (${tag.numItems})`,
    ),
  ].join("\n");
}

function isReadable(attachment: StatusAttachment): boolean {
  return attachment.state === "precise" || attachment.state === "lite";
}

/** One line per item, grouped by whether the item can be read now. */
export function formatCollectionStatus(status: CollectionStatus): string {
  const groups: Array<[string, CollectionStatus["items"]]> = [
    [
      "Parsed",
      status.items.filter((item) => item.attachments.some(isReadable)),
    ],
    [
      "Not parsed",
      status.items.filter(
        (item) =>
          item.attachments.length > 0 && !item.attachments.some(isReadable),
      ),
    ],
    ["No PDF", status.items.filter((item) => item.attachments.length === 0)],
  ];
  const lines = [
    `Collection: ${status.collection}${
      status.includeSubcollections ? " (with subcollections)" : ""
    } | library ${status.libraryID}`,
    `Items: ${status.totals.items} | parsed: ${status.totals.parsed} | not parsed: ${status.totals.notParsed} | no PDF: ${status.totals.noPdf}`,
    "Line format: item key | first creator, year | title | PDF key, state, words",
  ];
  for (const [label, items] of groups) {
    lines.push("", `[${label}] ${items.length}`);
    for (const item of items) {
      const byline = [item.firstCreator, item.year].filter(Boolean).join(", ");
      const pdfs = item.attachments
        .map((attachment) =>
          [
            attachment.key,
            attachment.state,
            attachment.words === undefined ? "" : `${attachment.words} words`,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join("; ");
      lines.push(
        `- ${[item.key, byline || "unknown", item.title, ...(pdfs ? [pdfs] : [])].join(" | ")}`,
      );
    }
  }
  return lines.join("\n");
}

function parseState(attachment: AttachmentSummary): string {
  return attachment.preciseReady
    ? "precise"
    : attachment.liteReady
      ? "lite"
      : "not parsed";
}

/** Search hits: keys first, then the metadata needed to confirm a match. */
export function formatSearchResults(
  libraryID: number,
  candidates: Array<{ item: ItemSummary; attachments: AttachmentSummary[] }>,
): string {
  const lines = [`Items: ${candidates.length} | library ${libraryID}`];
  candidates.forEach(({ item, attachments }, index) => {
    const byline = [(item.creators ?? []).join("; "), item.year]
      .filter(Boolean)
      .join(", ");
    const details = [
      item.itemType,
      item.publication,
      item.citekey ? `citekey ${item.citekey}` : "",
      item.doi ? `doi ${item.doi}` : "",
    ].filter(Boolean);
    lines.push(
      "",
      `${index + 1}. ${item.key} | ${byline || "unknown"} | ${item.title}`,
    );
    if (details.length > 0) {
      lines.push(`   ${details.join(" | ")}`);
    }
    lines.push(
      attachments.length === 0
        ? "   PDFs: none"
        : `   PDFs: ${attachments
            .map((attachment) => `${attachment.key} ${parseState(attachment)}`)
            .join("; ")}`,
    );
  });
  return lines.join("\n");
}

/** Headings as the JSON arrays `mineru_read_section` takes. */
export function formatOutline(
  paper: PaperHeader,
  markdown: string,
  headings: MarkdownHeading[],
): string {
  const words = markdown.split(/\s+/).filter(Boolean).length;
  return [
    ...formatPaperHeader(paper),
    `Size: ${words} words, ${markdown.length} characters`,
    ...(paper.result.file ? [`File: ${paper.result.file}`] : []),
    "",
    `Headings: ${headings.length} (each line is a section_path for mineru_read_section)`,
    ...headings.map((heading) => JSON.stringify(heading.path)),
  ].join("\n");
}

/** A section: its path, then the Markdown. */
export function formatSection(
  paper: PaperHeader,
  path: string[],
  content: string,
): string {
  return [
    ...formatPaperHeader(paper),
    `Section: ${JSON.stringify(path)}`,
    "",
    content,
  ].join("\n");
}

/** Paragraph matches with their context; the hit paragraph starts with `>>`. */
export function formatSearchMatches(
  paper: PaperHeader,
  query: string,
  matches: MarkdownSearchMatch[],
  total: number,
): string {
  const lines = [
    ...formatPaperHeader(paper),
    `Query: ${query}`,
    total > matches.length
      ? `Matches: ${total} (showing the first ${matches.length}; raise max_matches or narrow the query)`
      : `Matches: ${total}`,
  ];
  matches.forEach((match, index) => {
    lines.push("", `[Match ${index + 1}] paragraph ${match.paragraphIndex}`);
    for (const paragraph of match.before) {
      lines.push("", paragraph);
    }
    lines.push("", `>> ${match.hit}`);
    for (const paragraph of match.after) {
      lines.push("", paragraph);
    }
  });
  return lines.join("\n");
}

/** Layout-box matches with the physical page of each. */
export function formatLocateMatches(
  paper: PaperHeader,
  query: string,
  matches: MarkdownLocateMatch[],
  total: number,
): string {
  const lines = [
    ...formatPaperHeader(paper),
    `Query: ${query}`,
    total > matches.length
      ? `Matches: ${total} (showing the first ${matches.length})`
      : `Matches: ${total}`,
    "Pages are physical PDF pages, counted from 1.",
  ];
  matches.forEach((match, index) => {
    const hit =
      match.hit.length > LOCATE_HIT_CHARS
        ? `${match.hit.slice(0, LOCATE_HIT_CHARS)}…`
        : match.hit;
    lines.push(
      "",
      `[Match ${index + 1}] page ${match.page} (${match.type})`,
      hit,
    );
  });
  return lines.join("\n");
}

/** One slice of the full Markdown, with where the next slice starts. */
export function formatMarkdownPage(
  paper: PaperHeader,
  page: { start: number; end: number; total: number; text: string },
): string {
  const position =
    page.end < page.total
      ? `Characters: ${page.start}-${page.end} of ${page.total} | more: call again with offset ${page.end}`
      : `Characters: ${page.start}-${page.end} of ${page.total} | end of document`;
  return [
    ...formatPaperHeader(paper),
    position,
    ...(paper.result.file ? [`File: ${paper.result.file}`] : []),
    "",
    page.text,
  ].join("\n");
}

function formatTaskDetails(task: TaskSummary): string[] {
  return [
    ...(task.progress === undefined ? [] : [`progress: ${task.progress}%`]),
    ...(task.detail ? [`detail: ${task.detail}`] : []),
    ...(task.error ? [`error: ${task.error}`] : []),
  ];
}

const PARSE_NEXT_STEPS: Record<string, string> = {
  submitted:
    "Parsing runs in Zotero. Check it with mineru_list_tasks; do not submit it again.",
  "already-parsed":
    "A result for the current PDF exists, so nothing was submitted. Read it with mineru_get_outline. Pass force only if the user asks for a fresh parse (it spends MinerU quota).",
  "already-running":
    "This PDF is already being parsed. Check it with mineru_list_tasks.",
  running:
    "Still parsing when this call had to answer. The parse continues in Zotero; check it with mineru_list_tasks, do not submit it again.",
  succeeded: "The result is ready. Read it with mineru_get_outline.",
  failed:
    "The parse failed; the error above is MinerU's. Report it to the user instead of retrying, because a retry spends quota again.",
  cancelled: "The parse was stopped in Zotero.",
};

/** Answer to a parse request, with the next step for each status. */
export function formatParseResult(
  key: string,
  status: string,
  task?: TaskSummary,
): string {
  return [
    `PDF: ${key}`,
    `Status: ${status}`,
    ...(task ? formatTaskDetails(task) : []),
    ...(PARSE_NEXT_STEPS[status] ? ["", PARSE_NEXT_STEPS[status]] : []),
  ].join("\n");
}

/** The parse task list, newest first as the task store returns it. */
export function formatTasks(tasks: TaskSummary[], total: number): string {
  const lines = [
    total > tasks.length
      ? `Parse tasks: ${total} (showing the newest ${tasks.length})`
      : `Parse tasks: ${total}`,
  ];
  tasks.forEach((task, index) => {
    lines.push(
      "",
      `${index + 1}. ${task.title || "unknown"}`,
      `   PDF: ${task.key} | library ${task.libraryID} | status: ${task.status}`,
      ...formatTaskDetails(task).map((line) => `   ${line}`),
    );
  });
  return lines.join("\n");
}

/** What the agent should do next for each query error. */
const QUERY_ERROR_HINTS: Partial<Record<MarkdownQueryError["code"], string>> = {
  "item-not-found":
    "Check the key and library_id. mineru_search_items and mineru_collection_status list item keys.",
  "pdf-attachment-not-found":
    "This item has no PDF attachment to read or parse.",
  "attachment-not-found":
    "attachment_key must be one of the item's PDF keys; mineru_search_items lists them.",
  "collection-not-found":
    "Call mineru_list_collections and pass a collection key or exact name.",
  "ambiguous-attachment":
    "Call again with attachment_key set to one of the candidate keys.",
  "parse-result-not-found":
    "This PDF has not been parsed yet. mineru_parse_pdf can start a parse (it spends the user's MinerU quota), or pass attachment_key for another PDF of the item.",
  "section-not-found":
    "Call mineru_get_outline and copy one of its section_path lines exactly.",
  "ambiguous-section":
    "Several headings share this path. Use mineru_search_in_paper or mineru_read_markdown for this part instead.",
  "missing-query": "Pass a non-empty query.",
};

/** A query error as one message: what went wrong, candidates, what to do. */
export function describeQueryError(error: MarkdownQueryError): string {
  const lines = [`${error.code}: ${error.message}`];
  const candidates = (error.details as { candidates?: unknown } | undefined)
    ?.candidates;
  if (Array.isArray(candidates) && error.code === "ambiguous-attachment") {
    for (const candidate of candidates as Array<{
      key: string;
      fileName: string;
      preciseReady?: boolean;
      liteReady?: boolean;
    }>) {
      lines.push(
        `- ${candidate.key} ${candidate.fileName} (${parseState(candidate as AttachmentSummary)})`,
      );
    }
  }
  const hint = QUERY_ERROR_HINTS[error.code];
  return hint ? [...lines, hint].join("\n") : lines.join("\n");
}
