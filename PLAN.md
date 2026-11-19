# PLAN: replace the companion skill with an MCP server

> Branch `feat/mcp-server`, from `fix/agent-usage-findings`. Written 2026-11-14. Steps 0 to 6 are implemented, one commit each, plus review fixes (pagination header budget, strict HTML tag matching, non-interactive parse pre-flight handling, bridge hardening, and tests). Still open: the real-client and bridge-by-hand checks under Verification, and the owner's steps there (release, run the command from settings, delete the installed skill copies).
>
> This replaces the "fix what agents ran into when reading parsed papers" plan, which is implemented in `dd6b016`…`53bf371` (see git history for its text).

## Context

Agents reach parsed papers today through a skill (`mineru-for-zotero-cli/SKILL.md`) that teaches them to run a Node CLI against the plugin's REST API. The transcript review behind the previous plan showed why that is fragile: the skill is a hand-installed copy that goes stale, agents often never load it (and read `~/Zotero/mineru-copy/` or `zotero.sqlite` instead), and every fix needs two things updated on the user's machine.

zotero-S2 (`../zotero-S2`) solves the same problem differently: the plugin itself serves MCP on Zotero's local HTTP server, so the tools ship with the plugin, are listed to the agent at session start, and update with the plugin. This plan does the same here.

Decisions already made by the owner:

- **Scope:** delete the skill, the CLI, their tests and the installer. Keep the REST endpoints under `/mineru-for-zotero/*` unchanged for curl and scripts.
- **Access:** bearer token like zotero-S2, server on by default, requests with an `Origin` header rejected. The REST API keeps its own no-token `apiEnabled` switch.

Outcome: one `claude mcp add …` command copied from the settings pane gives any MCP client 11 `mineru_*` tools; nothing else is installed by hand.

## What the Zotero docs and source say (checked 2026-11-14)

Sources: [Zotero 10 for Developers](https://www.zotero.org/support/dev/zotero_10_for_developers), [Zotero 11 for Developers](https://www.zotero.org/support/dev/zotero_11_for_developers), [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api), and `chrome/content/zotero/xpcom/server/server.js` on `main`.

| Fact                                                                                                                                                                                                                                                                                  | Consequence for this plan                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zotero 10 rejects any request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (400).                                                                                                                                                                                          | Generated commands use `http://127.0.0.1:<port>`. No code needed; it replaces the DNS-rebinding argument in `apiEndpoint.ts`.                                                                                 |
| Zotero 10 silently drops requests with `User-Agent: Mozilla/…` or any `Origin`, for every content type, unless the endpoint sets `allowRequestsFromUnsafeWebContent = true` or the client sends `Zotero-Allowed-Request`. In Zotero 9 this applied only to CORS-simple content types. | Set the flag and reject `Origin` ourselves with a readable 403, as zotero-S2 does. Behaviour is then the same on 9 and 10, and an MCP client with a browser-like user agent is not dropped without an answer. |
| A one-argument `init(req)` gets `{method, pathname, pathParams, searchParams, headers, data}` and returns `[status, headersObject, body]`. Header names are lower-cased; `application/json` bodies arrive parsed.                                                                     | Same endpoint shape as zotero-S2 and as this repo's `apiEndpoint.ts`.                                                                                                                                         |
| `supportedDataTypes` is compared with the Content-Type before `;`, case-sensitively. POST needs `Content-Length`.                                                                                                                                                                     | `supportedDataTypes = ["application/json"]`.                                                                                                                                                                  |
| `Zotero.Server.responseCodes` lacks 202, 401 and 405; an unknown code is sent as `HTTP/1.0 401 undefined`.                                                                                                                                                                            | Add the three reason phrases at registration (`??=`).                                                                                                                                                         |
| Responses are one buffered `HTTP/1.0` message. No chunking, no SSE.                                                                                                                                                                                                                   | Streamable HTTP with JSON responses only; `GET` answers 405. Long work (a parse) must return within a time budget.                                                                                            |
| Header values are RFC 2047-decoded.                                                                                                                                                                                                                                                   | The MCP `=?base64?…?=` form of `Mcp-Name` does not match that pattern and still arrives raw.                                                                                                                  |
| Zotero 10 uses the same Firefox 140 base as Zotero 9.                                                                                                                                                                                                                                 | The server code needs nothing version-specific; keep `strict_min_version` 9.0.                                                                                                                                |
| Zotero 11 (dev builds only, Firefox 153) lists no server change and says not to declare compatibility yet.                                                                                                                                                                            | Keep `strict_max_version: "10.*"`. Keep the MCP modules free of XUL and sandbox tricks so 11 needs no rework.                                                                                                 |
| Zotero's own local API (`/api/`) now supports writes behind a per-app key. No official MCP server or tool API exists.                                                                                                                                                                 | Nothing to build on; custom endpoints stay the way to do this.                                                                                                                                                |

## Design

### Endpoint and protocol

- `POST /mineru-for-zotero/mcp`, registered next to the existing paths.
- Dispatcher copied from `../zotero-S2/src/mcp/server.ts` (commit `c5370a1`): stateless 2026-07-28 requests and the `initialize`-based 2025-03-26 … 2025-11-25 revisions, no session id, notifications → 202, `GET`/`DELETE` → 405. Before copying, check modelcontextprotocol.io for a revision newer than 2026-07-28 and add it to the version list if there is one.
- One change to the copy: a tool returns **text**, not a JSON value. Parsed papers are Markdown, and JSON-escaping them wastes tokens and reads badly. `tools/call` answers `content: [{ type: "text", text }]` with no `structuredContent`.
- `serverInfo` carries `name`, `version` and `buildTime` (new `src/utils/build.ts`, same as zotero-S2; `buildTime` is already defined in `zotero-plugin.config.ts`).

### Access control (`checkAccess`, before every request)

1. `mcpEnabled` pref off → 503.
2. `Origin` header present → 403.
3. `Authorization: Bearer <mcpToken>` missing or wrong (constant-time compare) → 401 with `WWW-Authenticate: Bearer`.

New prefs in `addon/prefs.js`: `mcpEnabled` (default `true`) and `mcpToken` (default `""`, generated at startup by `ensureToken()` from `crypto.getRandomValues`).

### Tools

All in one list (`TOOLS`); adding a tool is appending a `ToolDef`. Names are `snake_case` with a `mineru_` prefix. Every tool takes an optional `library_id` (except `mineru_list_tasks`). Each handler calls the existing `MarkdownQueryService` (`src/modules/markdownQuery/queryService.ts`); no second query path.

| Tool                       | Replaces CLI                      | Service call                     | Notes                                                                                                                                                                 |
| -------------------------- | --------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mineru_list_collections`  | `libraries`, `collections`        | `getLibraries`, `getCollections` | Libraries plus the collection tree as `A/B/C` paths with keys.                                                                                                        |
| `mineru_list_tags`         | `tags`                            | `getTags`                        | `limit` default 100.                                                                                                                                                  |
| `mineru_collection_status` | `status`                          | `getCollectionStatus`            | One line per item, grouped parsed / not parsed / no PDF.                                                                                                              |
| `mineru_search_items`      | `search`                          | `searchByTitle`                  | Same filters; `limit` default 20, max 100.                                                                                                                            |
| `mineru_get_outline`       | `markdown --granularity headings` | `queryMarkdown`                  | Heading paths, parse mode, word count, path of the stored Markdown file.                                                                                              |
| `mineru_read_section`      | `… section`                       | `queryMarkdown`                  | `section_path` is an array copied from the outline; `include_subsections`.                                                                                            |
| `mineru_search_in_paper`   | `… search`                        | `queryMarkdown`                  | `query`, `context_paragraphs` (0–5), `max_matches` (default 20).                                                                                                      |
| `mineru_locate_in_pdf`     | `… locate`                        | `queryMarkdown`                  | Physical page numbers; precise results only.                                                                                                                          |
| `mineru_read_markdown`     | `… full`, `--output`              | `queryMarkdown`                  | Paged: `offset`, `max_chars` (default 40 000, max 80 000), cut at a paragraph boundary, answers `next_offset`. Also returns the file path, which replaces `--output`. |
| `mineru_parse_pdf`         | `parse [--force] [--wait]`        | `triggerParse`, `getTasks`       | `wait` default true: polls the task until done or the call's deadline, then answers the task state.                                                                   |
| `mineru_list_tasks`        | `tasks`                           | `getTasks`                       |                                                                                                                                                                       |

Details:

- **`plain` argument** on the three Markdown reading tools (`mineru_read_section`, `mineru_search_in_paper`, `mineru_read_markdown`) strips inline tags (`<sub>`, `<sup>`, …). Default false, because `10<sup>3</sup>` → `103` changes meaning. The strip moves from the CLI into `markdownParser.ts` as `stripInlineTags()` next to the existing `INLINE_HTML_TAG`.
- **Output cap:** any tool result longer than 80 000 characters is cut with a closing line that says so and how to narrow the request. MCP clients reject or truncate large results on their own otherwise.
- **Time budget:** `TOOL_BUDGET_MS = 50_000` in `runTool.ts`, below the ~60 s at which MCP clients give up (zotero-S2 finding 3). Only `mineru_parse_pdf` waits; at the deadline it answers `running` and points to `mineru_list_tasks`.
- **Errors:** `runTool()` never throws. A `MarkdownQueryError` becomes an `isError` result with its message plus the next step (the hint table now in the CLI's `hintForError()`); `ambiguous-attachment` lists the candidate keys. Anything else is a bug and also goes to `Zotero.logError`.
- **Annotations:** reading tools `readOnlyHint: true, openWorldHint: false`. `mineru_parse_pdf` is `readOnlyHint: false`, `destructiveHint: true` (with `force` it replaces a result, and every parse spends quota), `openWorldHint: true`.
- **File path:** new `getPreferredMarkdownPath(ref)` on the storage adapter (`content.md`, or `lite-content.md` for lite-only), exposed through `PreferredMarkdownReader`.
- **Server `instructions`:** when to use the server ("parsed in Zotero", MinerU, read/summarize/cite a paper or collection in Zotero), the reading order (status → outline → section or search → full text only if needed), "do not read `mineru-copy/` or `zotero.sqlite`", the quota rule for parsing (ask before parsing more than a few), and that item keys from zotero-S2's tools work here.

### Stdio bridge

HTTP MCP clients connect once at session start; if Zotero is not running then, the tools are missing for the whole session (zotero-S2 finding 2; it happened in this very session to `zotero-s2`). The bridge is a zero-dependency Node script the client starts itself. It forwards each JSON-RPC line to the HTTP endpoint and, while Zotero is down, answers the handshake and `tools/list` from a saved copy and tool calls with "start Zotero and retry".

- Copy `../zotero-S2/addon/content/bridge/zotero-s2-mcp.mjs` to `addon/content/bridge/mineru-for-zotero-mcp.mjs`; rename the env vars (`MINERU_ZOTERO_TOKEN`, `MINERU_ZOTERO_URL`, `MINERU_ZOTERO_CACHE`), default URL, cache folder and message texts.
- At startup `installBridge()` writes it to `<Zotero data dir>/mineru-mcp/mineru-for-zotero-mcp.mjs` unless that copy is current. Build the path with `joinNativePath()` (repo rule for Windows).
- The file must not contain `__name__`-style tokens: scaffold substitutes them in assets.

### Settings pane

New section "MCP server (for AI agents)" above "Local Query API": enable checkbox, read-only endpoint URL, token (password field, **Copy**, **Regenerate**), and two read-only commands with **Copy**:

```
claude mcp add --transport http mineru-for-zotero http://127.0.0.1:23119/mineru-for-zotero/mcp --header "Authorization: Bearer <token>"
claude mcp add mineru-for-zotero -e MINERU_ZOTERO_TOKEN=<token> -- node "<data dir>/mineru-mcp/mineru-for-zotero-mcp.mjs"
```

The stdio one is labelled as the recommended one. Strings go in `addon/locale/en-US/preferences.ftl`; a build regenerates `typings/i10n.d.ts` and `typings/prefs.d.ts`.

## Files

New (all under this repo):

| File                                             | Content                                                                                                     | Source                                                                                                                                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/mcp/errors.ts`                      | `ToolError`, `errorMessage`                                                                                 | copy of zotero-S2                                                                                                                                                                                                |
| `src/modules/mcp/schema.ts`                      | `JSONSchema`, `prepareArgs()`                                                                               | copy of zotero-S2                                                                                                                                                                                                |
| `src/modules/mcp/server.ts`                      | `createMcpHandler()`                                                                                        | copy, text results                                                                                                                                                                                               |
| `src/modules/mcp/runTool.ts`                     | validate, deadline, error mapping                                                                           | rewritten (no S2 client)                                                                                                                                                                                         |
| `src/modules/mcp/tools.ts`                       | the 11 `ToolDef`s                                                                                           | new                                                                                                                                                                                                              |
| `src/modules/mcp/format.ts`                      | text formatters                                                                                             | ported from `query-markdown.mjs` (`formatStatusText`, `formatSearchText`, `formatHeadings`, `formatSection`, `formatSearchMatches`, `formatLocateMatches`, `formatParseText`, `formatTasksText`, `hintForError`) |
| `src/modules/mcp/endpoint.ts`                    | `checkAccess`, `registerMcpEndpoint`, `unregisterMcpEndpoint`, `ensureToken`, `generateToken`, `serverPort` | adapted from zotero-S2 `http/endpoints.ts`                                                                                                                                                                       |
| `src/modules/mcp/bridge.ts`                      | `bridgePath`, `installBridge`, `bridgeCommand`                                                              | adapted from zotero-S2                                                                                                                                                                                           |
| `src/utils/build.ts`                             | `BUILD`                                                                                                     | copy                                                                                                                                                                                                             |
| `addon/content/bridge/mineru-for-zotero-mcp.mjs` | stdio bridge                                                                                                | copy, renamed                                                                                                                                                                                                    |

Changed:

- `src/modules/markdownQuery/apiEndpoint.ts`: export the service factory so REST and MCP share one `MarkdownQueryService` instance (`getMarkdownQueryService()`); reword comments that mention the CLI. `pluginVersion`/`apiVersion` stay in REST responses.
- `src/modules/markdownQuery/markdownParser.ts`: `stripInlineTags()`.
- `src/modules/markdownQuery/queryService.ts`, `src/modules/storage.ts`: `getPreferredMarkdownPath`.
- `src/hooks.ts`: `ensureToken()`, `registerMcpEndpoint()`, `installBridge()` (not awaited, errors logged) at startup; `unregisterMcpEndpoint()` at shutdown.
- `src/utils/prefs.ts`, `addon/prefs.js`: the two prefs and typed getters/setters.
- `addon/content/preferences.xhtml`, `addon/locale/en-US/preferences.ftl`, `src/modules/preferenceScript.ts`: the settings section.
- `eslint.config.mjs`: Node globals for `addon/content/bridge/**/*.mjs` and `test/**/*.mjs`.
- `.github/workflows/ci.yml`, `package.json`: the `node --test` line and scripts.
- `README.md`, `AGENTS.md`, `PLAN.md`.

Deleted: `mineru-for-zotero-cli/` (skill and CLI), `test/queryMarkdownCli.test.mjs`, `scripts/install-skill.mjs`, `scripts/install-skill.test.mjs`, the `skill:install` script.

## Steps

Branch `feat/mcp-server` from `fix/agent-usage-findings` (it needs that branch's `status`, non-forcing `parse` and plain-text matching). One commit per step, each with its tests; `npm run lint:check` before every commit.

0. **Plan.** Replace `PLAN.md` with this plan (`docs:` commit).
1. **MCP core.** `errors.ts`, `schema.ts`, `server.ts`, `src/utils/build.ts`. Tests: `test/mcpServer.test.ts` (port of zotero-S2 `test/mcp.test.ts`: legacy `initialize`, modern header checks and `-32020`/`-32022`, `tools/list`, `tools/call` ok and `isError`, 202 for notifications, 405 for GET) and `test/mcpSchema.test.ts`.
2. **Tools.** `runTool.ts`, `format.ts`, `tools.ts`, `stripInlineTags()`, `getPreferredMarkdownPath`. Tests: `test/mcpTools.test.ts` with the `fakeDeps`/`fakeItem` helpers pattern from `test/markdownQueryService.test.ts`: one test per tool's text output, paging and `next_offset`, the 80 000-character cap, every `MarkdownQueryError` code → `isError` text with its hint, `mineru_parse_pdf` answering `already-parsed`, `succeeded`, `failed` and `running` at the deadline (injected clock and task list). Extend `markdownParser.test.ts` and `storage.test.ts`.
3. **Endpoint.** Prefs, `endpoint.ts`, hooks. Tests: `test/mcpEndpoint.test.ts` calling the endpoint class's `init()` for 503 / 403 / 401 / 200, plus one real round trip through Zotero's server with `Zotero.HTTP.request` on the test port (as zotero-S2 `test/http.test.ts`), with the token set in `before` and restored in `after`.
4. **Bridge.** The `.mjs`, `bridge.ts`, startup install, eslint override. Tests: `test/mcpBridge.test.mjs` (port of zotero-S2 `bridge/bridge.test.mjs`, plain Node with a stub server); `npm run test:bridge`; CI runs it in the `node-tests` job.
5. **Settings pane.** XHTML, FTL, `preferenceScript.ts`. Tests in `test/preferenceScript.test.ts`: rendered endpoint/token/commands, Regenerate changes the token and both commands, a non-default port appears in the commands.
6. **Remove the skill.** Delete the files listed above. README: replace "AI agent integration (companion skill)" and "Example agent workflow" with an "MCP server" section (setup from the settings pane, the tool table, the stdio bridge, the 401/403/503 table, a note for people who installed the skill: delete `mineru-for-zotero-cli` from their agent's skill folder). AGENTS.md: replace the "CLI Tool" section with "MCP server" (layout, the invariants above: text results, one tool list, never throw from `runTool`, one-argument `init`, do not loosen `checkAccess`, bridge stays one dependency-free file, add new status codes to the reason-phrase table) and mention the endpoint under `markdownQuery/`.

Not in this plan: bumping the version. The owner runs `npm run release`; the MCP server only reaches the everyday Zotero through a version higher than the installed one.

## Verification

- After each step: `npm run build`, `npm run lint:check`, `node --test test/mcpBridge.test.mjs scripts/*.test.mjs` (from step 4).
- Scaffold suite: `ZOTERO_PLUGIN_ZOTERO_BIN_PATH=<tarball>/zotero npx zotero-plugin test --exit-on-finish`. This machine has only the Flatpak Zotero, so first unpack the official Linux tarball into the scratch directory (outside the repo). Until then, the pure suites (`mcpServer`, `mcpSchema`, `mcpTools`) run with the esbuild + standalone Mocha harness used for the previous plan.
- Real client, against the scaffold test profile (port 23124), never the everyday profile:
  1. Keep a watch-mode test Zotero running.
  2. `claude mcp add --scope local --transport http mineru-test http://127.0.0.1:23124/mineru-for-zotero/mcp --header "Authorization: Bearer <test token>"`.
  3. In a new session: the 11 tools are listed; `mineru_list_collections` answers; a wrong token gives 401; `curl -H "Origin: http://x"` gives 403.
  4. `claude mcp remove mineru-test -s local`.
- Bridge by hand: start it with Zotero closed (handshake and saved tool list answer; a tool call says to start Zotero), start Zotero, call again without reconnecting.
- Owner, in the everyday Zotero after installing the release: copy the stdio command from settings, run it, then delete `~/.claude/skills/mineru-for-zotero-cli` and `~/.pi/agent/skills/mineru-for-zotero-cli`. Ask an agent for "the papers in UGRP are parsed in Zotero, which ones mention X": it should call `mineru_collection_status` first and never touch `~/Zotero/mineru-copy/`.

## Out of scope

- A REST mirror of the tools (`/tools/<name>`), which zotero-S2 has: the existing REST endpoints already cover scripts.
- An activity log in the settings pane like zotero-S2's.
- Searching text across a whole collection in one call. Worth adding as a twelfth tool once the single-paper tools are in use.
- Sharing the MCP core between the two plugins as a package. The four copied files are small; each names its zotero-S2 source commit in a header comment.

## Bug: the stdio bridge is never installed from a packed .xpi (found 2026-11-15, fixed on this branch)

> Fixed in `src/modules/mcp/bridge.ts` (`Zotero.File.getResourceAsync`) and `src/hooks.ts` (full error message/stack + `Zotero.logError`), with a direct `installBridge({ dataDirectory })` test in `test/mcpBridgeInstall.test.ts`.

**Symptom.** After installing the built `mineru-for-zotero.xpi` (0.11.0) in Zotero 10.0.9 and restarting, `<data dir>/mineru-mcp/mineru-for-zotero-mcp.mjs` does not exist, so the stdio command from the settings pane points at a missing file. The debug log (`zotero -ZoteroDebugText`) shows only `[MinerU for Zotero] MinerU MCP bridge install failed {}`: the error object is logged as `{}`, which hides the cause.

**Cause.** `installBridge()` in `src/modules/mcp/bridge.ts` reads the packaged script with `Zotero.File.getContentsFromURLAsync(`${rootURI}content/bridge/${FILE}`)`. That goes through `Zotero.HTTP.request` → `_parseURI`, which reads `uri.username`. For an installed plugin `rootURI` is `jar:file://…/mineru-for-zotero@dingzy53.github.io.xpi!/`, and `nsIURI.username` throws `NS_ERROR_FAILURE` on a `jar:` URI. zotero-S2 has the identical bug and its log shows the full stack (`_parseURI@chrome://zotero/content/xpcom/http.js:33` ← `getContentsFromURLAsync@…/file.js:383` ← `installBridge`). The scaffold test profile loads the plugin unpacked (`file://` rootURI), which is presumably why `test/mcpBridgeInstall.test.ts` and the suite stay green (it also injects `readSource`, so the real read is never exercised).

**Fix (planned).**

1. Read the source with `Zotero.File.getResourceAsync(url)` (opens a channel with the system principal, no HTTP layer; works for `jar:` and `file:`).
2. Log the failure so the cause is visible: `ztoolkit.log("MinerU MCP bridge install failed", String(error), error?.stack)` or `Zotero.logError(error)`.
3. Test: a case that calls `installBridge()` without `readSource` and asserts the file is written; and a manual check with the built .xpi installed in a normal profile (delete `<data dir>/mineru-mcp/`, restart, confirm the file is recreated and identical to `addon/content/bridge/mineru-for-zotero-mcp.mjs`).

**Workaround in use.** The bridge was copied by hand from `addon/content/bridge/` to `~/Zotero/mineru-mcp/`. Until the fix ships, that copy is not refreshed on plugin updates.

## Findings from install, human and agent testing (2026-11-15)

> Critical bugs fixed on this branch: #1 & #16 (local server down / crashed connection handling instead of `JSON.parse: unexpected end of data`, plus local-API-aware error/quota hints), #2 (`resultsManager` resolves `attachmentID` from `libraryID` + `key` before manifest `attachmentID`), #3 (`mineru_parse_pdf` returns `isError: true` on terminal failure), #15 & #20c (non-blocking `Zotero.ProgressWindow` instead of modal `mainWin.alert()`), #17 (`taskStore` clears stale `detail` when a task reaches a terminal state), #19b (Locate preserves the current collection), #20b (`triggerParse` resumes/restarts failed tasks and `mineru_parse_pdf` reports `not-started` as a tool error if no current task appears), #20d (inline `data:image/...;base64,...` URIs rewritten to saved `images/...` files on write and stripped in MCP output/word counts), #21 & #22 (unknown-argument errors list valid argument names and closest match; `year` also accepts integers), #23 (`mineru_read_section` accepts unique leaf headings, lists closest headings, and avoids repeated `section-not-found: section-not-found`), #24 (source-aware quota wording for local vs online API), #25 (`taskStore` and `mineru_list_tasks` list running/pending tasks first), #26 (`mineru_collection_status` prints the resolved collection's stored name and key).
>
> Remaining larger features and polish items (#4, #5, #6, #7, #8, #9, #10–12, #13–14, #18–19, #20, #20e–20f) are tracked below for follow-up PRs.

Tested with the 0.11.0 build in Zotero 10.0.9 on macOS: a 58-item collection imported from RIS, 49 results restored from a Sync-folder export, the MCP tools driven through the stdio bridge and over HTTP, and the GUI driven by hand. Screenshots are in `.screenshots/` (untracked, listed in `.git/info/exclude`).

### Bugs

1. **Local server down → misleading error, and wrong advice to agents.** With API type "Local API" and nothing listening on `http://127.0.0.1:8000`, `mineru_parse_pdf` fails with `JSON.parse: unexpected end of data at line 1 column 1 of the JSON data`. The MCP text then says "the error above is MinerU's … a retry spends quota again" (`src/modules/mcp/format.ts:319`), which is wrong on both counts: MinerU was never reached, and local parsing has no quota. The Task Manager shows the same raw error and keeps the stale step text "Uploading full document (40 pages)…" on the failed task (`.screenshots/02-task-failed-local-server-down-json-parse.jpg`). Expected: "Can't reach the local MinerU server at http://127.0.0.1:8000 (connection refused). Start it or switch to Online API in settings." Probably the empty response body reaches `JSON.parse` in `mineruClient/http.ts:395` or `v1.ts:410` without checking the status or the body length; the fetch error (refused connection) should be caught and named. The hint should only mention quota for the online API, and only when MinerU itself returned the error.
2. **`attachmentID` in `manifest.json` overrides the key.** `resultsManager.ts:106` takes `manifest.attachmentID` before looking the item up by key. Item IDs are local to one Zotero database, while result folders are named by the synced attachment key, which the README presents as portable across devices. A `mineru-copy` folder copied or synced from another computer therefore carries IDs that point at unrelated items, and Results Manager actions such as tag removal (`resultsManager.ts:218-226`) act on the wrong item. Fix: resolve by `libraryID` + key first, and use the stored ID only if it still has the same key. (To restore the Sync export safely, the field had to be deleted from every manifest.)
3. **A failed parse is not an MCP error.** `mineru_parse_pdf` returns `isError: false` with `Status: failed`. Agents that only branch on `isError` treat it as success. Consider `isError: true` for a terminal failure.

### Missing features and improvements

4. **No way to restore results from a Sync-folder export.** The Sync folder holds `<[year] - title>/` directories with the full result plus `manifest.json` and `metadata.bib`, which is everything needed to rebuild `mineru-copy/attachments/<lib>-<key>/` — but there is no import. Restoring one collection on a new machine took a script: match `manifest.fileName` to the newly imported attachments, copy the directory under the new key, rewrite `attachmentKey`/`fileName`/`pdfMtime`, drop `attachmentID` and `metadata.bib`, then add the "MinerU: Precise ✅" tag from Run JavaScript. Suggest **Settings → Import results from folder…**: match by attachment key, then by file name + size/hash, then by DOI or title from `metadata.bib`; show a preview of matched, unmatched and ambiguous entries; set status tags.
5. **Add a Test button for the API (owner request, 2026-11-15).** Zotero S2 has a Test button next to its API key; MinerU has none for the token or the local URL (`.screenshots/01-settings-no-token-local-api-no-test-button.jpg`). Add one next to "MinerU API Token" / "Local API URL" that tests whichever API Type is selected: for the online API, an authenticated request that spends no quota, reporting "OK", "invalid token" or the HTTP error; for the local API, `GET <local URL>/docs` (or a health endpoint), reporting "reachable" or "connection refused at <URL>". Show the result inline under the field, as zotero-S2 does. This would have caught both the missing token and the stopped local server before any parse.
6. **The parse menu exists only on PDF attachments.** Right-clicking a regular item, several items, or a collection offers no MinerU entry (`.screenshots/05-parent-item-menu-no-parse.jpg` vs `06-attachment-menu-parse.jpg`). Users select papers, not attachments. Suggest "Parse PDFs with MinerU" on regular items (their PDF attachments), on a multi-selection and on collections, skipping items that are already parsed.
7. **Search misses numbers that agents will search for.** Checking a synthesis table with `mineru_search_in_paper` showed:
   - inline LaTeX is stored with spaced tokens (`$M = 4 1 . 4 6 \mathrm{km}$`), so `41.46` never matches;
   - `1.2%` does not find `1.2 %`, and `4,355` does not find `4355` (and vice versa);
   - PDFs whose fi/fl ligatures were dropped give `signifcant`, `defned`, `Te` (for The), so `significant` finds nothing (Jin et al. 2024); other papers have `in<sup>fl</sup>uencing`.
     Suggest normalising the search index: collapse spaces between digits and around `.`/`%` inside formulas and text, ignore thousands separators, and try a ligature-dropped variant of the query (`fi`→`f`, `fl`→`f`) when there are no matches. The tool description could also tell agents to search for words rather than numbers.
8. **Ligature and table artefacts in the Markdown.** `<sup>fl</sup>`, `<sup>fi</sup>` and `<sup>–</sup>` appear inside words (Khazaei 2021 title in Preview, `.screenshots/04-preview-raw-markdown-sup-ligatures.jpg`), and for Franke & Krems 2013 only the caption of Table 1 survived ("Table 1 Descriptive statistics for comfortable range variables."), not its body. A post-processing pass that unwraps `<sup>` around `fi`/`fl`/`ff`/`ffi`/`–` would fix the first; the second is MinerU's, but `mineru_get_outline` could flag tables with a caption and no content.
9. **Preview shows raw Markdown.** The Results Manager Preview is a monospace dump including image links and HTML tags. Rendering it (or at least hiding `<sup>` and image hashes) would make spot-checks easier.

### With the online API (token set, 2026-11-15)

10. **Upload has no progress, no timeout and is not covered by the online timeout.** `xhrUploadBinary` (`mineruClient/http.ts:85-100`) is a bare `XMLHttpRequest` PUT with no `timeout`, `ontimeout`, `onabort` or `upload.onprogress`. On this network the PUT to the pre-signed URL took ~4 min for a 1.1 MB PDF and ~7 min for a 3.9 MB PDF; during that time the task, the Task Manager and `mineru_list_tasks` showed "Uploading full document (N pages)… 0%" and nothing changed. Wang 2024's upload ran past the 6-minute "Online API timeout" without being stopped, because that setting only bounds polling (`prefs.ts` "polling timeout"). A stalled upload would hang forever. Suggest: report upload progress (bytes sent / total) in the task detail and MCP output, add an upload timeout (or apply the online timeout to the whole job), and say in settings what the timeout covers. MinerU's own parse took under a minute once uploaded.
11. **The PUT is invisible in the Zotero debug log.** The batch request and the polls go through `Zotero.HTTP` and are logged, but the upload is a raw XHR and is not, so a slow or failing upload leaves no trace. Log start, end, size and status of the upload.
12. **MCP calls block ~46 s while the upload has not even started to report.** `mineru_parse_pdf` held each call for ~46 s, then returned "running, 0%, Uploading…". For agents, returning immediately with the task ID once the job is queued (and letting `mineru_list_tasks` report progress) would be cheaper; or report upload progress in that answer.

## Findings round 2: local MinerU server, GUI and MCP errors (2026-11-15, not fixed)

Local server set up with `uv tool install "mineru>=4.0,<5"` on an M1 / 8 GB / macOS 14.8. Screenshots `07`–`11` in `.screenshots/`.

### Bugs

13. **Local API is incompatible with MinerU ≥ 4.1 (the current release).** The README's own setup (`mineru-kit api-server …`) installs MinerU 4.2.2, whose API is `/v1/tasks`, `PUT /v1/tasks/{id}/uploads/{file_id}`, … The plugin's local client (`mineruClient/v1.ts`) calls `POST /v1/uploads`, `/v1/uploads/{id}/complete`, `/v1/parse/jobs`, which exist only in MinerU 4.0.x (checked in the wheels: 4.0.0 has `/v1/parse/jobs` and `/v1/uploads`; 4.1.0, 4.2.0 and 4.2.2 have only `/v1/tasks`). Every local parse fails with `MinerU upload request failed: status 404; {"detail":"Not Found"}` (`.screenshots/07-resume-404-mineru-4.2-js-alert.jpg`). With `mineru==4.0.12` the same parse is accepted. Fix: support the 4.1+ `/v1/tasks` API (detect it from `/openapi.json` or the `/v1/health` version), or at least pin and document `mineru>=4.0,<4.1` in the README and check the server version on Test (item 5).
14. **The "Advanced" tier is offered to servers that cannot run it.** MinerU 4.0.x servers only accept `flash`, `basic`, `standard` (`mineru-kit api-server --tier advanced` → "Unsupported server tier 'advanced'"). The plugin already calls `GET /v1/tiers` before each job; it should grey out tiers the server does not list, and fall back or warn instead of submitting.
15. **Background failures pop up as raw modal alerts over unrelated windows.** A failed local parse showed a "[JavaScript Application]" alert ("Local API service is unavailable: MinerU upload request failed: status 404 …") and, when the MinerU server crashed mid-job, another one ("MinerU parsing failed: JSON.parse: unexpected end of data …") on top of the Zotero S2 search window (`.screenshots/09-server-crash-alert-over-s2-window.jpg`). Use Zotero's progress window / a notification in the Task Manager instead of `alert()`, and phrase it for people ("The MinerU server stopped while parsing <title>. Restart it and click Resume.").
16. **Server crash → again `JSON.parse: unexpected end of data`.** Same root cause as item 1: an empty or aborted response body reaches `JSON.parse`. Detect connection loss and say so.
17. **Failed task still says it is reconnecting.** After the crash, the task card showed status FAILED with the detail line "MinerU connection interrupted; reconnecting (attempt 2, in 6s)" (`.screenshots/10-failed-but-reconnecting-detail.jpg`). Clear or replace the detail when the task reaches a terminal state.

### Improvements

18. **"MinerU Parse" column only fills attachment rows.** The column (off by default) shows "Precise" on the PDF row but nothing on the parent item row (`.screenshots/11-column-only-on-attachment-rows.jpg`); with items collapsed, which is the normal view, it is empty. Roll the best state of the item's PDFs up to the parent row (Precise / Lite / Running / Failed / none), and consider enabling the column by default.
19. **No result actions on items.** The only MinerU context-menu entry is "Parse PDF with MinerU" on PDF attachments. Opening, previewing, re-parsing or deleting a result needs the Task Manager → Parsed Results tab and a search there. Add "Open parsed Markdown", "Show in Parsed Results" and "Re-parse" to the item and attachment menus, or an item-pane section.
20. **MinerU on macOS 14 with PyTorch 2.15 crashes on MPS.** `-[MPSNDArray arrayViewWithShape:strides:]: unrecognized selector` (a macOS 15 API) aborts the server; `MINERU_DEVICE_MODE=cpu` avoids it. Not the plugin's bug, but the README's local-setup section could mention it.

19b. **Locate switches the collection.** Parsed Results → Locate selected the item but moved the main window from the open collection (MIMMC) to My Library. Keep the current collection when the item is in it, as Zotero's own "Show in Library" does.

20d. **Local results embed every image as base64 in `content.md`.** The successful local parse of Muzir 2022 (MinerU 4.0.12, standard, CPU) wrote 25 `![](data:image/jpeg;base64,…)` images into `content.md` (3.27 M characters for 23 k words; single lines up to 274 kB), although the same images were also saved as `images/page_0_image_11.jpg` etc. Online results link `images/<hash>.jpg` instead. Consequences: `mineru_read_markdown {"max_chars": 3000}` returns almost only base64 to the agent, the Preview and Sync folder carry megabytes of text, and search and word counts run over image data. Rewrite `data:` URIs to the saved image files when storing a local result (and strip them in MCP output as a safety net).
20e. **Local parse quality on 4.0.12: merged and doubled headings.** The outline of the same paper has headings such as "2.2. Literature Review Process2.2. Literature Review Process", "3. The Electrical3.1. Electric Vehicle" and "3.2. Prospect of Electric Vehicl3.2. Prospect of Electric Vehicle". This is MinerU's output, but `mineru_get_outline` passes it on; a de-duplication of repeated heading text would make section paths usable.
20f. **What it took to get one local parse.** MinerU 4.2.2 (current) → 404 (item 13). MinerU 4.0.12 → server crash on MPS (item 20), then with `MINERU_DEVICE_MODE=cpu` a parse failure inside MinerU (`TypeError: argument 'private_ranges': 'int' object is not an instance of 'tuple'`), because 4.0.12 does not pin its native dependency and pulls `docvortex` 0.6.22 (released a month later). Working combination on macOS 14 / M1: `uv tool install --python 3.12 "mineru==4.0.12" --with "docvortex==0.5.16"`, `mineru-kit models download --tier standard`, `MINERU_DEVICE_MODE=cpu mineru-kit api-server --tier standard`; the plugin set to Local API, Standard, timeout raised to 120 min. The 40-page review then parsed in ~7 min. The README should either document such a pinned setup or support MinerU 4.1+.

### MCP errors an agent hits

20b. **`mineru_parse_pdf` on a failed PDF says "running" but starts nothing.** For a PDF whose last task failed (Muzir 2022, `BGZ6DZN3`), `mineru_parse_pdf {"key": …}` waited ~45 s and answered `Status: running … The parse continues in Zotero; check it with mineru_list_tasks, do not submit it again.` No request reached the MinerU server, and `mineru_list_tasks` kept showing the old failed task. The handler (`mcp/tools.ts`, `mineru_parse_pdf`) treats the stale failed record as "not current" and falls through to "running" at the deadline; the parse manager apparently does not restart a failed task without Resume. The agent is told to wait for a parse that will never run, and not to retry. Fix: have `triggerParse` resume or restart a failed task (as the Task Manager's Resume does), and if no current task record appears, answer "not started" with the reason instead of "running". The Task Manager's Resume then started a real job at once.
20c. **A stale alert pops up later.** Around the same call, the old error ("MinerU parsing failed: argument 'private_ranges' …") appeared again as a modal alert over the main window, blocking the Tools menu until dismissed — another reason to drop `alert()` (item 15).

21. **`mineru_search_items` has no free-text argument.** An agent's first call is `{"query": "range anxiety"}` → `Unknown argument "query"`. The tool takes `title`, `creator`, `doi`, `tag`, … Add a `query` that searches title, creators, abstract and DOI, or make the error list the accepted arguments.
22. **Unknown-argument errors do not say what is allowed.** `Unknown argument "query"` (and the same in zotero-S2) gives no list of valid names; agents guess again. Include the accepted argument names, and the closest match.
23. **`mineru_read_section` needs the full heading path.** `{"section_path": ["Introduction"]}` → `section-not-found: section-not-found …` (the code is repeated as the message). Agents naturally pass the heading alone; accept a unique last-component match, and say which headings are closest.
24. **Quota wording for local parsing.** `mineru_read_markdown` on an unparsed PDF says `mineru_parse_pdf … spends the user's MinerU quota`; with the local API there is no quota. Word it by API type.
25. **`mineru_list_tasks` ordering hides running tasks.** With `limit: 1` it returned a finished task while a resumed task was running: "newest" means newest-created, and Resume does not move a task up. List running/pending first.
26. **`mineru_collection_status` echoes the input.** `{"collection": "mimmc"}` works (case-insensitive) but prints `Collection: mimmc`; print the stored name and key so the agent can reuse them.
