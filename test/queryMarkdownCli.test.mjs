/* global URL, process */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(
  new URL(
    "../mineru-for-zotero-cli/scripts/query-markdown.mjs",
    import.meta.url,
  ),
);

test("formats search results as agent-friendly text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        candidates: [
          {
            item: {
              itemID: 123,
              libraryID: 1,
              key: "ABCD1234",
              type: "regular",
              title: "Example Paper",
            },
            attachments: [
              {
                itemID: 456,
                libraryID: 1,
                key: "PDFKEY01",
                fileName: "paper.pdf",
                preciseReady: true,
                liteReady: false,
              },
            ],
          },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "search",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--title",
        "retrieval",
        "--format",
        "text",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Markdown Query Search/);
      assert.match(result.stdout, /Candidates: 1/);
      assert.match(result.stdout, /1\. Example Paper/);
      assert.match(result.stdout, /parsed: precise=yes lite=no/);
      assert.equal(result.stderr, "");
      assert.equal(requests[0].pathname, "/mineru-for-zotero/search");
      assert.equal(requests[0].searchParams.libraryID, "1");
      assert.equal(requests[0].searchParams.title, "retrieval");
    },
  );
});

test("formats markdown headings as json envelope without auth headers", async () => {
  await withServer(
    {
      status: 200,
      body: {
        item: {
          itemID: 123,
          libraryID: 1,
          key: "ABCD1234",
          type: "regular",
          title: "Example Paper",
        },
        attachment: {
          itemID: 456,
          libraryID: 1,
          key: "PDFKEY01",
          fileName: "paper.pdf",
        },
        result: {
          mode: "precise",
          source: "preferred",
        },
        granularity: "headings",
        headings: [
          {
            level: 2,
            title: "Introduction",
            path: ["Example Paper", "Introduction"],
            line: 8,
          },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "markdown",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "ABCD1234",
        "--granularity",
        "headings",
        "--format",
        "json",
      ]);

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.equal(requests[0].headers.authorization, undefined);

      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, true);
      assert.equal(output.status, 200);
      assert.equal(output.request.command, "markdown");
      assert.equal(output.request.endpoint, "/mineru-for-zotero/markdown");
      assert.deepEqual(output.request.params, {
        libraryID: "1",
        key: "ABCD1234",
        granularity: "headings",
      });
      assert.equal(output.data.headings[0].title, "Introduction");
    },
  );
});

test("formats markdown search matches as text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        item: {
          itemID: 123,
          libraryID: 1,
          key: "ABCD1234",
          type: "regular",
          title: "Example Paper",
        },
        attachment: {
          itemID: 456,
          libraryID: 1,
          key: "PDFKEY01",
          fileName: "paper.pdf",
        },
        result: {
          mode: "lite",
          source: "preferred",
        },
        granularity: "search",
        query: "retrieval",
        matches: [
          {
            paragraphIndex: 3,
            before: ["Previous paragraph."],
            hit: "This paragraph mentions retrieval.",
            after: ["Next paragraph."],
            context:
              "Previous paragraph.\n\nThis paragraph mentions retrieval.\n\nNext paragraph.",
          },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "markdown",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "ABCD1234",
        "--granularity",
        "search",
        "--query",
        "retrieval",
        "--context-paragraphs",
        "2",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Granularity: search/);
      assert.match(result.stdout, /Mode: lite/);
      assert.match(result.stdout, /Matches: 1/);
      assert.match(result.stdout, />> This paragraph mentions retrieval\./);
      assert.equal(requests[0].searchParams.q, "retrieval");
      assert.equal(requests[0].searchParams.contextParagraphs, "2");
    },
  );
});

test("formats api errors as json and exits with code 1", async () => {
  await withServer(
    {
      status: 404,
      body: {
        error: "parse-result-not-found",
        message: "Target PDF has no available parse result",
      },
    },
    async ({ port }) => {
      const result = await runCli([
        "markdown",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "ABCD1234",
        "--format",
        "json",
      ]);

      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.ok, false);
      assert.equal(output.status, 404);
      assert.deepEqual(output.error, {
        code: "parse-result-not-found",
        message: "Target PDF has no available parse result",
        details: {},
      });
    },
  );
});

test("prints parameter errors to stderr and exits with code 2", async () => {
  const result = await runCli(["markdown", "--library-id", "1"]);

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Missing required option: --key/);
  assert.match(result.stderr, /Usage:/);
});

test("discovers the listen port from the default Zotero profile", async () => {
  await withServer(
    {
      status: 200,
      body: {
        candidates: [],
      },
    },
    async ({ port, requests }) => {
      await withZoteroProfile(port, async ({ env }) => {
        const result = await runCli(
          [
            "search",
            "--library-id",
            "1",
            "--title",
            "retrieval",
            "--format",
            "json",
          ],
          { env },
        );

        assert.equal(result.code, 0);
        assert.equal(result.stderr, "");
        assert.equal(requests[0].pathname, "/mineru-for-zotero/search");

        const output = JSON.parse(result.stdout);
        assert.equal(output.request.baseUrl, `http://127.0.0.1:${port}`);
      });
    },
  );
});

test("formats creator/year search results as agent-friendly text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        candidates: [
          {
            item: {
              itemID: 29,
              libraryID: 1,
              key: "AGQEUI5S",
              type: "regular",
              title: "Energy-Saving Task Scheduling",
              year: "2022",
              creators: ["Chen, Qingfeng", "Han, Yu"],
            },
            attachments: [],
          },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "search",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--creator",
        "Chen",
        "--year",
        "2022",
        "--limit",
        "5",
        "--format",
        "text",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /1\. Energy-Saving Task Scheduling/);
      assert.match(result.stdout, /year: 2022/);
      assert.match(result.stdout, /creators: Chen, Qingfeng; Han, Yu/);
      assert.equal(requests[0].searchParams.creator, "Chen");
      assert.equal(requests[0].searchParams.year, "2022");
      assert.equal(requests[0].searchParams.limit, "5");
      assert.equal(requests[0].searchParams.title, undefined);
    },
  );
});

test("requires a title or creator for search", async () => {
  const result = await runCli(["search", "--library-id", "1"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Missing required option: --title or --creator/);
});

test("rejects malformed year values", async () => {
  const result = await runCli([
    "search",
    "--library-id",
    "1",
    "--title",
    "Doc",
    "--year",
    "22",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Invalid --year/);
});

const markdownServerBody = {
  item: {
    itemID: 123,
    libraryID: 1,
    key: "ABCD1234",
    type: "regular",
    title: "Example Paper",
  },
  attachment: {
    itemID: 456,
    libraryID: 1,
    key: "PDFKEY01",
    fileName: "paper.pdf",
  },
  result: { mode: "precise", source: "preferred" },
};

test("sends include-subsections switch to the API", async () => {
  await withServer(
    {
      status: 200,
      body: {
        ...markdownServerBody,
        granularity: "section",
        heading: { title: "A", path: ["Doc", "A"], line: 2 },
        content: "## A\n\nAlpha",
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "markdown",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "ABCD1234",
        "--granularity",
        "section",
        "--section-path",
        "Doc/A",
        "--include-subsections",
      ]);

      assert.equal(result.code, 0);
      assert.equal(requests[0].searchParams.includeSubsections, "true");
      assert.match(result.stdout, /Granularity: section/);
    },
  );
});

test("formats libraries as agent-friendly text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        libraries: [
          { libraryID: 1, name: "My Library", type: "user" },
          { libraryID: 2, name: "Lab Group", type: "group" },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "libraries",
        "--port",
        String(port),
        "--format",
        "text",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Zotero Libraries/);
      assert.match(result.stdout, /Count: 2/);
      assert.match(result.stdout, /1\. My Library/);
      assert.match(result.stdout, /2\. Lab Group/);
      assert.equal(requests[0].pathname, "/mineru-for-zotero/libraries");
    },
  );
});

test("formats collections as agent-friendly text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        libraryID: 1,
        collections: [
          { id: 10, key: "COL1", name: "AI", libraryID: 1 },
          { id: 11, key: "COL2", name: "LLM", libraryID: 1, parentKey: "COL1" },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "collections",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--parent-key",
        "COL1",
        "--format",
        "text",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Zotero Collections/);
      assert.match(result.stdout, /1\. AI/);
      assert.match(result.stdout, /2\. LLM/);
      assert.match(result.stdout, /parentKey: COL1/);
      assert.equal(requests[0].pathname, "/mineru-for-zotero/collections");
      assert.equal(requests[0].searchParams.libraryID, "1");
      assert.equal(requests[0].searchParams.parentKey, "COL1");
    },
  );
});

test("formats tags as agent-friendly text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        libraryID: 1,
        tags: [{ tag: "deep-learning", numItems: 15 }, { tag: "nlp" }],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "tags",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--limit",
        "20",
        "--format",
        "text",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Zotero Tags/);
      assert.match(result.stdout, /- deep-learning \(15 items\)/);
      assert.match(result.stdout, /- nlp/);
      assert.equal(requests[0].pathname, "/mineru-for-zotero/tags");
      assert.equal(requests[0].searchParams.libraryID, "1");
      assert.equal(requests[0].searchParams.limit, "20");
    },
  );
});

test("forwards rich search options to the search endpoint", async () => {
  await withServer(
    {
      status: 200,
      body: {
        candidates: [
          {
            item: {
              itemID: 123,
              libraryID: 1,
              key: "ABCD1234",
              type: "regular",
              title: "Attention Is All You Need",
              year: "2017",
              creators: ["Vaswani, Ashish"],
              itemType: "conferencePaper",
              publication: "NeurIPS",
              citekey: "vaswani2017attention",
              doi: "10.48550/arXiv.1706.03762",
            },
            attachments: [],
          },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "search",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--collection",
        "AI",
        "--abstract",
        "transformer",
        "--publication",
        "NeurIPS",
        "--citekey",
        "vaswani2017attention",
        "--doi",
        "10.48550",
        "--item-type",
        "conferencePaper",
        "--since",
        "2026-01-01",
        "--has-pdf",
        "--parsed-only",
        "--sort-by",
        "dateAdded",
        "--sort-order",
        "desc",
        "--limit",
        "10",
        "--format",
        "text",
      ]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /1\. Attention Is All You Need/);
      assert.match(result.stdout, /itemType: conferencePaper/);
      assert.match(result.stdout, /publication: NeurIPS/);
      assert.match(result.stdout, /citekey: vaswani2017attention/);
      assert.match(result.stdout, /doi: 10\.48550\/arXiv\.1706\.03762/);

      const params = requests[0].searchParams;
      assert.equal(params.collection, "AI");
      assert.equal(params.abstract, "transformer");
      assert.equal(params.publication, "NeurIPS");
      assert.equal(params.citekey, "vaswani2017attention");
      assert.equal(params.doi, "10.48550");
      assert.equal(params.itemType, "conferencePaper");
      assert.equal(params.since, "2026-01-01");
      assert.equal(params.hasPdf, "true");
      assert.equal(params.parsedOnly, "true");
      assert.equal(params.sortBy, "dateAdded");
      assert.equal(params.sortOrder, "desc");
      assert.equal(params.limit, "10");
    },
  );
});

test("hints at Zotero availability when the API is unreachable", async () => {
  // Nothing listens on port 1, so the connection is refused immediately.
  const result = await runCli([
    "markdown",
    "--port",
    "1",
    "--timeout-ms",
    "2000",
    "--library-id",
    "1",
    "--key",
    "ABCD1234",
  ]);

  assert.equal(result.code, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Error: network-error/);
  assert.match(result.stderr, /Zotero may not be running/);
  // Transport errors must not print the usage block; only argument errors do.
  assert.doesNotMatch(result.stderr, /Usage:/);
});

test("treats non-JSON responses as transport errors with exit code 3", async () => {
  const server = createServer((request, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not json");
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address();
    const result = await runCli(["libraries", "--port", String(port)]);

    assert.equal(result.code, 3);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: network-error/);
    assert.match(result.stderr, /non-JSON response/);
    assert.doesNotMatch(result.stderr, /Usage:/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

test("formats a collection status report grouped by parse state", async () => {
  await withServer(
    {
      status: 200,
      body: {
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
          { key: "ITEM0003", title: "Web Page", year: "2020", attachments: [] },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "status",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--collection",
        "UGRP",
        "--include-subcollections",
      ]);

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      assert.equal(requests[0].pathname, "/mineru-for-zotero/status");
      assert.deepEqual(requests[0].searchParams, {
        libraryID: "1",
        collection: "UGRP",
        includeSubcollections: "true",
      });
      assert.match(result.stdout, /Collection: UGRP \(with subcollections\)/);
      assert.match(
        result.stdout,
        /Items: 3 \| parsed: 1 \| not parsed: 1 \| no PDF: 1/,
      );
      assert.match(
        result.stdout,
        /\[Parsed\] 1\n- ITEM0001 \| Chen, Wei, 2022 \| Parsed Paper \| PDF00001 precise 8421 words; PDF00002 none\n/,
      );
      assert.match(
        result.stdout,
        /\[Not parsed\] 1\n- ITEM0002 \| unknown \| Waiting Paper \| PDF00003 running\n/,
      );
      assert.match(
        result.stdout,
        /\[No PDF\] 1\n- ITEM0003 \| 2020 \| Web Page\n$/,
      );
    },
  );
});

test("requires a collection for status", async () => {
  const result = await runCli(["status", "--library-id", "1"]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /Missing required option: --collection/);
});

test("writes full markdown to a file with --output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-output-"));
  const outputPath = join(dir, "paper.md");
  try {
    await withServer(
      {
        status: 200,
        body: {
          item: { key: "ABCD1234", title: "Example Paper" },
          attachment: { key: "PDFKEY01", fileName: "paper.pdf" },
          result: { mode: "precise" },
          granularity: "full",
          content: "# Example Paper\n\nBody text.",
        },
      },
      async ({ port }) => {
        const result = await runCli([
          "markdown",
          "--port",
          String(port),
          "--library-id",
          "1",
          "--key",
          "ABCD1234",
          "--output",
          outputPath,
        ]);

        assert.equal(result.code, 0);
        assert.equal(
          await readFile(outputPath, "utf8"),
          "# Example Paper\n\nBody text.",
        );
        assert.match(result.stdout, /Title: Example Paper/);
        assert.ok(
          result.stdout.includes(`Written to ${outputPath} (27 characters)`),
        );
        assert.doesNotMatch(result.stdout, /Body text/);
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("strips inline HTML tags with --plain", async () => {
  await withServer(
    {
      status: 200,
      body: {
        item: { key: "ABCD1234", title: "Example Paper" },
        attachment: { key: "PDFKEY01", fileName: "paper.pdf" },
        result: { mode: "precise" },
        granularity: "search",
        query: "CO2",
        matches: [
          {
            paragraphIndex: 3,
            before: ["H<sub>2</sub>O first."],
            hit: "CO<sub>2</sub> rose by 10<sup>3</sup> t.",
            after: ["<table><tr><td>kept</td></tr></table>"],
            context: "unused",
          },
        ],
      },
    },
    async ({ port }) => {
      const args = [
        "markdown",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "ABCD1234",
        "--granularity",
        "search",
        "--query",
        "CO2",
      ];
      const raw = await runCli(args);
      const plain = await runCli([...args, "--plain"]);

      assert.match(raw.stdout, />> CO<sub>2<\/sub> rose/);
      assert.equal(plain.code, 0);
      assert.match(plain.stdout, /H2O first\./);
      assert.match(plain.stdout, />> CO2 rose by 103 t\./);
      assert.match(plain.stdout, /<table><tr><td>kept<\/td><\/tr><\/table>/);
    },
  );
});

test("rejects --output for granularities other than full", async () => {
  const result = await runCli([
    "markdown",
    "--library-id",
    "1",
    "--key",
    "ABCD1234",
    "--granularity",
    "headings",
    "--output",
    "out.md",
  ]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /--output requires --granularity full/);
});

test("posts a parse request and explains already-parsed", async () => {
  await withServer(
    {
      status: 200,
      body: { status: "already-parsed", itemID: 9, key: "PDFKEY01" },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "parse",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "ABCD1234",
        "--attachment-key",
        "PDFKEY01",
        "--wait",
      ]);

      assert.equal(result.code, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, "POST");
      assert.equal(requests[0].pathname, "/mineru-for-zotero/parse");
      assert.deepEqual(requests[0].searchParams, {
        libraryID: "1",
        key: "ABCD1234",
        attachmentKey: "PDFKEY01",
      });
      assert.match(result.stdout, /Status: already-parsed/);
      assert.match(result.stdout, /pass --force only to parse it again/);
    },
  );
});

test("sends force and reports a submitted parse", async () => {
  await withServer(
    {
      status: 200,
      body: { status: "submitted", itemID: 9, key: "PDFKEY01", submittedAt: 5 },
    },
    async ({ port, requests }) => {
      const result = await runCli([
        "parse",
        "--port",
        String(port),
        "--library-id",
        "1",
        "--key",
        "PDFKEY01",
        "--force",
      ]);

      assert.equal(result.code, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].searchParams.force, "true");
      assert.match(result.stdout, /Attachment: PDFKEY01\nStatus: submitted/);
      assert.match(result.stdout, /run parse with --wait/);
    },
  );
});

/** Answers a parse request, then one task list per poll. */
function parseThenTasks(taskLists) {
  return (request, count) =>
    request.pathname === "/mineru-for-zotero/parse"
      ? {
          status: 200,
          body: {
            status: "submitted",
            itemID: 9,
            key: "PDFKEY01",
            submittedAt: 1000,
          },
        }
      : {
          status: 200,
          body: { tasks: taskLists[Math.min(count - 2, taskLists.length - 1)] },
        };
}

const waitArgs = (port) => [
  "parse",
  "--port",
  String(port),
  "--library-id",
  "1",
  "--key",
  "PDFKEY01",
  "--wait",
  "--poll-interval-ms",
  "20",
];

test("waits for a parse to succeed, ignoring the previous record", async () => {
  const task = { id: "9", libraryID: 1, key: "PDFKEY01", title: "Paper" };
  await withServer(
    parseThenTasks([
      // The record of an earlier parse, not yet reset by Zotero.
      [{ ...task, status: "succeeded", progress: 100, updatedAt: 500 }],
      [
        {
          id: "8",
          libraryID: 1,
          key: "OTHER",
          status: "failed",
          updatedAt: 2000,
        },
        { ...task, status: "running", progress: 40, updatedAt: 1500 },
      ],
      [{ ...task, status: "succeeded", progress: 100, updatedAt: 2500 }],
    ]),
    async ({ port, requests }) => {
      const result = await runCli(waitArgs(port));

      assert.equal(result.code, 0);
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.pathname}`),
        [
          "POST /mineru-for-zotero/parse",
          "GET /mineru-for-zotero/tasks",
          "GET /mineru-for-zotero/tasks",
          "GET /mineru-for-zotero/tasks",
        ],
      );
      assert.match(result.stdout, /Status: succeeded\nprogress: 100%/);
      assert.match(result.stdout, /Read it with the markdown command/);
    },
  );
});

test("exits with code 1 when an awaited parse fails", async () => {
  await withServer(
    parseThenTasks([
      [
        {
          id: "9",
          libraryID: 1,
          key: "PDFKEY01",
          status: "failed",
          progress: 0,
          error: "daily limit reached (code -60018)",
          updatedAt: 3000,
        },
      ],
    ]),
    async ({ port }) => {
      const result = await runCli([...waitArgs(port), "--format", "json"]);

      assert.equal(result.code, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.data.status, "failed");
      assert.equal(output.data.task.error, "daily limit reached (code -60018)");
    },
  );
});

test("exits with code 1 when the wait times out", async () => {
  await withServer(parseThenTasks([[]]), async ({ port }) => {
    const result = await runCli([...waitArgs(port), "--wait-timeout-ms", "70"]);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Status: wait-timeout/);
    assert.match(result.stdout, /keeps running in Zotero/);
  });
});

test("formats the task list as text", async () => {
  await withServer(
    {
      status: 200,
      body: {
        tasks: [
          {
            id: "9",
            libraryID: 1,
            key: "PDFKEY01",
            title: "Example Paper",
            status: "running",
            progress: 40,
            detail: "Chunk 2 of 5",
          },
        ],
      },
    },
    async ({ port, requests }) => {
      const result = await runCli(["tasks", "--port", String(port)]);

      assert.equal(result.code, 0);
      assert.equal(requests[0].method, "GET");
      assert.equal(requests[0].pathname, "/mineru-for-zotero/tasks");
      assert.match(result.stdout, /Tasks: 1/);
      assert.match(result.stdout, /1\. Example Paper\n {3}id: 9\n/);
      assert.match(result.stdout, /key: PDFKEY01 \(library 1\)/);
      assert.match(
        result.stdout,
        /status: running\n {3}progress: 40%\n {3}detail: Chunk 2 of 5/,
      );
    },
  );
});

test("warns on stderr when the plugin is newer than the CLI", async () => {
  await withServer(
    { status: 200, body: { libraries: [], apiVersion: 99 } },
    async ({ port }) => {
      const result = await runCli(["libraries", "--port", String(port)]);

      assert.equal(result.code, 0);
      assert.match(result.stdout, /Zotero Libraries/);
      assert.match(result.stderr, /^Warning: this CLI \(API v1\) is older/);
      assert.match(result.stderr, /plugin 0\.11\.0 \(API v99\)/);
      assert.match(result.stderr, /npm run skill:install/);
      assert.equal(result.stderr.trim().split("\n").length, 1);
    },
  );
});

test("warns on stderr when the plugin reports no API version", async () => {
  await withServer(
    {
      status: 200,
      body: { libraries: [], apiVersion: undefined, pluginVersion: undefined },
    },
    async ({ port }) => {
      const result = await runCli(["libraries", "--port", String(port)]);

      assert.equal(result.code, 0);
      assert.match(
        result.stderr,
        /plugin \(no API version reported\) is older/,
      );
      assert.match(result.stderr, /update the plugin/);
    },
  );
});

/**
 * Runs a temporary JSON HTTP server while a CLI test executes.
 */
async function withServer(responseOrHandler, run) {
  const requests = [];
  const server = createServer((request, res) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({
      method: request.method,
      pathname: url.pathname,
      searchParams: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
    });
    // A function picks the response per request (used by polling tests).
    const response =
      typeof responseOrHandler === "function"
        ? responseOrHandler(requests[requests.length - 1], requests.length)
        : responseOrHandler;
    res.writeHead(response.status, {
      "content-type": "application/json",
    });
    // Stubs answer as a current plugin unless a test sets the versions.
    res.end(
      JSON.stringify({
        pluginVersion: "0.11.0",
        apiVersion: 1,
        ...response.body,
      }),
    );
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address();
    await run({ port, requests });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

/**
 * Creates a temporary Zotero profile tree with the requested local API port.
 */
async function withZoteroProfile(port, run) {
  const root = await mkdtemp(join(tmpdir(), "zotero-profile-"));
  const appDataRoot = join(root, "AppData", "Roaming");
  const zoteroRoot = join(appDataRoot, "Zotero", "Zotero");
  const profilePath = join(zoteroRoot, "Profiles", "test.default");

  await mkdir(profilePath, { recursive: true });
  await writeFile(
    join(zoteroRoot, "profiles.ini"),
    [
      "[Profile0]",
      "Name=default",
      "IsRelative=1",
      "Path=Profiles/test.default",
      "Default=1",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(profilePath, "prefs.js"),
    `user_pref("extensions.zotero.httpServer.port", ${port});\n`,
    "utf8",
  );

  try {
    await run({
      env: {
        APPDATA: appDataRoot,
        ZOTERO_CONFIG_DIR: zoteroRoot,
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Runs the Markdown query CLI and captures process output.
 */
function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout,
        stderr,
      });
    });
  });
}
