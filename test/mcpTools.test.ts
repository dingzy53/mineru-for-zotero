import { assert } from "chai";
import type { MarkdownQueryService } from "../src/modules/markdownQuery/queryService";
import { MarkdownQueryError } from "../src/modules/markdownQuery/types";
import {
  MAX_RESULT_CHARS,
  TOOL_BUDGET_MS,
  capResult,
  runTool,
} from "../src/modules/mcp/runTool";
import { TOOLS, TOOLS_BY_NAME, slicePage } from "../src/modules/mcp/tools";

const PAPER = {
  item: {
    itemID: 1,
    libraryID: 1,
    key: "ITEM0001",
    type: "regular",
    title: "A Paper",
  },
  attachment: { key: "PDF00001", fileName: "paper.pdf" },
  result: { mode: "precise" },
};

/** Calls recorded by the fake service, as `[method, input]`. */
type Calls = Array<[string, unknown]>;

/** A service that records its calls and answers from `overrides`. */
function fakeService(
  overrides: Partial<Record<keyof MarkdownQueryService, (input: any) => any>>,
  calls: Calls = [],
): MarkdownQueryService {
  return new Proxy({} as MarkdownQueryService, {
    get(_target, method: string) {
      return async (input: unknown) => {
        calls.push([method, input]);
        const answer = overrides[method as keyof MarkdownQueryService];
        if (!answer) {
          throw new Error(`unexpected service call: ${method}`);
        }
        return answer(input);
      };
    },
  });
}

async function run(
  name: string,
  args: unknown,
  overrides: Parameters<typeof fakeService>[0],
  calls: Calls = [],
) {
  return runTool(TOOLS_BY_NAME.get(name)!, args, {
    service: fakeService(overrides, calls),
    defaultLibraryID: () => 1,
  });
}

async function text(
  name: string,
  args: unknown,
  overrides: Parameters<typeof fakeService>[0],
  calls: Calls = [],
): Promise<string> {
  const outcome = await run(name, args, overrides, calls);
  if (!outcome.ok) {
    assert.fail(`tool failed: ${outcome.message}`);
  }
  return outcome.text;
}

async function failure(
  name: string,
  args: unknown,
  overrides: Parameters<typeof fakeService>[0] = {},
): Promise<string> {
  const outcome = await run(name, args, overrides);
  if (outcome.ok) {
    assert.fail(`tool succeeded: ${outcome.text}`);
  }
  return outcome.message;
}

describe("MCP tools", function () {
  it("defines unique, described, annotated tools", function () {
    assert.lengthOf(TOOLS, 11);
    assert.equal(TOOLS_BY_NAME.size, TOOLS.length);
    for (const tool of TOOLS) {
      assert.match(tool.name, /^mineru_[a-z_]+$/);
      assert.isAbove(tool.description.length, 40, tool.name);
      assert.equal(tool.inputSchema.type, "object", tool.name);
      assert.isFalse(tool.inputSchema.additionalProperties, tool.name);
      assert.isFalse(
        tool.annotations.openWorldHint && tool.annotations.readOnlyHint,
      );
    }
    const writers = TOOLS.filter((tool) => !tool.annotations.readOnlyHint);
    assert.deepEqual(
      writers.map((tool) => [tool.name, tool.annotations.destructiveHint]),
      [["mineru_parse_pdf", true]],
    );
  });

  it("lists libraries and collections as paths", async function () {
    const calls: Calls = [];
    const out = await text(
      "mineru_list_collections",
      {},
      {
        getLibraries: () => ({
          libraries: [{ libraryID: 1, name: "My Library", type: "user" }],
        }),
        getCollections: () => ({
          libraryID: 1,
          collections: [
            {
              id: 2,
              key: "SUB00001",
              name: "Reading",
              libraryID: 1,
              parentKey: "TOP00001",
            },
            { id: 1, key: "TOP00001", name: "UGRP", libraryID: 1 },
          ],
        }),
      },
      calls,
    );

    assert.include(out, "- library_id 1: My Library (user)");
    assert.include(out, "Collections in library 1: 2");
    assert.match(out, /- UGRP \| TOP00001\n- UGRP\/Reading \| SUB00001$/);
    assert.deepInclude(calls, ["getCollections", { libraryID: 1 }]);
  });

  it("lists tags with the default limit", async function () {
    const calls: Calls = [];
    const out = await text(
      "mineru_list_tags",
      { library_id: 5 },
      {
        getTags: () => ({
          libraryID: 5,
          tags: [{ tag: "ai", numItems: 3 }, { tag: "ml" }],
        }),
      },
      calls,
    );

    assert.equal(out, "Tags in library 5: 2\n- ai (3)\n- ml");
    assert.deepEqual(calls, [["getTags", { libraryID: 5, limit: 100 }]]);
  });

  it("groups a collection status report by parse state", async function () {
    const calls: Calls = [];
    const out = await text(
      "mineru_collection_status",
      { collection: "UGRP", include_subcollections: true },
      {
        getCollectionStatus: () => ({
          libraryID: 1,
          collection: "UGRP",
          includeSubcollections: true,
          totals: { items: 3, parsed: 1, notParsed: 1, noPdf: 1 },
          items: [
            {
              key: "ITEM0001",
              title: "Parsed Paper",
              year: "2022",
              firstCreator: "Chen, Wei",
              attachments: [
                {
                  key: "PDF00001",
                  fileName: "a.pdf",
                  state: "precise",
                  words: 8421,
                },
                { key: "PDF00002", fileName: "b.pdf", state: "none" },
              ],
            },
            {
              key: "ITEM0002",
              title: "Waiting Paper",
              attachments: [
                { key: "PDF00003", fileName: "c.pdf", state: "running" },
              ],
            },
            {
              key: "ITEM0003",
              title: "Web Page",
              year: "2020",
              attachments: [],
            },
          ],
        }),
      },
      calls,
    );

    assert.deepEqual(calls, [
      [
        "getCollectionStatus",
        { libraryID: 1, collection: "UGRP", includeSubcollections: true },
      ],
    ]);
    assert.include(out, "Collection: UGRP (with subcollections) | library 1");
    assert.include(out, "Items: 3 | parsed: 1 | not parsed: 1 | no PDF: 1");
    assert.include(
      out,
      "[Parsed] 1\n- ITEM0001 | Chen, Wei, 2022 | Parsed Paper | PDF00001 precise 8421 words; PDF00002 none\n",
    );
    assert.include(
      out,
      "[Not parsed] 1\n- ITEM0002 | unknown | Waiting Paper | PDF00003 running\n",
    );
    assert.match(out, /\[No PDF\] 1\n- ITEM0003 \| 2020 \| Web Page$/);
  });

  it("searches items with the service's filter names", async function () {
    const calls: Calls = [];
    const out = await text(
      "mineru_search_items",
      {
        creator: "Chen",
        year: "2022",
        item_type: "journalArticle",
        parsed_only: true,
        title: "",
      },
      {
        searchByTitle: () => ({
          candidates: [
            {
              item: {
                key: "ITEM0001",
                title: "Parsed Paper",
                year: "2022",
                creators: ["Chen, Wei", "Li, Na"],
                itemType: "journalArticle",
                publication: "Nature",
                doi: "10.1/x",
              },
              attachments: [
                {
                  key: "PDF00001",
                  fileName: "a.pdf",
                  preciseReady: true,
                  liteReady: false,
                },
                {
                  key: "PDF00002",
                  fileName: "b.pdf",
                  preciseReady: false,
                  liteReady: false,
                },
              ],
            },
          ],
        }),
      },
      calls,
    );

    assert.deepEqual(calls, [
      [
        "searchByTitle",
        {
          libraryID: 1,
          creator: "Chen",
          year: "2022",
          itemType: "journalArticle",
          parsedOnly: true,
          limit: 20,
        },
      ],
    ]);
    assert.equal(
      out,
      [
        "Items: 1 | library 1",
        "",
        "1. ITEM0001 | Chen, Wei; Li, Na, 2022 | Parsed Paper",
        "   journalArticle | Nature | doi 10.1/x",
        "   PDFs: PDF00001 precise; PDF00002 not parsed",
      ].join("\n"),
    );
  });

  it("rejects a search without filters or with a malformed year", async function () {
    assert.match(
      await failure("mineru_search_items", { limit: 5, sort_by: "title" }),
      /Give at least one filter/,
    );
    assert.match(
      await failure("mineru_search_items", { title: "   " }),
      /Give at least one filter/,
    );
    assert.match(
      await failure("mineru_search_items", { year: "22" }),
      /year must be four digits/,
    );
  });

  it("prints an outline as section paths with size and file", async function () {
    const calls: Calls = [];
    const out = await text(
      "mineru_get_outline",
      { key: "ITEM0001" },
      {
        queryMarkdown: () => ({
          ...PAPER,
          result: {
            mode: "precise",
            file: "/data/mineru-copy/attachments/1-PDF00001/content.md",
          },
          content: "# A Paper\n\nIntro words.\n\n## 3. Method\n\nBody.",
        }),
      },
      calls,
    );

    assert.deepEqual(calls, [
      [
        "queryMarkdown",
        {
          libraryID: 1,
          key: "ITEM0001",
          attachmentKey: undefined,
          granularity: "full",
          includeFilePath: true,
        },
      ],
    ]);
    assert.equal(
      out,
      [
        "Title: A Paper",
        "Item: ITEM0001 | PDF: PDF00001 (paper.pdf) | Parse: precise",
        "Size: 9 words, 44 characters",
        "File: /data/mineru-copy/attachments/1-PDF00001/content.md",
        "",
        "Headings: 2 (each line is a section_path for mineru_read_section)",
        '["A Paper"]',
        '["A Paper","3. Method"]',
      ].join("\n"),
    );
  });

  it("reads a section by its path array", async function () {
    const calls: Calls = [];
    const out = await text(
      "mineru_read_section",
      {
        key: "ITEM0001",
        section_path: ["A Paper", "3. Method"],
        include_subsections: true,
        plain: true,
        attachment_key: "PDF00001",
      },
      {
        queryMarkdown: () => ({
          ...PAPER,
          result: { mode: "lite" },
          heading: {
            level: 2,
            title: "3. Method",
            path: ["A Paper", "3. Method"],
            line: 4,
          },
          content: "## 3. Method\n\nCO<sub>2</sub> rose.",
        }),
      },
      calls,
    );

    assert.deepEqual(calls[0][1], {
      libraryID: 1,
      key: "ITEM0001",
      attachmentKey: "PDF00001",
      granularity: "section",
      sectionPath: ["A Paper", "3. Method"],
      includeSubsections: true,
    });
    assert.include(out, "Parse: lite (text only; no page positions)");
    assert.match(
      out,
      /Section: \["A Paper","3\. Method"\]\n\n## 3\. Method\n\nCO2 rose\.$/,
    );
  });

  it("limits and marks search matches", async function () {
    const match = (index: number) => ({
      paragraphIndex: index,
      before: ["Before <b>it</b>."],
      hit: `Hit ${index} with CO<sub>2</sub>.`,
      after: ["After it."],
      context: "unused",
    });
    const calls: Calls = [];
    const overrides = {
      queryMarkdown: () => ({
        ...PAPER,
        matches: [match(3), match(7), match(9)],
      }),
    };
    const out = await text(
      "mineru_search_in_paper",
      { key: "ITEM0001", query: "CO2", max_matches: 2 },
      overrides,
      calls,
    );
    const plainOut = await text(
      "mineru_search_in_paper",
      { key: "ITEM0001", query: "CO2", plain: true },
      overrides,
    );

    assert.propertyVal(calls[0][1] as object, "q", "CO2");
    assert.propertyVal(calls[0][1] as object, "contextParagraphs", 1);
    assert.include(out, "Matches: 3 (showing the first 2;");
    assert.include(
      out,
      "[Match 2] paragraph 7\n\nBefore <b>it</b>.\n\n>> Hit 7 with CO<sub>2</sub>.\n\nAfter it.",
    );
    assert.notInclude(out, "Hit 9");
    assert.include(plainOut, "Matches: 3\n");
    assert.include(plainOut, "Before it.\n\n>> Hit 9 with CO2.");
  });

  it("reports physical pages for located passages", async function () {
    const out = await text(
      "mineru_locate_in_pdf",
      { key: "ITEM0001", query: "emissions" },
      {
        queryMarkdown: () => ({
          ...PAPER,
          matches: [
            {
              boxIndex: 4,
              page: 3,
              type: "text",
              hit: "Global emissions rose.",
              context: "",
            },
            {
              boxIndex: 9,
              page: 12,
              type: "table",
              hit: "x".repeat(600),
              context: "",
            },
          ],
        }),
      },
    );

    assert.include(out, "Matches: 2\n");
    assert.include(out, "[Match 1] page 3 (text)\nGlobal emissions rose.");
    assert.include(out, `[Match 2] page 12 (table)\n${"x".repeat(500)}…`);
  });

  it("pages through the full Markdown at paragraph breaks", async function () {
    const content = [
      "# A Paper",
      "a".repeat(900),
      "b".repeat(900),
      "c".repeat(100),
    ].join("\n\n");
    const overrides = {
      queryMarkdown: () => ({
        ...PAPER,
        result: { mode: "precise", file: "/data/content.md" },
        content,
      }),
    };
    const first = await text(
      "mineru_read_markdown",
      { key: "ITEM0001", max_chars: 1000 },
      overrides,
    );
    const next = Number(/offset (\d+)/.exec(first)?.[1]);
    const rest = await text(
      "mineru_read_markdown",
      { key: "ITEM0001", offset: next, max_chars: 80000 },
      overrides,
    );

    assert.equal(next, "# A Paper".length + 2 + 900 + 2);
    assert.include(
      first,
      `Characters: 0-${next} of ${content.length} | more: call again with offset ${next}`,
    );
    assert.include(first, "File: /data/content.md");
    assert.isTrue(first.endsWith(`${"a".repeat(900)}\n\n`));
    assert.include(
      rest,
      `Characters: ${next}-${content.length} of ${content.length} | end of document`,
    );
    assert.isTrue(rest.endsWith(`${"b".repeat(900)}\n\n${"c".repeat(100)}`));
  });

  it("slices pages without a paragraph break at the size limit", function () {
    assert.deepEqual(slicePage("abcdefghij", 2, 4), {
      start: 2,
      end: 6,
      total: 10,
      text: "cdef",
    });
    assert.deepEqual(slicePage("abc", 10, 4), {
      start: 3,
      end: 3,
      total: 3,
      text: "",
    });
    // A paragraph break ending after maxChars must not push end past maxChars
    assert.deepEqual(slicePage("aaaaa\n\nbbb", 0, 6), {
      start: 0,
      end: 6,
      total: 10,
      text: "aaaaa\n",
    });
    assert.deepEqual(slicePage("aaaa\n\nbbbb", 0, 6), {
      start: 0,
      end: 6,
      total: 10,
      text: "aaaa\n\n",
    });
  });

  it("pages documents larger than MAX_RESULT_CHARS at max_chars without data loss", async function () {
    const paragraphs = Array.from(
      { length: 105 },
      (_, i) => `P${String(i).padStart(3, "0")} ${"x".repeat(890)}`,
    );
    const content = paragraphs.join("\n\n");
    assert.isAbove(content.length, MAX_RESULT_CHARS);
    const overrides = {
      queryMarkdown: () => ({
        ...PAPER,
        result: { mode: "precise", file: "/data/content.md" },
        content,
      }),
    };
    let offset = 0;
    let assembled = "";
    for (let pages = 0; pages < 10; pages++) {
      const page = await text(
        "mineru_read_markdown",
        { key: "ITEM0001", offset, max_chars: MAX_RESULT_CHARS },
        overrides,
      );
      assert.notInclude(page, "[Cut at ");
      assert.isAtMost(page.length, MAX_RESULT_CHARS);
      const splitAt = page.indexOf("\n\n");
      assert.isAbove(splitAt, 0);
      assembled += page.slice(splitAt + 2);
      const more = /more: call again with offset (\d+)/.exec(
        page.slice(0, splitAt),
      );
      if (!more) {
        assert.include(page.slice(0, splitAt), "end of document");
        break;
      }
      offset = Number(more[1]);
    }
    assert.equal(assembled, content);
  });

  describe("mineru_parse_pdf", function () {
    /** Runs the parse tool with a clock that only `sleep` advances. */
    async function parse(input: {
      args?: Record<string, unknown>;
      submitted: Record<string, unknown>;
      taskLists?: unknown[][];
    }) {
      const calls: Calls = [];
      let clock = 1_000_000;
      let polls = 0;
      const lists = input.taskLists ?? [[]];
      const outcome = await runTool(
        TOOLS_BY_NAME.get("mineru_parse_pdf")!,
        { key: "ITEM0001", ...input.args },
        {
          service: fakeService(
            {
              triggerParse: () => input.submitted,
              getTasks: () => ({
                tasks: lists[Math.min(polls++, lists.length - 1)],
              }),
            },
            calls,
          ),
          defaultLibraryID: () => 1,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
        },
      );
      return {
        text: outcome.ok ? outcome.text : `ERROR ${outcome.message}`,
        calls,
        polls,
        elapsed: clock - 1_000_000,
      };
    }

    const submitted = {
      status: "submitted",
      itemID: 9,
      key: "PDF00001",
      submittedAt: 1000,
    };
    const task = { id: "9", libraryID: 1, key: "PDF00001", title: "A Paper" };

    it("does not wait when the PDF is already parsed", async function () {
      const result = await parse({
        submitted: { status: "already-parsed", itemID: 9, key: "PDF00001" },
      });

      assert.deepEqual(result.calls, [
        [
          "triggerParse",
          {
            libraryID: 1,
            key: "ITEM0001",
            attachmentKey: undefined,
            force: false,
          },
        ],
      ]);
      assert.include(result.text, "PDF: PDF00001\nStatus: already-parsed");
      assert.include(result.text, "Pass force only if the user asks");
    });

    it("waits for success and ignores the previous record", async function () {
      const result = await parse({
        args: { force: true },
        submitted,
        taskLists: [
          [{ ...task, status: "succeeded", progress: 100, updatedAt: 500 }],
          [
            { ...task, key: "OTHER001", status: "failed", updatedAt: 2000 },
            { ...task, status: "running", progress: 40, updatedAt: 1500 },
          ],
          [{ ...task, status: "succeeded", progress: 100, updatedAt: 2500 }],
        ],
      });

      assert.propertyVal(result.calls[0][1] as object, "force", true);
      assert.equal(result.polls, 3);
      assert.include(result.text, "Status: succeeded\nprogress: 100%");
      assert.include(result.text, "Read it with mineru_get_outline");
    });

    it("reports MinerU's error for a failed parse as a tool error", async function () {
      const result = await parse({
        submitted,
        taskLists: [
          [
            {
              ...task,
              status: "failed",
              error: "daily limit (code -60018)",
              updatedAt: 3000,
            },
          ],
        ],
      });

      assert.match(result.text, /^ERROR PDF: PDF00001/);
      assert.include(
        result.text,
        "Status: failed\nerror: daily limit (code -60018)",
      );
      assert.include(result.text, "a retry spends quota again");
    });

    it("reports not-started as a tool error if no current task record appears before the deadline", async function () {
      const result = await parse({
        submitted,
        taskLists: [
          [
            {
              ...task,
              status: "failed",
              error: "previous failure",
              updatedAt: 500,
            },
          ],
        ],
      });

      assert.match(result.text, /^ERROR PDF: PDF00001/);
      assert.include(result.text, "Status: not-started");
      assert.include(result.text, "did not start in Zotero");
    });

    it("answers running before the time budget ends", async function () {
      const result = await parse({
        submitted,
        taskLists: [
          [{ ...task, status: "running", progress: 20, updatedAt: 1500 }],
        ],
      });

      assert.include(result.text, "Status: running\nprogress: 20%");
      assert.include(result.text, "do not submit it again");
      assert.isBelow(result.elapsed, TOOL_BUDGET_MS);
      assert.isAbove(result.elapsed, TOOL_BUDGET_MS - 10_000);
    });

    it("answers at once without wait", async function () {
      const result = await parse({ args: { wait: false }, submitted });

      assert.equal(result.polls, 0);
      assert.include(result.text, "Status: submitted");
    });

    it("handles already-running and cancelled parses", async function () {
      const noWait = await parse({
        args: { wait: false },
        submitted: { status: "already-running", itemID: 9, key: "PDF00001" },
      });
      assert.equal(noWait.polls, 0);
      assert.include(noWait.text, "Status: already-running");

      const waited = await parse({
        submitted: { status: "already-running", itemID: 9, key: "PDF00001" },
        taskLists: [[{ ...task, status: "succeeded", progress: 100 }]],
      });
      assert.equal(waited.polls, 1);
      assert.include(waited.text, "Status: succeeded");

      const cancelled = await parse({
        submitted,
        taskLists: [[{ ...task, status: "cancelled", updatedAt: 2000 }]],
      });
      assert.include(cancelled.text, "Status: cancelled");
      assert.include(cancelled.text, "stopped in Zotero");
    });
  });

  it("lists the newest tasks up to the limit", async function () {
    const out = await text(
      "mineru_list_tasks",
      { limit: 1 },
      {
        getTasks: () => ({
          tasks: [
            {
              id: "9",
              libraryID: 1,
              key: "PDF00001",
              title: "A Paper",
              status: "running",
              progress: 40,
              detail: "Chunk 2 of 5",
            },
            {
              id: "8",
              libraryID: 1,
              key: "PDF00002",
              title: "Older",
              status: "succeeded",
            },
          ],
        }),
      },
    );

    assert.equal(
      out,
      [
        "Parse tasks: 2 (showing the newest 1)",
        "",
        "1. A Paper",
        "   PDF: PDF00001 | library 1 | status: running",
        "   progress: 40%",
        "   detail: Chunk 2 of 5",
      ].join("\n"),
    );
  });

  describe("failures", function () {
    it("reports argument mistakes without calling the service", async function () {
      assert.equal(
        await failure("mineru_get_outline", {}),
        'Missing required argument "key"',
      );
      assert.equal(
        await failure("mineru_get_outline", { key: "A", libraryID: 1 }),
        'Unknown argument "libraryID". Did you mean "library_id"? Accepted arguments: key, attachment_key, library_id',
      );
      assert.match(
        await failure("mineru_read_markdown", { key: "A", max_chars: 500 }),
        /max_chars must be ≥ 1000/,
      );
    });

    it("turns query errors into a message with the next step", async function () {
      const throwing = (error: MarkdownQueryError) => ({
        queryMarkdown: () => {
          throw error;
        },
      });

      assert.equal(
        await failure(
          "mineru_get_outline",
          { key: "ITEM0001" },
          throwing(
            new MarkdownQueryError(
              "parse-result-not-found",
              404,
              "Target PDF has no available parse result",
            ),
          ),
        ),
        "parse-result-not-found: Target PDF has no available parse result\nThis PDF has not been parsed yet. mineru_parse_pdf can start a parse (it spends the user's MinerU quota), or pass attachment_key for another PDF of the item.",
      );
      assert.equal(
        await failure(
          "mineru_get_outline",
          { key: "ITEM0001" },
          throwing(
            new MarkdownQueryError(
              "ambiguous-attachment",
              409,
              "Multiple PDFs",
              {
                candidates: [
                  {
                    key: "PDF00001",
                    fileName: "a.pdf",
                    preciseReady: true,
                    liteReady: false,
                  },
                  {
                    key: "PDF00002",
                    fileName: "b.pdf",
                    preciseReady: false,
                    liteReady: false,
                  },
                ],
              },
            ),
          ),
        ),
        "ambiguous-attachment: Multiple PDFs\n- PDF00001 a.pdf (precise)\n- PDF00002 b.pdf (not parsed)\nCall again with attachment_key set to one of the candidate keys.",
      );
      const secErr = await failure(
        "mineru_read_section",
        { key: "ITEM0001", section_path: ["Nope"] },
        throwing(
          new MarkdownQueryError(
            "section-not-found",
            404,
            "section-not-found",
            { suggestions: [["Paper Title", "1. Introduction"]] },
          ),
        ),
      );
      assert.match(
        secErr,
        /Call mineru_get_outline and copy one of its section_path lines exactly/,
      );
      assert.notInclude(secErr, "section-not-found: section-not-found");
      assert.include(
        secErr,
        'Closest headings:\n- ["Paper Title","1. Introduction"]',
      );

      const localUnparsed = await runTool(
        TOOLS_BY_NAME.get("mineru_get_outline")!,
        { key: "ITEM0001" },
        {
          service: fakeService(
            throwing(
              new MarkdownQueryError(
                "parse-result-not-found",
                404,
                "Target PDF has no available parse result",
              ),
            ),
          ),
          defaultLibraryID: () => 1,
          parseSource: () => "local",
        },
      );
      assert.isFalse(localUnparsed.ok);
      if (!localUnparsed.ok) {
        assert.include(localUnparsed.message, "local MinerU server");
        assert.notInclude(localUnparsed.message, "quota");
      }

      const colOut = await text(
        "mineru_collection_status",
        { collection: "mimmc" },
        {
          getCollectionStatus: () => ({
            libraryID: 1,
            collection: "mimmc",
            collectionName: "MIMMC",
            collectionKey: "COL00001",
            includeSubcollections: false,
            totals: { items: 0, parsed: 0, notParsed: 0, noPdf: 0 },
            items: [],
          }),
        },
      );
      assert.include(colOut, "Collection: MIMMC (COL00001) | library 1");

      const strippedMd = await text(
        "mineru_read_markdown",
        { key: "ITEM0001" },
        {
          queryMarkdown: () => ({
            ...PAPER,
            granularity: "full",
            content:
              "# Intro\n\n![Fig 1](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==)\n\nBody text.",
          }),
        },
      );
      assert.include(strippedMd, "![Fig 1](embedded image omitted)");
      assert.notInclude(strippedMd, "data:image/");
      assert.include(strippedMd, "Body text.");
      const hintCases: Array<[MarkdownQueryError["code"], RegExp]> = [
        ["item-not-found", /mineru_search_items and mineru_collection_status/],
        ["pdf-attachment-not-found", /no PDF attachment/],
        ["attachment-not-found", /attachment_key must be one/],
        ["collection-not-found", /Call mineru_list_collections/],
        ["ambiguous-section", /Several headings share this path/],
        ["missing-query", /Pass a non-empty query/],
      ];
      for (const [code, pattern] of hintCases) {
        assert.match(
          await failure(
            "mineru_get_outline",
            { key: "ITEM0001" },
            throwing(new MarkdownQueryError(code, 400, code)),
          ),
          pattern,
          code,
        );
      }
    });

    it("reports and logs unexpected errors", async function () {
      const logged: unknown[] = [];
      const outcome = await runTool(
        TOOLS_BY_NAME.get("mineru_list_tasks")!,
        {},
        {
          service: fakeService({
            getTasks: () => {
              throw new Error("disk on fire");
            },
          }),
          defaultLibraryID: () => 1,
          logError: (error) => logged.push(error),
        },
      );

      assert.deepEqual(outcome, {
        ok: false,
        message: "Internal error: disk on fire",
      });
      assert.lengthOf(logged, 1);
    });
  });

  it("cuts an over-long result and says so", function () {
    const long = `${"line\n".repeat(MAX_RESULT_CHARS / 5)}tail tail tail`;
    const cut = capResult(long);

    assert.equal(capResult("short"), "short");
    assert.isBelow(cut.length, MAX_RESULT_CHARS + 300);
    assert.match(
      cut,
      new RegExp(
        `\\[Cut at ${MAX_RESULT_CHARS - 1} of ${long.length} characters\\. Narrow the request`,
      ),
    );
    assert.notInclude(cut, "tail");
  });
});
