# Repository Guidelines

## Project Structure & Module Organization

This repository is a Zotero 8/9 plugin built with TypeScript and `zotero-plugin-scaffold`. Runtime source lives in `src/`: `index.ts` is the entry point, `hooks.ts` handles Zotero lifecycle and menu registration, `modules/` contains feature modules, and `utils/` contains shared helpers. Static plugin assets and Zotero metadata live in `addon/`, including `manifest.json`, `prefs.js`, XUL/XHTML/CSS under `addon/content/`, SVG toolbar/menu assets, icons, and Fluent locale files under `addon/locale/<locale>/`. Type declarations live in `typings/`. Tests live in `test/` and use `*.test.ts` naming. Generated build output is under `.scaffold/build/` and should not be edited manually.

Core feature modules currently include `mineruClient/` for selecting and running online precise, online lite, and local MinerU clients; `parseManager.ts` for item/attachment parsing orchestration; `parseNotice.ts` for source/mode-aware parsing notices and batch progress; `itemMenu.ts` for the attachment-only library context menu; `storage.ts` for per-attachment precise and lite result persistence; `domain.ts` for shared parse, storage, and overlay domain types; `boxNormalizer.ts` for converting MinerU schemas into stable boxes; `copyFormatter.ts` for copy output; `readerToolbar/` for the PDF Reader toolbar menu; `readerOverlay/` for box rendering and selection behavior; and `preferenceScript.ts` for settings-page API source, parse mode, local endpoint, image-saving, and data-folder UI.

## Build, Test, and Development Commands

- Use `npm` for package scripts and dependency operations. Tracked lockfile is `package-lock.json`.
- `npm start`: runs `zotero-plugin serve`, builds in dev mode, launches Zotero, and watches for hot reload.
- `npm run build`: creates production plugin (`.scaffold/build/mineru-for-zotero.xpi`) then runs `tsc --noEmit`.
- `npm test`: runs scaffold test suite. On local Linux, provide tarball path: `ZOTERO_PLUGIN_ZOTERO_BIN_PATH=<extracted>/zotero npm test`.
- `npm run lint:check`: checks Prettier formatting and ESLint rules.
- `npm run lint:fix`: formats files and applies safe ESLint fixes.
- `npm run release`: starts the release flow; GitHub Actions handles publishing `.xpi` on `v*` tags.

Treat `npm run lint:check` as a CI gate. Run it before commits and fix all issues.

## Coding Style & Naming Conventions

Use TypeScript ES modules and follow two-space indentation. Prettier uses `printWidth: 80`, `tabWidth: 2`, LF. Keep module filenames descriptive and lower camel case. Locale keys belong in Fluent files, not inline UI strings.

## Testing Guidelines

Tests use Mocha/Chai via `zotero-plugin test`. Place tests in `test/*.test.ts`.

When modifying core UI functions or adding async DOM APIs like `IntersectionObserver`, update corresponding tests and provide synchronous mocks (e.g., in `createDocumentStub`) to prevent massive test failures. If unable to run `npm test`, run `npx tsc -p test/tsconfig.json --noEmit` to verify test typings before committing.

### Understanding Scaffold Test Failures

Scaffold streams test results as JSON, which drops non-enumerable Error properties. A thrown error often prints as `undefined` instead of a stack trace. Mocha timeouts also serialize as `undefined`, which often indicates a blocked test (e.g., a modal `alert()` blocking headless CI—always stub `Zotero.getMainWindow`). To get the real stack trace, bundle the test file with `esbuild` and run it via standalone Node `mocha` with minimal Zotero stubs. `Error: The operation was canceled.` mid-run means Zotero aborted, often due to opening real dialogs in tests.

After code changes, run full tests with `zotero-plugin test --exit-on-finish`.

Standalone Node tests under `scripts/` are run separately via `node --test scripts/*.test.mjs`.

## Test Profile Port Isolation

`zotero-plugin-scaffold` sets the test profile HTTP port to **23124** (default 23119) to avoid conflicts. The `scripts/fix-test-profile.mjs` pre-hook mitigates leaks of this port into `prefs.js`. If the Zotero Connector extension breaks after development work, run `node scripts/fix-zotero-connector-port.mjs` to restore port `23119` in the real profile.

## MinerU Parsing Pipeline

### Parse Manager Dependency Injection Contract

`parseAttachmentWithDependencies()` must keep every external boundary behind `ParseManagerDependencies`: item lookups, window opening, page counting, storage, clients, notices, and callbacks. Never call `Zotero.Items.getAsync`, `attachment.getField()`, or `openTaskManagerWindow()` directly.

Parse notices are failure-only. Success states emit no UI notices. Errors (empty results, file access errors) report via `dependencies.showMessage(failure.id, failure.args)`.

### Client Selection & API Limits

MinerU parsing is selected by `createMinerUClientForSettings()` from `parseSource` (`online`/`local`) and `parseMode` (`precise`/`lite`).

MinerU API limits:

- **Precision Extract API (v4)**: max 200 MB/file, max 600 pages/file, batch up to 200 files.
- **Agent Lightweight API (v1)**: max 10 MB/file, max 20 pages/file, single file only.
- `MINERU_API_MAX_CONCURRENT_REQUESTS` limits concurrency (clamped 1-10, default 3). Tests override it via `getMaxConcurrentRequests`.

### Online Precise Flow

Uses the official MinerU v4 batch extraction flow: request `/api/v4/file-urls/batch`, upload PDF to the presigned URL, poll `/api/v4/extract-results/batch/{batch_id}`, then download `full_zip_url` or `md_url`.

### Online Lite Flow

Uses MinerU Agent API flow (`mineruClient/agentLite.ts`): create task, upload to file URL, poll Agent endpoint, download Markdown. Preserve both wrapped (`data`) and top-level response handling.

### Local Parsing Flow

Uses async local API (`mineruClient/local.ts`): `/health`, submit multipart to `/tasks`, poll `/tasks/{taskID}`, download `/tasks/{taskID}/result`. Results may be ZIP or JSON.

### Presigned URL Uploads

Prefer a bare XHR PUT for uploads to presigned URLs so extra headers do not change the signature calculation and trigger `SignatureDoesNotMatch`.

### Result Download & ZIP Handling

When downloading result ZIPs locally, prefer Zotero runtime readers like `nsIZipReader`; do not assume `DecompressionStream` is available. Verify CDN URLs and network response headers when debugging empty/corrupt ZIP downloads.

### Task Persistence, Resume & Reconnect

Task records persist in `ProfD/mineru_tasks.json` via a serialized save queue. Stuck `running` tasks on startup are marked `failed` to prompt Resume or Retry.

Resume state includes `TaskRecord.resume` bookkeeping and chunk caches in `ProfD/mineru-resume/<attachmentID>/`. Caches stay until the final merged result is written, after which `cleanupTaskResume()` removes them.

Transient network failures (status 0 or ≥ 500) reconnect with exponential backoff for idempotent GET stages only; submit/upload stages never retry to avoid burning quota. A local 404 during poll means the remote task was lost: only that unfinished chunk is resubmitted.

### Box Normalization

MinerU box data formats vary (`pages[].blocks`, `pdf_info[].para_blocks`, `pdf_info[].layout_dets`, etc.). `boxNormalizer.ts` converts these into stable boxes, preserving detailed types (captions, formulas, references). Check supported schemas when handling missing box errors.

## Storage & Agent Sync

### Local Result Storage

Precise results are in `ProfD/mineru-copy/attachments/<libraryID>-<attachmentKey>/` (`manifest.json`, `mineru-result.json`, `content.md`, `boxes.normalized.json`, `images/`). Lite results are stored beside them as `lite-manifest.json` and `lite-content.md`.

Use `storage.readPreferredMarkdown()` to read precise first, then lite fallback. Ignore transient `.tmp-*` and `.bak-*` files.
`createStorage()` resolves the path segment as a Zotero dirsvc key which throws `NS_ERROR_FAILURE` if unknown; tests must use roots not matching a dirsvc key. `listParseStatuses()` must sort entries for stable test order.

### Agent-Friendly Sync Folder

The optional sync folder copies results into `[CitationKey] - [Title]` format. Sync happens once per successful parse. `_index.json` maintains the list of synced entries.

### PDF Splitting for Large Files

PDFs exceeding limits are automatically split using `pdf-lib` (pure JS). If `pdf-lib` fails, it falls back to `pdftk` via `Subprocess`. Use `pdftk <file> dump_data` to read page count and `pdftk <file> cat 1-200 output <target>` to split. On macOS/Linux, wrap the fallback in `/bin/sh -c 'pdftk "$@"' sh ...args` to resolve Flatpak PATH issues. On Windows, call `pdftk` directly since `/bin/sh` doesn't exist. Sequential chunk processing is the safe default, with `parallelSplit` as an opt-in preference.

## Cross-Platform Compatibility

### Platform Detection

`getRuntimePlatform()` must check `AppConstants.platform` for exact string matches first (`"win"`, `"macosx"`, `"linux"`). Remember that Mac is `"macosx"`, not `"mac"`.

### Subprocess Module Loading

Load `Subprocess` handling both import styles:

```typescript
try {
  ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
} catch {
  ChromeUtils.import("resource://gre/modules/Subprocess.jsm");
}
```

### OS.File Deprecation

Migrate `OS.File.stat()` to `IOUtils.stat()`. Use `(stat.size ?? 0)` as `stat.size` can be undefined.

## Zotero Runtime Quirks

### TypeScript Casts

- `Zotero.Utilities.System.exec` requires cast: `(Zotero.Utilities as any).System?.exec`.
- XPCOM contract IDs need cast: `(Components.classes as any)["@mozilla.org/..."]`.
- `Zotero.Items.getAsync` needs specific array cast: `number[]` or `string[]`.

### Plugin Instance Access

Access plugin via `(Zotero as any).MinerUForZotero`.

### Window Management

`window.open()` from Preferences tabs may lose opener refs on Flatpak/Wayland. Use `Zotero.getMainWindow().openDialog()` instead. Child windows should fall back across `window.arguments[0]`, `globalThis.Zotero`, and `opener.Zotero`.

### Logging

For diagnostics, emit to `Zotero.debug` and `console.info` to ensure visibility across runtime environments.

### Preferences & Fluent Locale Files

New preferences must be registered in `addon/prefs.js` with **unprefixed** keys. Locale files use FTL syntax (`pref-sync-folder = Label text`).

## Item Context Menu

Reparse prompts must default non-destructively to `use-existing`. The context menu targets PDF attachments only. Task submission and completion do not show notifications to the user; only failures do. When registering commands, ensure lifecycle alignment with Zotero's localization resources to prevent broken right-click menus on unload.

## Reader Toolbar & Overlay

### Toolbar UI

Toolbar UI is icon-driven, registered per reader window. Keep panel state per reader instance.

### Overlay Modes & Selection

Modes: `all`, `hover`, `off`. Shift/Ctrl enables multi-selection. Default behavior allows native PDF text selection (`pointer-events: none`). Only modifier-key mode enables overlay pointer events.

### Overlay Mounting & Lifecycle

Mount the overlay root on the reader document `body` or `documentElement`, not `#viewerContainer`. Keep `rootsByWindow` synced, clean up overlays when a reader disappears, and avoid leaving stale UI state if data is missing.

### Large PDF Virtualization

Do not synchronously build thousands of DOM nodes for large PDFs. Construct empty page layers (`.mineru-copy-page-layer`) synchronously, and use `IntersectionObserver` to lazy-load boxes.

### Hover & Z-Index

Hover retention must include absolutely positioned child menus. Floating menus must keep the owning box in a sustained elevated state so later boxes don't cover the open menu.

### Layout Isolation

Do not reuse the icon-only toolbar button base class for text menu items.

### Overlay Tests

`buildReaderOverlayRoot()` returns `{ root, cleanup }`; tests must destructure. `createDocumentStub()` must provide synchronous mocks for APIs like `IntersectionObserver`.

## CLI Tool

The companion CLI (`mineru-for-zotero-cli/scripts/query-markdown.mjs`) provides agent-readable access via the local HTTP query API.
Commands: `libraries`, `collections`, `tags`, `search`, `markdown`.
Granularity modes for `markdown`: `full`, `headings`, `section`, `search`, `locate`.
Auto-detects the server port, outputting agent-readable text by default.

## Commit & Pull Request Guidelines

Follow Conventional Commits. PRs should describe changes, list test results, link issues, and include UI screenshots. Confirm `npm run lint:check` passes before committing.
