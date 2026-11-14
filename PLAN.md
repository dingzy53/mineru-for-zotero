# PLAN: replace the companion skill with an MCP server

> Branch `feat/mcp-server`, from `fix/agent-usage-findings`. Written 2026-11-14. Nothing here is implemented yet.
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

All in one list (`TOOLS`); adding a tool is appending a `ToolDef`. Names are snake*case with a `mineru*`prefix. Every tool takes an optional`library_id`(default: the user library). Each handler calls the existing`MarkdownQueryService` (`src/modules/markdownQuery/queryService.ts`); no second query path.

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

- **`plain` argument** on the four reading tools strips inline tags (`<sub>`, `<sup>`, …). Default false, because `10<sup>3</sup>` → `103` changes meaning. The strip moves from the CLI into `markdownParser.ts` as `stripInlineTags()` next to the existing `INLINE_HTML_TAG`.
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
