# MinerU 4.0 Migration Plan

> Target: make `mineru-for-zotero` fully compatible with MinerU 4.0 by migrating
> the online and local clients to the unified **V1 API**, replacing `precise`/`lite`
> with MinerU **tiers**, and teaching the box pipeline the new **Middle JSON 2.0**
> schema.
>
> Completed prerequisite: the layout PDF feature was removed entirely
> (generator, Zotero attachment, local `layout.pdf` storage, Results Manager
> badge/filter, Agent sync `layoutPdfPath`, `attachLayoutPdf` preference/UI), so
> the plugin no longer writes PDFs into Zotero storage. Legacy
> `MinerU: Layout` attachments are still detected and can be erased from the
> Results Manager.
>
> Source of truth: `/home/ding/GitHub/MinerU` (v4.0.5), especially
> `mineru/parser/api_client.py` (reference client), `mineru/parser/api_server.py`
> (routes), `docs/en/reference/migration_4.md`, `docs/en/usage/http_api.md`,
> `docs/next/api/*`, and `docs/next/middle-json/current-medium.md`.

---

## 1. Why this is needed

MinerU 4.0 is a breaking change on three independent axes:

1. **HTTP API** — the self-hosted API dropped `/health`, `/tasks`, `/tasks/{id}`,
   `/tasks/{id}/result`, `/file_parse` and replaced them with the unified `/v1/*`
   surface. The plugin's `src/modules/mineruClient/local.ts` targets the removed
   routes, so local parsing is broken.
2. **Remote API** — the official cloud moved to the same unified V1 shape
   (`https://mineru.net/api/v1/*`). The old `/api/v4/file-urls/batch` batch flow and
   the Agent `/api/v1/agent/parse/*` flow are no longer documented in the MinerU 4
   repo. Option 1 (selected) retires both.
3. **Output contract** — PDF/OFD parse output is now **Middle JSON 2.0**
   (`docvortex.middle` protocol `2.0`):
   - `PageInfo` is `{ page_idx, blocks }` and has **no `page_size`**.
   - Top-level block `bbox` is already **normalized `[0,1]`**.
   - Text lives in `content: [{ type, ... }]` span lists, not `lines[].spans[]`.
   - The result ZIP uses new member names (`markdown.md`, `middle_json.json`,
     `structured_content.json`, `images/…`).

The official cloud ZIP may still return the legacy `layout.json`/`pdf_info`
document (see `test_api_client_accepts_legacy_official_layout_json`), so the box
pipeline must support **both** schemas.

---

## 2. Design decisions

### 2.1 One unified V1 client, two deployment bases

Replace `onlinePrecise.ts`, `agentLite.ts`, and `local.ts` with a single
`mineruClient/v1.ts` that is parameterized by base URL, API key, and tier:

| Deployment | Base URL                 | Auth              | Source                                                        |
| ---------- | ------------------------ | ----------------- | ------------------------------------------------------------- |
| Online     | `https://mineru.net/api` | `Bearer <apiKey>` | upload                                                        |
| Local      | `http://127.0.0.1:8000`  | optional          | upload or `local` (only when `/v1/health` advertises `local`) |

Both share the same flow:

```
GET  /v1/health                                  (capability discovery, cached)
POST /v1/uploads                                 (create upload, optional sha256 dedup)
PUT  {upload_url}                                (upload_headers; Bearer only if same-origin)
POST /v1/uploads/{upload_id}/complete            (-> file.id)
POST /v1/parse/jobs                              ({ files, tier, output_formats } -> job_id)
GET  /v1/parse/jobs/{job_id}                     (poll: queued|running|completed|partial|failed|canceled)
GET  /v1/files/{file_id}/content                 (markdown / middle_json / zip; follow 302)
```

### 2.2 Tiers replace precise/lite

- New preference `parseTier`: `flash | basic | standard | advanced`.
- Online cloud exposes only `standard` (per `docs/next/tiers.md`); the UI shows a
  fixed/standard note for online and hides the other options.
- Local uses `GET /v1/tiers` for capability discovery and offers whatever the
  server advertises; default selection is `standard -> basic` (never silently
  `flash` for PDF/image).
- The internal `MinerUParseResult` kinds (`precise`/`lite`) stay for storage
  compatibility, but the client now requests `middle_json` for every PDF, so new
  parses write precise results. `lite` remains read-only/legacy fallback for the
  Markdown query API.

### 2.3 Schema-aware box normalization

`boxNormalizer.ts` gains a format branch:

- `docvortex.middle` 2.0 → normalized bbox, span-list content, visual
  parent/body blocks.
- Legacy `pdf_info`/`para_blocks`/`layout_dets` → pixel bbox divided by page size
  (existing behavior preserved).

---

## 3. Phased task breakdown

### Phase 0 — Fixtures and guardrails

- [ ] Start a real MinerU 4 local server
      (`mineru-kit api-server --host 127.0.0.1 --port 8000 --tier standard`).
- [ ] Parse a small sample PDF and capture the V1 responses (`/v1/health`,
      `/v1/parse/jobs/{id}`, `middle_json.json`, result ZIP listing) into
      `test/fixtures/mineru4/`.
- [ ] Commit the fixtures so schema tests are deterministic and offline.
- [ ] Record the current baseline: `npm run build`, `npm run lint:check`,
      `npx tsc -p test/tsconfig.json --noEmit`.

**Acceptance:** fixtures exist and the current suite still passes before changes.

### Phase 1 — Shared V1 types

File: `src/modules/mineruClient/types.ts`

- [ ] Add V1 response models: `V1Health`, `V1Upload`, `V1FileObject`,
      `V1ParseJob`, `V1JobFile`, `V1OutputFileRef`, `V1OutputFiles`,
      `V1ErrorEnvelope`, `MinerUTier`.
- [ ] Keep `FetchLike`, `ZipEntry(s)`, `MinerUParseResult`,
      `MinerUClient`, `MinerUClientOptions`.
- [ ] Extend `MinerUClientOptions` with `tier?` and `baseURL` semantics.
- [ ] Remove `FileUrlsBatchResponse`, `ExtractResultsBatchResponse` (v4-only).

**Acceptance:** type-check passes; no v4-specific types remain referenced.

### Phase 2 — Schema-aware `boxNormalizer.ts`

File: `src/modules/boxNormalizer.ts` (+ tests)

- [ ] Detect schema from `schema === "docvortex.middle"` /
      `schema_version` / presence of `extensions.docvortex_layout` vs legacy
      `pdf_info`.
- [ ] New-schema page handling: read `page_idx` (0-based → +1); page size is
      absent, so treat bbox as already normalized (no division).
- [ ] New-schema block content: - `content: InlineSpan[]` → plain text; `equation_inline` → `$…$`;
      `code_inline` → `` `…` ``; `hyperlink` → recurse into `content`. - `table_body` → HTML/space-projected string. - `equation` → LaTeX string. - `image_body` → description + `image_path`/`img_path`.
- [ ] Handle visual parent/body blocks without double counting:
      `image`/`image_body`, `table`/`table_body`, `chart`/`chart_body`,
      `code`/`code_body|algorithm_body`, and caption/footnote children.
- [ ] Keep legacy path (`blocks`, `para_blocks`, `layout_dets`,
      `discarded_blocks`, `lines[].spans[]`, `poly`, pixel bbox) intact.
- [ ] Image path: read `image_path`/`img_path` from the block and nested
      `image_body`; keep the safe-relative-path validation.
- [ ] Table formats: read `latex`/`markdown`/`html`/`tsv` from the table body
      span (new schema keeps `table_body` HTML; legacy keeps the current logic).

Tests: `test/boxNormalizer.test.ts`

- [ ] New-schema text block with inline equation/code/hyperlink.
- [ ] New-schema image with nested `image_body.image_path`.
- [ ] New-schema table with `table_body` HTML.
- [ ] Legacy `pdf_info` regression (existing cases must stay green).
- [ ] Add fixtures to `test/domainFixtures.ts`.

**Acceptance:** both schemas normalize to the same `NormalizedBox` shape with
correct page numbers, normalized bbox, text, formula, image path and table
formats.

### Phase 3 — Unified V1 client

Files: `src/modules/mineruClient/v1.ts` (new), `api.ts`, `http.ts`,
`download.ts`, `result.ts`, `factory.ts`, `index.ts`

- [ ] `v1.ts`:
  - `submitPdf(filePath)`:
    - cached `GET /v1/health` → `features.sources`.
    - if local and `local` advertised → `source = { type:"local", path }`.
    - else upload: `POST /v1/uploads`; handle `status:"completed"` (sha256
      dedup, no PUT); otherwise PUT bytes to `upload_url` using
      `upload_method`/`upload_headers`, attaching `Bearer` **only when the
      upload origin equals the API origin**; then
      `POST /v1/uploads/{id}/complete` → `file.id`.
    - `POST /v1/parse/jobs` with `tier` (omit when unset) and
      `output_formats = ["markdown","middle_json","zip"]` → `job_id`.
    - return `{ taskID: job_id }`.
  - `pollTask(taskID)`: `GET /v1/parse/jobs/{job_id}`; map
    `completed` → succeeded, `partial` → succeeded if a file completed else
    failed, `failed`/`canceled` → failed with the file/job error message.
  - `downloadResult(taskID)`: re-fetch the job, read
    `files[0].output_files`; download `markdown` and `middle_json` directly;
    download `zip` for images (and markdown/middle_json fallback). Return a
    `MinerUParseResult` with `rawResult`, `markdown`, `images`.
- [ ] `result.ts`: support new ZIP names (`middle_json.json`, `markdown.md`,
      `structured_content.json`) and keep legacy fallbacks (`layout.json`,
      `*_middle.json`, `*_content_list.json`, `full.md`). Drop `layout.pdf`
      reading (plugin generates its own layout PDF).
- [ ] `http.ts`: add same-origin upload-header helper mirroring
      `api_client._same_origin_upload_headers`; keep bare-XHR PUT guidance so
      presigned signatures are not invalidated.
- [ ] `factory.ts`: `createMinerUClientForSettings` returns the V1 client for
      both `online` and `local`, passing base URL + tier; delete the
      precise/lite branching.
- [ ] Delete `onlinePrecise.ts`, `agentLite.ts`, `formData.ts`; remove v4
      helpers (`fetchBatchResult`, `firstExtractResult`, `getUploadURL`,
      `FileUrlsBatchResponse`) from `api.ts`.
- [ ] `index.ts`: export the new client and remove dead exports.

Tests: rewrite `test/mineruClient.test.ts` around mocked `fetch`:

- [ ] Upload create → PUT → complete → job create → poll → download.
- [ ] sha256 dedup short-circuit (`status:"completed"`).
- [ ] Same-origin vs cross-origin upload headers (no key leak).
- [ ] 302 redirect on `/v1/files/{id}/content`.
- [ ] `partial`/`failed`/`canceled` job mapping.
- [ ] `local` source path when `/v1/health` advertises it.
- [ ] New + legacy ZIP extraction.

**Acceptance:** local and online both parse a fixture PDF end-to-end under a
mocked transport; no references to `/api/v4` or `/api/v1/agent` remain.

### Phase 4 — Parse manager / network integration

Files: `src/modules/parseManager.ts`, `src/modules/parseNetwork.ts`

- [ ] Map preferences → client options: `parseTier`, base URL, API key.
- [ ] `parseNetwork.ts`: recognize V1 stages (`submit`, `upload`,
      `poll`, `download`) for retry classification; keep "submit/upload never
      retry" and "GET stages retry with backoff".
- [ ] `isTaskNotFoundError`: treat V1 `job_not_found` (404) as a lost local
      task; keep the current policy of only resubmitting for `local`.
- [ ] Error message mapping: replace `local-*`/`agent-*` stage names with V1
      stages in `getParseFailureMessage`.
- [x] Layout PDF feature removed entirely; `downloadResult` no longer carries
      `layoutPdf` and there is no `attachLayoutPdf` path to preserve.
- [x] Drop the layout PDF handling; the plugin no longer generates or attaches
      an annotated PDF.
- [ ] Update chunk page limit if desired (V1 allows 1000 pages/200 MB; keep
      200 by default to stay conservative, or make it tier/source aware).
- [ ] Keep `requiresApiKey`: online requires a key; local is optional.

**Acceptance:** `parseManager` unit tests pass with a fake V1 client; resume,
chunking, and task-store flows unchanged.

### Phase 5 — Preferences and UI

Files: `src/utils/prefs.ts`, `addon/prefs.js`, `typings/prefs.d.ts`,
`addon/content/preferences.xhtml`, `addon/locale/en-US/preferences.ftl`,
`addon/locale/zh-CN/preferences.ftl`

- [ ] Add `parseTier` preference (`standard` default) and accessors
      `getParseTier`/`setParseTier`.
- [ ] Keep `parseSource`; retire `parseMode` (remove the radio group, or keep a
      hidden migration default).
- [ ] Preferences UI:
  - online: show `standard` as the only supported tier (fixed note).
  - local: show `flash/basic/standard/advanced`, with a capability note sourced
    from `GET /v1/tiers`.
- [ ] Add Fluent keys: `pref-parse-tier-title`, `pref-parse-tier-standard`,
      `pref-parse-tier-flash`, `pref-parse-tier-basic`,
      `pref-parse-tier-advanced`, `pref-parse-tier-help`,
      `pref-parse-tier-online-fixed`.
- [ ] Update `typings/prefs.d.ts` to register `parseTier`.
- [ ] Update `preferenceScript.ts` if it reads `parseMode`.

**Acceptance:** settings render without errors; switching source updates the
tier options; existing installs migrate to `standard`.

### Phase 6 — Docs and cleanup

- [ ] Update `AGENTS.md` MinerU pipeline sections (V1 flow, tiers, schema 2.0,
      new ZIP names, remove precise/lite and v4 references).
- [ ] Update `README.md` / `README_zh.md` mode descriptions and tags if the
      `MinerU: Precise/Lite` labels change.
- [ ] Remove the now-unused `lite` write path or mark it legacy-only.
- [ ] Grep for stale strings: `api/v4`, `agent/parse`, `parseMode`, `precise`,
      `lite`, `/tasks`, `file_parse`.

### Phase 7 — Verification

- [ ] `npm run lint:check`
- [ ] `npm run build`
- [ ] `npx tsc -p test/tsconfig.json --noEmit`
- [ ] `node --test scripts/*.test.mjs`
- [ ] Full suite with a Zotero binary:
      `ZOTERO_PLUGIN_ZOTERO_BIN_PATH=<extracted>/zotero npm test -- --exit-on-finish`
- [ ] Manual smoke test against a live MinerU 4 local server (upload, poll,
      download, overlay render, result storage, resume).

---

## 4. Risks and mitigations

| Risk                                                                   | Mitigation                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Official cloud still returns legacy `pdf_info` while local returns 2.0 | Box normalizer explicitly supports both; fixtures for each.                                      |
| Presigned upload signature breaks when extra headers are added         | Bare XHR PUT; only add `Bearer` for same-origin uploads (mirror `api_client`).                   |
| `/v1/files/{id}/content` 302 must not leak credentials cross-origin    | Follow redirects without re-sending auth (Zotero/XHR strip on cross-origin); document + test.    |
| Local V1 upload/file/job indexes are in-process and lost on restart    | Keep current 404→resubmit-only-for-local behavior.                                               |
| Tier defaults silently degrade to `flash`                              | Omit `tier` / use `/v1/tiers` selection `standard -> basic`; never default PDF/image to `flash`. |
| Large refactor of `mineruClient.test.ts` masks regressions             | Land Phase 2 schema tests first, then client tests; keep legacy fixtures.                        |

---

## 5. Out of scope

- Native non-PDF inputs (DOCX/PPTX/XLSX/HTML/EPUB/OFD); the plugin only parses
  PDF attachments today.
- Doclib / persistent document library, chat/responses, webhooks, usage
  dashboards.
- Supporting MinerU 3.x side-by-side. (Could be added later behind a version
  probe of `/v1/health` vs `/health`.)

---

## 6. Suggested commit sequence

1. `test(fixtures): capture MinerU 4 middle json and V1 responses`
2. `feat(boxNormalizer): support Middle JSON 2.0`
3. `refactor(mineruClient): add unified V1 client`
4. `refactor(mineruClient): retire v4 batch and agent lite flows`
5. `refactor(parse): adapt parse manager and network retry to V1`
6. `feat(prefs): replace parse mode with parse tier`
7. `docs: document MinerU 4 migration`
