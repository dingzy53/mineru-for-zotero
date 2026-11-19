import {
  parseHeadings,
  stripInlineTags,
} from "../markdownQuery/markdownParser";
import type {
  ItemSearchInput,
  MarkdownHeading,
  MarkdownLocateMatch,
  MarkdownSearchMatch,
} from "../markdownQuery/types";
import { ToolError } from "./errors";
import { MAX_RESULT_CHARS } from "./runTool";
import {
  PaperHeader,
  TaskSummary,
  formatCollectionStatus,
  formatCollections,
  formatLocateMatches,
  formatMarkdownPage,
  formatOutline,
  formatParseResult,
  formatSearchMatches,
  formatSearchResults,
  formatSection,
  formatTags,
  formatTasks,
} from "./format";
import type { JSONSchema } from "./schema";
import type { ToolContext, ToolDef } from "./types";

/** Delay between task checks while `mineru_parse_pdf` waits. */
const PARSE_POLL_MS = 2000;
/** Time kept in hand to format and send the answer before the deadline. */
const DEADLINE_MARGIN_MS = 3000;
const FINISHED_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

// --- shared schema fragments ---

const libraryID: JSONSchema = {
  type: "integer",
  description:
    "Zotero library ID. Defaults to My Library; mineru_list_collections lists the others.",
};
const itemKey: JSONSchema = {
  type: "string",
  description:
    "Key of a Zotero item or of one of its PDF attachments (8 characters, e.g. ABCD2345), from mineru_search_items or mineru_collection_status.",
};
const attachmentKey: JSONSchema = {
  type: "string",
  description:
    "Key of one PDF of the item. Leave it out unless a call answered ambiguous-attachment: the server picks the parsed PDF itself.",
};
const plain: JSONSchema = {
  type: "boolean",
  description:
    "Remove inline HTML tags such as <sub> and <sup> from the text (CO<sub>2</sub> becomes CO2). Off by default, because 10<sup>3</sup> would become 103.",
};
const collectionRef: JSONSchema = {
  type: "string",
  description:
    "Collection key or exact name, from mineru_list_collections. Prefer the key when two collections share a name.",
};

function library(args: Record<string, any>, ctx: ToolContext): number {
  return args.library_id ?? ctx.defaultLibraryID;
}

/** The arguments that select a paper, in the service's names. */
function paperRef(args: Record<string, any>, ctx: ToolContext) {
  return {
    libraryID: library(args, ctx),
    key: args.key as string,
    attachmentKey: args.attachment_key as string | undefined,
  };
}

function maybePlain(args: Record<string, any>, text: string): string {
  return args.plain ? stripInlineTags(text) : text;
}

/**
 * The slice of `text` that starts at `offset` and holds at most `maxChars`,
 * ended at a paragraph break when one lies in its second half.
 */
export function slicePage(
  text: string,
  offset: number,
  maxChars: number,
): { start: number; end: number; total: number; text: string } {
  const start = Math.min(offset, text.length);
  let end = Math.min(start + maxChars, text.length);
  if (end < text.length && end - start >= 2) {
    const paragraphBreak = text.lastIndexOf("\n\n", end - 2);
    if (paragraphBreak > start + maxChars / 2) {
      end = paragraphBreak + 2;
    }
  }
  return { start, end, total: text.length, text: text.slice(start, end) };
}

export const TOOLS: ToolDef[] = [
  {
    name: "mineru_list_collections",
    title: "List Zotero libraries and collections",
    description:
      "List the Zotero libraries and, for one library, every collection as a slash path with its key. Start here when the user names a collection and you need its key.",
    inputSchema: { type: "object", properties: { library_id: libraryID } },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const libraryID = library(args, ctx);
      const [{ libraries }, { collections }] = await Promise.all([
        ctx.service.getLibraries(),
        ctx.service.getCollections({ libraryID }),
      ]);
      return formatCollections(libraries, libraryID, collections);
    },
  },
  {
    name: "mineru_list_tags",
    title: "List Zotero tags",
    description:
      "List the tags of a library, for use as the tag filter of mineru_search_items.",
    inputSchema: {
      type: "object",
      properties: {
        library_id: libraryID,
        limit: { type: "integer", default: 100, minimum: 1, maximum: 1000 },
      },
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const libraryID = library(args, ctx);
      const { tags } = await ctx.service.getTags({
        libraryID,
        limit: args.limit,
      });
      return formatTags(libraryID, tags);
    },
  },
  {
    name: "mineru_collection_status",
    title: "Show which papers of a collection are parsed",
    description:
      'Survey a collection before reading it: one line per item with its key, first author, year, title, and for each PDF whether MinerU has parsed it (precise, lite, running, failed, none) and its word count. Use this first when the user says papers in a collection are "parsed in Zotero".',
    inputSchema: {
      type: "object",
      properties: {
        collection: collectionRef,
        include_subcollections: {
          type: "boolean",
          default: false,
          description: "Also report items in the collection's subcollections.",
        },
        library_id: libraryID,
      },
      required: ["collection"],
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      return formatCollectionStatus(
        await ctx.service.getCollectionStatus({
          libraryID: library(args, ctx),
          collection: args.collection,
          includeSubcollections: args.include_subcollections,
        }),
      );
    },
  },
  {
    name: "mineru_search_items",
    title: "Find items in the Zotero library",
    description:
      'Find Zotero items by metadata and see which of their PDFs are parsed. For an author-year citation such as "Chen et al. 2022" pass creator and year, not title words. Give at least one filter. This searches metadata only; to search inside a paper use mineru_search_in_paper.',
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Words from the title." },
        creator: { type: "string", description: "Part of an author name." },
        year: { type: "string", description: 'Four-digit year, e.g. "2022".' },
        collection: collectionRef,
        tag: { type: "string", description: "Exact tag." },
        abstract: { type: "string", description: "Words from the abstract." },
        publication: {
          type: "string",
          description: "Part of the journal or proceedings title.",
        },
        citekey: { type: "string", description: "Part of the citation key." },
        doi: { type: "string", description: "Part of the DOI." },
        item_type: {
          type: "string",
          description:
            "Zotero item type, e.g. journalArticle, conferencePaper.",
        },
        since: {
          type: "string",
          description: "Only items added on or after this date (YYYY-MM-DD).",
        },
        has_pdf: { type: "boolean", description: "Only items with a PDF." },
        parsed_only: {
          type: "boolean",
          description: "Only items with a parse result that can be read.",
        },
        sort_by: {
          type: "string",
          enum: ["dateAdded", "dateModified", "title", "year"],
        },
        sort_order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        library_id: libraryID,
      },
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const filters: Omit<ItemSearchInput, "libraryID" | "limit"> = {
        title: args.title,
        creator: args.creator,
        year: args.year,
        collection: args.collection,
        tag: args.tag,
        abstract: args.abstract,
        publication: args.publication,
        citekey: args.citekey,
        doi: args.doi,
        itemType: args.item_type,
        since: args.since,
        hasPdf: args.has_pdf,
        parsedOnly: args.parsed_only,
        sortBy: args.sort_by,
        sortOrder: args.sort_order,
      };
      const { sortBy: _sortBy, sortOrder: _sortOrder, ...criteria } = filters;
      const hasCriteria = Object.values(criteria).some((value) =>
        typeof value === "string" ? value.trim().length > 0 : Boolean(value),
      );
      if (!hasCriteria) {
        throw new ToolError(
          "Give at least one filter (title, creator, year, collection, tag, …). To list a whole collection use mineru_collection_status.",
        );
      }
      if (args.year !== undefined && !/^\d{4}$/.test(args.year)) {
        throw new ToolError('year must be four digits, e.g. "2022"');
      }
      const libraryID = library(args, ctx);
      const defined = Object.fromEntries(
        Object.entries(filters).filter(([, value]) => value !== undefined),
      );
      const { candidates } = await ctx.service.searchByTitle({
        libraryID,
        ...defined,
        limit: args.limit,
      });
      return formatSearchResults(libraryID, candidates);
    },
  },
  {
    name: "mineru_get_outline",
    title: "Get a parsed paper's outline",
    description:
      "Read the heading tree of a parsed paper, plus its size and the path of the stored Markdown file. Call this before reading: it shows what the paper contains and gives the section_path values for mineru_read_section. The word count tells you whether the paper fits in context or should be read by section.",
    inputSchema: {
      type: "object",
      properties: {
        key: itemKey,
        attachment_key: attachmentKey,
        library_id: libraryID,
      },
      required: ["key"],
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const paper = (await ctx.service.queryMarkdown({
        ...paperRef(args, ctx),
        granularity: "full",
        includeFilePath: true,
      })) as PaperHeader & { content: string };
      return formatOutline(paper, paper.content, parseHeadings(paper.content));
    },
  },
  {
    name: "mineru_read_section",
    title: "Read one section of a parsed paper",
    description:
      'Read one section of a parsed paper as Markdown (text, tables, LaTeX formulas). section_path is a line from mineru_get_outline, e.g. ["Paper title", "3. Method"]. MinerU often puts numbered subsections (3.1, 3.2) at the same level as their parent (3.); set include_subsections to get the whole numbered group.',
    inputSchema: {
      type: "object",
      properties: {
        key: itemKey,
        section_path: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Heading titles from the top-level heading down to the section, exactly as mineru_get_outline prints them.",
        },
        include_subsections: { type: "boolean", default: false },
        plain,
        attachment_key: attachmentKey,
        library_id: libraryID,
      },
      required: ["key", "section_path"],
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const section = (await ctx.service.queryMarkdown({
        ...paperRef(args, ctx),
        granularity: "section",
        sectionPath: args.section_path,
        includeSubsections: args.include_subsections,
      })) as PaperHeader & { heading: MarkdownHeading; content: string };
      return formatSection(
        section,
        section.heading.path,
        maybePlain(args, section.content),
      );
    },
  },
  {
    name: "mineru_search_in_paper",
    title: "Search inside a parsed paper",
    description:
      "Find the paragraphs of one parsed paper that contain a phrase, with the paragraphs around them. Matching ignores case, inline tags and line breaks (CO2 finds CO<sub>2</sub>). Formulas are stored as LaTeX, so search for the prose around a formula.",
    inputSchema: {
      type: "object",
      properties: {
        key: itemKey,
        query: { type: "string", description: "Phrase to find." },
        context_paragraphs: {
          type: "integer",
          default: 1,
          minimum: 0,
          maximum: 5,
          description: "Paragraphs shown before and after each match.",
        },
        max_matches: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        plain,
        attachment_key: attachmentKey,
        library_id: libraryID,
      },
      required: ["key", "query"],
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const found = (await ctx.service.queryMarkdown({
        ...paperRef(args, ctx),
        granularity: "search",
        q: args.query,
        contextParagraphs: args.context_paragraphs,
      })) as PaperHeader & { matches: MarkdownSearchMatch[] };
      const matches = found.matches.slice(0, args.max_matches).map((match) => ({
        ...match,
        before: match.before.map((text) => maybePlain(args, text)),
        hit: maybePlain(args, match.hit),
        after: match.after.map((text) => maybePlain(args, text)),
      }));
      return formatSearchMatches(
        found,
        args.query,
        matches,
        found.matches.length,
      );
    },
  },
  {
    name: "mineru_locate_in_pdf",
    title: "Find the PDF page of a passage",
    description:
      "Find the physical PDF page on which a phrase appears, for citing a page number. Works only for precise parse results.",
    inputSchema: {
      type: "object",
      properties: {
        key: itemKey,
        query: { type: "string", description: "Phrase to find." },
        max_matches: { type: "integer", default: 20, minimum: 1, maximum: 100 },
        attachment_key: attachmentKey,
        library_id: libraryID,
      },
      required: ["key", "query"],
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const found = (await ctx.service.queryMarkdown({
        ...paperRef(args, ctx),
        granularity: "locate",
        q: args.query,
        contextParagraphs: 0,
      })) as PaperHeader & { matches: MarkdownLocateMatch[] };
      return formatLocateMatches(
        found,
        args.query,
        found.matches.slice(0, args.max_matches),
        found.matches.length,
      );
    },
  },
  {
    name: "mineru_read_markdown",
    title: "Read a parsed paper's full Markdown",
    description:
      "Read the whole Markdown of a parsed paper, in pages of max_chars characters; the answer says which offset continues it. Prefer mineru_read_section or mineru_search_in_paper when you need one part. The answer also names the stored file, which you can hand to a subagent or another tool instead of reading every page here.",
    inputSchema: {
      type: "object",
      properties: {
        key: itemKey,
        offset: {
          type: "integer",
          default: 0,
          minimum: 0,
          description: "Character at which to start; 0 for the beginning.",
        },
        max_chars: {
          type: "integer",
          default: 40000,
          minimum: 1000,
          maximum: 80000,
        },
        plain,
        attachment_key: attachmentKey,
        library_id: libraryID,
      },
      required: ["key"],
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const paper = (await ctx.service.queryMarkdown({
        ...paperRef(args, ctx),
        granularity: "full",
        includeFilePath: true,
      })) as PaperHeader & { content: string };
      const total = paper.content.length;
      // Reserve room for the formatted header so capResult() never slices off
      // trailing text after `page.end` was already chosen.
      const headerChars = formatMarkdownPage(paper, {
        start: total,
        end: Math.max(0, total - 1),
        total,
        text: "",
      }).length;
      const pageLimit = Math.max(
        1,
        Math.min(args.max_chars, MAX_RESULT_CHARS - headerChars - 16),
      );
      // Offsets count characters of the stored text, so tags are removed last.
      const page = slicePage(paper.content, args.offset, pageLimit);
      return formatMarkdownPage(paper, {
        ...page,
        text: maybePlain(args, page.text),
      });
    },
  },
  {
    name: "mineru_parse_pdf",
    title: "Parse a PDF with MinerU",
    description:
      "Start a MinerU parse for a PDF that has no result yet (state none or failed in mineru_collection_status, or a parse-result-not-found error). Parsing spends the user's MinerU quota: parse the one or two PDFs a task needs, and ask the user before parsing more. A PDF that already has a current result is not parsed again unless force is set. The call waits for the parse up to about 45 seconds and otherwise answers running; a long PDF takes several minutes.",
    inputSchema: {
      type: "object",
      properties: {
        key: itemKey,
        attachment_key: attachmentKey,
        force: {
          type: "boolean",
          default: false,
          description:
            "Parse again and replace the existing result. Only when the user asks for a fresh parse.",
        },
        wait: {
          type: "boolean",
          default: true,
          description: "Wait for the parse to finish before answering.",
        },
        library_id: libraryID,
      },
      required: ["key"],
    },
    annotations: {
      readOnlyHint: false,
      // `force` replaces a stored result, and every parse spends quota.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const ref = paperRef(args, ctx);
      const submitted = await ctx.service.triggerParse({
        ...ref,
        force: args.force,
      });
      if (!args.wait || submitted.status === "already-parsed") {
        return formatParseResult(submitted.key, submitted.status);
      }

      for (;;) {
        const { tasks } = (await ctx.service.getTasks()) as {
          tasks: TaskSummary[];
        };
        const task = tasks.find(
          (candidate) =>
            candidate.key === submitted.key &&
            candidate.libraryID === ref.libraryID,
        );
        // A record last touched before this request is the previous parse of
        // the same PDF, seen before the parse manager has reset it.
        const isCurrent =
          task !== undefined &&
          (task.updatedAt ?? Infinity) >= (submitted.submittedAt ?? 0);
        if (isCurrent && FINISHED_TASK_STATUSES.has(task.status)) {
          const text = formatParseResult(submitted.key, task.status, task);
          if (task.status === "failed") {
            throw new ToolError(text);
          }
          return text;
        }
        if (ctx.now() + PARSE_POLL_MS + DEADLINE_MARGIN_MS > ctx.deadline) {
          if (!isCurrent) {
            throw new ToolError(
              formatParseResult(submitted.key, "not-started", task),
            );
          }
          return formatParseResult(submitted.key, "running", task);
        }
        await ctx.sleep(PARSE_POLL_MS);
      }
    },
  },
  {
    name: "mineru_list_tasks",
    title: "List MinerU parse tasks",
    description:
      "List MinerU parse tasks, newest first, with status (pending, running, succeeded, failed, cancelled), progress and error text. Use it to follow a parse started with mineru_parse_pdf.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 30, minimum: 1, maximum: 200 },
      },
    },
    annotations: READ_ONLY,
    async handler(args, ctx) {
      const { tasks } = (await ctx.service.getTasks()) as {
        tasks: TaskSummary[];
      };
      return formatTasks(tasks.slice(0, args.limit), tasks.length);
    },
  },
];

// prepareArgs() rejects unknown arguments; advertise that to clients.
for (const tool of TOOLS) {
  tool.inputSchema.additionalProperties = false;
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
