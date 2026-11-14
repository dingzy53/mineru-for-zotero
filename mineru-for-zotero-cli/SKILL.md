---
name: mineru-for-zotero-cli
description: Read papers that MinerU for Zotero has parsed, through a bundled CLI. Use this skill whenever the user says papers are "parsed in Zotero" or parsed with MinerU, or asks to read, summarize, search, quote or cite a paper or a collection in their Zotero library. Finds items by title, author-year citation, collection or tag, shows which papers of a collection are parsed, reads headings, single sections, search hits, physical page numbers or the full Markdown, and can start a MinerU parse for a PDF that has no result yet. Use it instead of reading the `mineru-copy/` or `MinerU-Sync/` folders or `zotero.sqlite` directly.
---

# MinerU for Zotero CLI

## Context

MinerU is a document parsing system for converting PDFs into structured content such as Markdown, layout regions, formulas, tables, and images. MinerU for Zotero is a Zotero plugin that runs MinerU parsing for PDF attachments, stores the parse results in the local Zotero profile, and exposes saved Markdown through a local query API.

Use the bundled CLI to query parsed Markdown that MinerU for Zotero has already saved. The CLI calls the plugin's local HTTP API; it does not read Zotero profile files or bypass Zotero preferences. It can also ask the plugin to parse a PDF that has no result yet (`parse`), which spends the user's MinerU quota.

## Do not read the result folders directly

The parse results live in `<Zotero data directory>/mineru-copy/attachments/<libraryID>-<attachmentKey>/`, and a copy may exist in a sync folder. Go through the CLI instead of listing or reading those folders:

- **Attachment selection.** Folders are named by attachment key, not by item. The CLI maps an item to the right parsed PDF; doing it by hand means querying `zotero.sqlite` or Zotero's own API.
- **Sections and search.** `headings`, `section` and `search` return the part you need. Reading `content.md` loads the whole paper into context.
- **Page lookup.** `locate` gives the physical page of a passage, which `content.md` does not record.
- **Stable interface.** The folder layout is internal and has changed between versions.

Never copy or open `zotero.sqlite` to map items to files.

## Preconditions

- Zotero is running.
- Markdown query API is available.
- No token is needed: the local API is gated only by the plugin's enable switch.

## CLI Reference

### CLI Script

All operations use `scripts/query-markdown.mjs` (Nodejs, zero external dependencies).

```powershell
node scripts/query-markdown.mjs <command> [options]
```

### Commands

| Command       | Description                                                                    | Example                                                                                                       |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `libraries`   | List available Zotero libraries (personal and group libraries).                | `node scripts/query-markdown.mjs libraries`                                                                   |
| `collections` | List collections/folders within a specified library.                           | `node scripts/query-markdown.mjs collections --library-id 1`                                                  |
| `tags`        | List tags in a specified library.                                              | `node scripts/query-markdown.mjs tags --library-id 1 --limit 50`                                              |
| `search`      | Search Zotero items with rich metadata filters and return matching candidates. | `node scripts/query-markdown.mjs search --library-id 1 --title "keyword" --format json`                       |
| `status`      | Show which items of a collection are parsed, not parsed, or have no PDF.       | `node scripts/query-markdown.mjs status --library-id 1 --collection "Reading List"`                           |
| `markdown`    | Query saved MinerU Markdown for an item key, with selectable granularity.      | `node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity headings --format text` |

| `parse` | Start a MinerU parse for a PDF. Skips PDFs that already have a current result. | `node scripts/query-markdown.mjs parse --library-id 1 --key ABCD1234 --wait` |
| `tasks` | List parse tasks with status, progress and error text. | `node scripts/query-markdown.mjs tasks` |

### Common Options

- `--library-id <id>` — Zotero library ID; required for every command except `libraries` and `tasks`
- `--port <number>` — Zotero local server port; default is auto-detected from the Zotero profile, then 23119
- `--format <text|json>` — Output format; default is text, use `--format text` for agent-readable text. use `--format json` when another script or pipeline needs structured output.
- `--timeout-ms <number>` — Request timeout; default is 30000

### Collections options

- `--parent-key <key>` — Optional parent collection key to list only its direct subcollections.

### Tags options

- `--limit <n>` — Maximum number of tags to return.

### Search options

- `--title <text>` — Title substring to match.
- `--creator <text>` — Creator substring to match (author-year citations such as "Chen et al. 2022").
- `--collection <name|key>` — Collection name or key to filter items within a specific folder.
- `--tag <tag>` — Exact tag filter.
- `--abstract <text>` — Abstract substring to match.
- `--publication <text>` — Publication or conference title to match.
- `--citekey <key>` — BibTeX citation key substring to match (e.g. `vaswani2017attention`).
- `--doi <doi>` — DOI substring to match.
- `--item-type <type>` — Item type filter (e.g. `journalArticle`, `conferencePaper`, `book`, `preprint`).
- `--since <date>` — Filter items added on or after date (`YYYY-MM-DD`).
- `--year <YYYY>` — Four-digit year filter applied after search.
- `--has-pdf` — Boolean flag; only return items that have at least one PDF attachment.
- `--parsed-only` — Boolean flag; only return items with ready MinerU parse results (precise or lite).
- `--sort-by <field>` — Sort by `dateAdded`, `dateModified`, `title`, or `year`.
- `--sort-order <asc|desc>` — Sort direction (`desc` by default, for every `--sort-by` field).
- `--limit <n>` — Maximum number of candidates to return.

### Status options

- `--collection <name|key>` — Collection to report on; required.
- `--include-subcollections` — Boolean flag; also report items in its subcollections.

### Markdown options

- `--attachment-key <key>` — Select a specific PDF attachment after ambiguous-attachment or explicit user choice
- `--granularity <kind>` — full, headings, section, search, or locate
- `--section-path <path>` — Exact full heading path from headings output, including root title
- `--include-subsections` — With `granularity=section`, extend the range past same-level numbered subsections (e.g. include `3.1`–`3.4` inside `3.`) until the next chapter or unnumbered heading
- `--query <text>` — Search query for search queries
- `--context-paragraphs <n>` — Context paragraphs for search queries
- `--output <file>` — With `--granularity full`, write the Markdown to a file and print only the header and the path

### Parse options

- `--key <key>` — Item key or PDF attachment key; required.
- `--attachment-key <key>` — Select a specific PDF attachment under a regular item.
- `--force` — Boolean flag; parse again even when a result for the current PDF exists. Only on the user's explicit request.
- `--wait` — Boolean flag; wait until the parse ends. Exits with 1 unless it succeeded.
- `--wait-timeout-ms <number>` — Longest wait for `--wait`; default is 900000 (15 minutes). The parse keeps running in Zotero after a timeout.
- `--poll-interval-ms <number>` — Delay between task checks for `--wait`; default is 3000.

### Exit Codes

The CLI exits with one of four codes; check the code to decide whether to retry, fix the command, or report a failure.

| Code | Meaning              | What it indicates                                                                                                                                               |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success              | The API answered and the result was printed.                                                                                                                    |
| 1    | API error            | The API answered with an HTTP 4xx/5xx error envelope (for example `parse-result-not-found`), or a parse awaited with `--wait` failed, was stopped or timed out. |
| 2    | Argument/usage error | The command line was wrong; the usage text is printed to stderr.                                                                                                |
| 3    | Transport error      | Zotero could not be reached: connection refused, timeout, or a non-JSON response.                                                                               |

## Workflows

### Survey a collection before reading it

When the user points at a collection ("the papers in UGRP are parsed in Zotero"), start here. It answers which papers can be read, which still need a parse and which have no PDF, in one call:

```powershell
node scripts/query-markdown.mjs status --library-id 1 --collection "UGRP" --include-subcollections
```

Each line is `itemKey | first creator, year | title | attachmentKey state words`. `state` is `precise` or `lite` for a readable result, and `running`, `failed` or `none` otherwise. Use the item key with `markdown`; the word count tells you whether a paper fits in context or should be read by section. Run `collections --library-id 1` first if you do not know the collection name.

### Search a paper by title

Use this when you do not yet know the Zotero item key.

```powershell
node scripts/query-markdown.mjs search --library-id 1 --title "paper title"
```

### Search a paper by author-year citation

Citations like “Chen et al. 2022” reference authors, not titles. Search by creator instead of guessing title keywords:

```powershell
node scripts/query-markdown.mjs search --library-id 1 --creator "Chen" --year 2022
```

Candidate summaries include `year:` and `creators:` lines so you can confirm the match before querying Markdown. Add `--limit` to cap the candidate list for broad creator names.

### Read headings first

Let the CLI choose the parsed PDF attachment automatically before specifying an attachment.

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity headings
```

If this succeeds, keep omitting `--attachment-key` for later `headings`, `section`, `search`, and `full` requests on the same item. Do not preemptively pick the first PDF just because the search result lists multiple attachments. The CLI's automatic selection prefers parsed attachments and should be allowed to resolve the item-level key first.

### Select a specific attachment

Add `--attachment-key` only after the CLI returns `ambiguous-attachment`, or when the user explicitly asks for a specific attachment.

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --attachment-key PDFKEY01 --granularity headings
```

Use one of the candidate keys from the error output, then keep that same attachment key for later requests.

### Read a section

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity section --section-path "Paper Title/Introduction/Background"
```

`--section-path` must be the exact full path shown by `headings`, including the root title. A leaf heading such as `"Background"` is not enough when the headings output shows `"Paper Title/Introduction/Background"`.

By default a section ends at the next same-level or higher heading. MinerU often renders numbered subsections (`3.1`, `3.2`, …) at the same level as their parent (`3.`), so reading `"3. System Model"` alone returns only the section intro. Pass `--include-subsections` to pull in the whole numbered group until the next chapter:

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity section --section-path "Paper Title/3. System Model" --include-subsections
```

### Search parsed Markdown

Use this for local context inside a saved parse result.

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity search --query "retrieval" --context-paragraphs 2
```

### Locate physical page numbers

Use this to find the exact physical page number of a text snippet within a precisely parsed PDF.

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity locate --query "specific snippet"
```

### Fetch full Markdown

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --granularity full
```

Use full Markdown only when section or search output is insufficient.

To hand a paper to a subagent or another tool, write it to a file instead of printing it:

```powershell
node scripts/query-markdown.mjs markdown --library-id 1 --key ABCD1234 --output /tmp/ABCD1234.md
```

### A PDF has no parse result yet

`markdown` answers `parse-result-not-found`, or `status` lists the item under `[Not parsed]`. You can start the parse yourself:

```powershell
node scripts/query-markdown.mjs parse --library-id 1 --key ABCD1234 --wait
```

Then read the paper as usual, starting with `--granularity headings`.

- **Parsing spends the user's MinerU quota** (the official cloud has a daily limit). Parse one or two PDFs when the task needs them; ask the user before parsing more than a few, and say how many.
- `parse` answers `already-parsed` and submits nothing when a result for the current PDF exists. Do not pass `--force` unless the user asks for a fresh parse.
- `already-running` means the PDF is being parsed already; check `tasks`.
- A parse takes from under a minute to several minutes for long PDFs. Without `--wait`, the command returns at once with `submitted`; follow it with `tasks`.
- On `failed`, the output carries MinerU's error text. Report it to the user instead of retrying: submitting again spends quota again.
- Items under `[No PDF]` cannot be parsed; they need a PDF attachment first.

## Response Format Notes

- Prefer `--format text` (the default) when you are reading results directly; it already prints keys, page numbers, and context lines. Use `--format json` only when another script needs structured output.
- Search responses nest fields under each candidate: read `candidates[i].item.key`, `candidates[i].item.title`, and `candidates[i].attachments[j].key`. There is no top-level `title` on candidates.
- Markdown query responses put `matches` at the top level of `data` (next to `item` and `attachment`); it is not under `data.result`.
- `locate` matches carry `page`, `boxIndex`, and `bbox`; use them to cite physical pages. Matching is literal substring matching, so quote surrounding prose rather than LaTeX with spacing artifacts.

## Error Handling

- `network-error`: Zotero may not be running, or nothing listens on the detected port. Ask whether Zotero is running, start it, or retry with an explicit `--port`. The CLI prints this hint automatically and exits with code 3.
- `api-disabled`: Ask the user to enable the Markdown query API in Zotero preferences.
- `ambiguous-attachment`: This is the signal to re-run with `--attachment-key` using one of the candidate keys. It is not a failure to prevent in advance.
- `collection-not-found`: The `--collection` value matches no collection in that library. Run the `collections` command and retry with an exact name or key.
- `parse-result-not-found`: The target PDF has no parse result yet. Follow "A PDF has no parse result yet" above, keeping the quota rule in mind.
- `section-not-found`: Re-run with `--granularity headings` and use an exact full heading path, including the root title.
- `missing-query`: Re-run the search query with a non-empty `--query` value.
