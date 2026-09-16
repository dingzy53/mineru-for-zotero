# Implementation Plan: MinerU Parsed Results Manager Window (已解析条目管理窗口)

## 1. Overview & Objectives

Add a standalone dialog window for viewing, managing, and cleaning up all parsed MinerU results stored on disk. The window is modeled directly after the existing Task Manager (`addon/content/taskManager.html` + `src/modules/taskStore.ts`).

### Pain Points Solved

1. **Disk Space Visibility**: MinerU outputs (`mineru-result.json`, `images/`, `content.md`, `layout.pdf`) accumulate silently. Users need per-entry sizes and a total.
2. **Orphan Cleanup**: When items/attachments are deleted in Zotero, their `ProfD/mineru-copy/attachments/<libraryID>-<attachmentKey>/` folders stay. The manager detects and purges these.
3. **Quick Actions**: One-click to reveal folder in OS explorer, locate item in Zotero library, preview Markdown, or delete results.
4. **Batch Operations**: Multi-select for batch delete, orphan purge, and batch sync to Agent Workspace folder.

---

## 2. Files to Create

| File                                | Purpose                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/resultsManager.ts`     | Service layer: scanning, correlation, deletion, window opening                                                                  |
| `addon/content/resultsManager.html` | Chrome HTML dialog (modeled on [`taskManager.html`](file:///home/ding/GitHub/mineru-for-zotero/addon/content/taskManager.html)) |
| `test/resultsManager.test.ts`       | Unit tests for the service layer                                                                                                |

## 3. Files to Modify

| File                                                                                                                  | Change                                                                |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`src/modules/storage.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/storage.ts)                         | Add `deleteResult()` and `getAttachmentDirSize()` to `StorageAdapter` |
| [`src/modules/preferenceScript.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/preferenceScript.ts)       | Bind the new "Manage Parsed Results" button                           |
| [`addon/content/preferences.xhtml`](file:///home/ding/GitHub/mineru-for-zotero/addon/content/preferences.xhtml)       | Add button element in Data Folder section                             |
| [`addon/locale/en-US/preferences.ftl`](file:///home/ding/GitHub/mineru-for-zotero/addon/locale/en-US/preferences.ftl) | Add `pref-open-results-manager` key                                   |
| [`addon/locale/zh-CN/preferences.ftl`](file:///home/ding/GitHub/mineru-for-zotero/addon/locale/zh-CN/preferences.ftl) | Add `pref-open-results-manager` key                                   |
| [`addon/locale/en-US/addon.ftl`](file:///home/ding/GitHub/mineru-for-zotero/addon/locale/en-US/addon.ftl)             | Add `mineru-for-zotero-results-manager-menuitem` key                  |
| [`addon/locale/zh-CN/addon.ftl`](file:///home/ding/GitHub/mineru-for-zotero/addon/locale/zh-CN/addon.ftl)             | Add `mineru-for-zotero-results-manager-menuitem` key                  |
| [`src/hooks.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/hooks.ts)                                             | Register Tools menu entry for Results Manager                         |
| [`src/addon.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/addon.ts)                                             | Expose `openResultsManagerWindow` on `addon.api`                      |

---

## 4. Phase 1 — Storage API Additions

### 4.1 Add `deleteResult()` to `StorageAdapter`

In [`src/modules/storage.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/storage.ts), extend the `StorageAdapter` interface (line 12) and its implementation in `createStorage()` (line 69):

```typescript
// Add to StorageAdapter interface
deleteResult(
  ref: AttachmentKeyRef,
  options?: { preciseOnly?: boolean; liteOnly?: boolean },
): Promise<void>;

getAttachmentDirSize(ref: AttachmentKeyRef): Promise<number>;
```

**Implementation details**:

- `deleteResult` uses the existing internal `removePath()` helper (line 610) which already handles `IOUtils.remove` with `recursive: true` and `OS.File` fallback.
- If `preciseOnly`, delete only `manifest.json`, `mineru-result.json`, `content.md`, `boxes.normalized.json`, `images/`, `layout.pdf`. If `liteOnly`, delete only `lite-manifest.json`, `lite-content.md`. If neither flag, delete the entire `<libraryID>-<attachmentKey>/` directory.
- `getAttachmentDirSize` walks the directory using `readDir()` (line 632) + `IOUtils.stat()` (per AGENTS.md: `stat.size` may be `undefined`, use `(stat.size ?? 0)`).

### 4.2 Add `readManifestSafe()` and `readLiteManifestSafe()`

Add safe manifest readers that return `null` instead of throwing, for scanning:

```typescript
readManifestSafe(ref: AttachmentKeyRef): Promise<ParseManifest | null>;
readLiteManifestSafe(ref: AttachmentKeyRef): Promise<LiteParseManifest | null>;
```

These wrap the existing `readManifest` / JSON reads in try-catch.

---

## 5. Phase 2 — Service Layer (`src/modules/resultsManager.ts`)

### 5.1 Types

```typescript
export interface ParsedResultEntry {
  /** Storage key, e.g. "1-ABCD1234" */
  dirKey: string;
  libraryID: number;
  attachmentKey: string;

  /** Zotero attachment item ID, or null if orphaned */
  attachmentID: number | null;
  /** Parent item title, or null if orphaned */
  parentTitle: string | null;
  /** Attachment file name from manifest */
  fileName: string;

  /** Parse mode flags */
  preciseReady: boolean;
  liteReady: boolean;

  /** Source badge: "online" | "local" | null */
  source: "online" | "local" | null;

  /** Parsed date from manifest (ISO string) */
  parsedAt: string | null;

  /** Disk size in bytes of the entire result directory */
  diskSizeBytes: number;

  /** Content flags */
  hasImages: boolean;
  hasLayoutPdf: boolean;
  hasBoxes: boolean;

  /** True if the Zotero attachment no longer exists */
  isOrphan: boolean;
}

export interface ResultsManagerDependencies {
  storage: StorageAdapter;
  getItemByLibraryAndKey: (
    libraryID: number,
    key: string,
  ) => Zotero.Item | false;
  getItemAsync: (id: number) => Promise<Zotero.Item>;
  revealFolder: (path: string) => Promise<void>;
  selectItemInLibrary: (itemID: number) => void;
  removeItemTag: (item: Zotero.Item, tag: string) => Promise<void>;
  eraseItem: (itemID: number) => Promise<void>;
}
```

### 5.2 Core Functions

#### `scanAllResults(deps): Promise<ParsedResultEntry[]>`

1. Call `deps.storage.listParseStatuses()` to get `Map<string, { preciseReady, liteReady }>`.
2. For each entry, split the key into `[libraryID, attachmentKey]` (pattern: `idKey.split("-")`, first part is `parseInt(parts[0], 10)`, rest joined is key — but per `storage.ts` regex `/^\d+-[A-Z0-9]+$/`, the format is `<number>-<ALPHANUMERIC>`).
3. Look up `deps.getItemByLibraryAndKey(libraryID, attachmentKey)`:
   - **Exists**: extract `attachment.parentItem?.getField("title")`, `attachment.id`, file name from manifest.
   - **Missing or deleted**: mark `isOrphan: true`.
4. Read manifest for `parsedAt`, `source`, `fileName` via `storage.readManifestSafe()` / `readLiteManifestSafe()`.
5. Compute disk size via `storage.getAttachmentDirSize()`.
6. Check file presence: `hasImages` (check `images/` dir exists), `hasLayoutPdf` (via `storage.hasLayoutPdf()`), `hasBoxes` (check `boxes.normalized.json` existence).
7. Sort results by `parsedAt` descending (newest first).

#### `deleteResult(entry, options, deps): Promise<{ freedBytes: number }>`

1. `const freed = entry.diskSizeBytes;`
2. Call `deps.storage.deleteResult(ref, options)`.
3. If `options.removeTags` and `entry.attachmentID`:
   - Get attachment via `deps.getItemAsync(entry.attachmentID)`.
   - Remove tags: `"MinerU: Precise ✅"`, `"MinerU: Lite ✅"` (per tag list in [`agentSync.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/agentSync.ts)).
   - Save via `item.saveTx()`.
4. If `options.removeLayoutAttachment` and `entry.attachmentID`:
   - Get parent item → iterate child attachments → find ones with tag `"MinerU: Layout"` or title ending `(MinerU Layout)` (using the `isMinerUGeneratedAttachment` pattern from [`parseManager.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/parseManager.ts)).
   - Erase via `deps.eraseItem(layoutAttachmentID)`.
5. Return `{ freedBytes: freed }`.

#### `cleanOrphans(entries, deps): Promise<{ count: number; freedBytes: number }>`

1. Filter `entries.filter(e => e.isOrphan)`.
2. For each orphan, call `deps.storage.deleteResult(ref)`.
3. Sum freed bytes and count.

### 5.3 Window Opening Function

Follow the exact pattern from [`openTaskManagerWindow()`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/taskStore.ts#L168-L205):

```typescript
export function openResultsManagerWindow(): void {
  try {
    const mainWin = Zotero.getMainWindow();
    if (!mainWin) return;

    // Duplicate check via nsIWindowMediator
    try {
      const wm = (Components.classes as any)[
        "@mozilla.org/appshell/window-mediator;1"
      ]?.getService(Components.interfaces.nsIWindowMediator);
      if (wm) {
        const existing = wm.getMostRecentWindow("mineruResultsManager");
        if (existing) {
          existing.focus();
          return;
        }
      }
    } catch (_e) {}

    const storage = createStorage("ProfD/mineru-copy");
    mainWin.openDialog(
      `chrome://${addon.data.config.addonRef}/content/resultsManager.html`,
      "MinerUResultsManager",
      "chrome,dialog=no,centerscreen,dependent=yes,alwaysRaised=yes," +
        "width=900,height=650,resizable",
      { Zotero, storage },
    );
  } catch (e) {
    ztoolkit.log("Failed to open Results Manager window", e);
  }
}
```

### 5.4 Service Factory

Create a factory that wires real Zotero APIs into the `ResultsManagerDependencies`. This is what gets passed to the dialog via `window.arguments[0]`:

```typescript
export function createResultsManagerService(
  storage: StorageAdapter,
): ResultsManagerService {
  const deps: ResultsManagerDependencies = {
    storage,
    getItemByLibraryAndKey: (libID, key) =>
      Zotero.Items.getByLibraryAndKey(libID, key),
    getItemAsync: (id) => Zotero.Items.getAsync(id),
    revealFolder: (path) => storage.openDataFolder(), // or Zotero.File.reveal
    selectItemInLibrary: (itemID) => {
      const zp = Zotero.getActiveZoteroPane();
      if (zp) {
        zp.selectItem(itemID, true);
        zp.window?.focus?.();
      }
    },
    removeItemTag: async (item, tag) => {
      if (item.hasTag(tag)) {
        item.removeTag(tag);
        await item.saveTx();
      }
    },
    eraseItem: async (id) => {
      const item = await Zotero.Items.getAsync(id);
      if (item) await item.eraseTx();
    },
  };

  return {
    scan: () => scanAllResults(deps),
    deleteResult: (entry, options) => deleteResult(entry, options, deps),
    cleanOrphans: (entries) => cleanOrphans(entries, deps),
    revealFolder: (path) => deps.revealFolder(path),
    locateItem: (itemID) => deps.selectItemInLibrary(itemID),
    readMarkdown: (ref) => storage.readPreferredMarkdown(ref),
  };
}
```

---

## 6. Phase 3 — HTML Dialog (`addon/content/resultsManager.html`)

### 6.1 Architecture

Single-file chrome HTML dialog (like `taskManager.html`). All CSS in `<style>`, all JS in `<script>`. No external dependencies.

### 6.2 Zotero Object Resolution

Use the 4-tier fallback from `taskManager.html`:

```javascript
function getZotero() {
  if (window.arguments && window.arguments[0]?.Zotero)
    return window.arguments[0].Zotero;
  if (globalThis.Zotero) return globalThis.Zotero;
  if (globalThis.opener?.Zotero) return globalThis.opener.Zotero;
  try {
    return ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs")
      .Zotero;
  } catch (_) {
    return null;
  }
}
```

Set `windowtype="mineruResultsManager"` on `<html>` for `nsIWindowMediator` dedup.

### 6.3 Localization

Use `addonApi.getString(id, args)` with fallback English literals, same pattern as Task Manager:

```javascript
function rmText(id, fallback, args) {
  var api = getZotero()?.MinerUForZotero?.api;
  if (api?.getString) {
    try {
      return api.getString(id, args);
    } catch (_) {}
  }
  if (args) {
    return fallback.replace(/\{\s*\$(\w+)\s*\}/g, (_, k) => args[k] ?? _);
  }
  return fallback;
}
```

### 6.4 UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ MinerU Parsed Results                          [Scan Orphans]│
├─────────────────────────────────────────────────────────────┤
│ Summary Cards Row:                                          │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│ │ Total: 42│ │Precise:35│ │ Lite: 12 │ │142.8 MB  │       │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
├─────────────────────────────────────────────────────────────┤
│ [Search... ] [Mode ▾] [Filter ▾] [Sort ▾]                  │
├─────────────────────────────────────────────────────────────┤
│ ☐ ☑ Select All                                              │
│                                                             │
│ ☐ Paper Title — attachment.pdf                              │
│   [Precise] [Online] 12.3 MB  2026-09-01                   │
│   [📂 Folder] [🔍 Locate] [👁 Preview] [🗑 Delete]         │
│                                                             │
│ ☐ ⚠️ ORPHAN — unknown.pdf                                   │
│   [Precise] 5.1 MB  2026-08-15                             │
│   [📂 Folder] [🗑 Delete]                                   │
│ ...                                                         │
├─────────────────────────────────────────────────────────────┤
│ Selected: 3  [Batch Delete] [Batch Sync]                    │
└─────────────────────────────────────────────────────────────┘
```

### 6.5 Theme Support

Follow `taskManager.html` CSS with `@media (prefers-color-scheme: dark)`:

- Light: `background: #f9f9fa`, cards `#fff`, border `#e0e0e0`, text `#15141a`
- Dark: `background: #1e1e1e`, cards `#2d2d2d`, border `#404040`, text `#e0e0e0`

### 6.6 Data Loading & Rendering

On `window.addEventListener("load", ...)`:

1. Get the service from `window.arguments[0].service` (the `ResultsManagerService` object created by `createResultsManagerService()`).
2. Call `service.scan()` to get all `ParsedResultEntry[]`.
3. Compute summary stats (total count, precise/lite counts, total disk size).
4. Render summary cards and card list with action button event handlers.

> [!IMPORTANT]
> Chrome HTML dialogs cannot `import` from TypeScript modules. Pass a pre-built service object via `window.arguments[0]` (like `taskStore` in Task Manager). The service runs in the plugin's privileged context and exposes async methods: `scan()`, `deleteResult()`, `cleanOrphans()`, `revealFolder()`, `locateItem()`, `readMarkdown()`.

### 6.7 Action Implementations

| Action                   | Implementation                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Open Folder**          | `await Zotero.File.reveal(nativePath)` with `Zotero.launchFile()` fallback (pattern from [`storage.ts:652`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/storage.ts#L652)) |
| **Locate in Zotero**     | `service.locateItem(itemID)` → calls `ZoteroPane.selectItem(id, true)` + `window.focus()`                                                                                            |
| **Preview Markdown**     | `service.readMarkdown(ref)` → display in a scrollable modal `<div>` with copy-to-clipboard button                                                                                    |
| **Delete**               | Show confirmation dialog with checkboxes ("Also remove tags", "Also remove layout PDF"), call `service.deleteResult(entry, options)`, re-render                                      |
| **Batch Delete**         | Iterate checked entries, call delete for each, then re-scan and re-render                                                                                                            |
| **Scan & Clean Orphans** | Call `service.cleanOrphans(entries)`, show freed space in alert, re-scan                                                                                                             |
| **Batch Sync**           | For each checked entry, call `syncResultToAgentFolder()` from [`agentSync.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/agentSync.ts)                                  |

---

## 7. Phase 4 — Integration Points

### 7.1 Preferences Button

In [`addon/content/preferences.xhtml`](file:///home/ding/GitHub/mineru-for-zotero/addon/content/preferences.xhtml), in the Data Folder section, add a button **next to** the existing "Open Task Manager" button:

```xml
<html:button id="__addonRef__-open-results-manager"
             data-l10n-id="pref-open-results-manager"></html:button>
```

In [`src/modules/preferenceScript.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/modules/preferenceScript.ts), add binding near line 298 (next to the task manager binding):

```typescript
document
  .getElementById(`${config.addonRef}-open-results-manager`)
  ?.addEventListener("click", () => {
    const addonObj = (Zotero as any).MinerUForZotero;
    if (addonObj?.api?.openResultsManagerWindow) {
      addonObj.api.openResultsManagerWindow();
    }
  });
```

### 7.2 Tools Menu Entry

In [`src/hooks.ts`](file:///home/ding/GitHub/mineru-for-zotero/src/hooks.ts), inside `onMainWindowLoad()`, register a Tools menu entry using `Zotero.MenuManager.registerMenu`:

```typescript
import { openResultsManagerWindow } from "./modules/resultsManager";

// Inside onMainWindowLoad():
getMenuManager().registerMenu({
  menuID: `${config.addonRef}-results-manager`,
  pluginID: config.addonID,
  target: "main/menubar/tools",
  menus: [
    {
      menuType: "menuitem",
      l10nID: getLocaleID("results-manager-menuitem"),
      icon: `chrome://${config.addonRef}/content/mineru.svg`,
      onCommand: () => openResultsManagerWindow(),
      onShowing: (_event, context) => context.setVisible(true),
    },
  ],
});
```

> [!NOTE]
> Verify that `Zotero.MenuManager.registerMenu` supports `target: "main/menubar/tools"` in the project's target Zotero version (8/9). If it does not, use `ztoolkit.Menu` to add the entry under Tools. Check the existing `itemMenu.ts` pattern — it only uses `target: "main/library/item"`.

### 7.3 Expose on `addon.api`

In `src/addon.ts` (or wherever `addon.api` is set), add:

```typescript
import { openResultsManagerWindow } from "./modules/resultsManager";

this.api = {
  taskStore,
  openTaskManagerWindow,
  openResultsManagerWindow, // <-- add
};
```

### 7.4 Localization Keys

**`addon/locale/en-US/preferences.ftl`** — add:

```ftl
pref-open-results-manager = Manage Parsed Results
```

**`addon/locale/zh-CN/preferences.ftl`** — add:

```ftl
pref-open-results-manager = 管理已解析结果
```

**`addon/locale/en-US/addon.ftl`** — add:

```ftl
mineru-for-zotero-results-manager-menuitem =
    .label = MinerU Parsed Results Manager
```

**`addon/locale/zh-CN/addon.ftl`** — add:

```ftl
mineru-for-zotero-results-manager-menuitem =
    .label = MinerU 已解析结果管理
```

**Results Manager dialog strings** — add to both `addon/locale/en-US/addon.ftl` and `addon/locale/zh-CN/addon.ftl`:

```ftl
results-manager-title = MinerU Parsed Results
results-manager-empty = No parsed results found
results-manager-total = Total: { $count }
results-manager-precise-count = Precise: { $count }
results-manager-lite-count = Lite: { $count }
results-manager-disk-usage = Disk: { $size }
results-manager-orphan-badge = Orphan
results-manager-delete-confirm = Delete parsed results for "{ $title }"?
results-manager-delete-tag-option = Also remove MinerU tags
results-manager-delete-layout-option = Also remove layout PDF attachment
results-manager-orphan-clean-result = Cleaned { $count } orphan folders, freed { $size }
results-manager-batch-delete-confirm = Delete { $count } selected results?
```

---

## 8. Phase 5 — Tests (`test/resultsManager.test.ts`)

### 8.1 Test Strategy

Use injected `ResultsManagerDependencies` fakes — no real Zotero DB or filesystem. Follow the pattern from [`test/itemMenu.test.ts`](file:///home/ding/GitHub/mineru-for-zotero/test/itemMenu.test.ts).

### 8.2 Test Cases

#### Scanning

1. **Empty storage**: `listParseStatuses()` returns empty map → `scanAllResults()` returns `[]`.
2. **Normal entries**: Two entries with valid Zotero items → returns entries with correct `parentTitle`, `attachmentID`, `isOrphan: false`.
3. **Orphan detection**: Entry where `getItemByLibraryAndKey()` returns `false` → `isOrphan: true`, `attachmentID: null`, `parentTitle: null`.
4. **Mixed precise+lite**: Entry with both `preciseReady` and `liteReady` → both flags true.
5. **Sort order**: Results sorted by `parsedAt` descending.

#### Deletion

6. **Delete with tags**: `deleteResult()` with `removeTags: true` → verifies `removeItemTag` called with `"MinerU: Precise ✅"` and `"MinerU: Lite ✅"`.
7. **Delete with layout cleanup**: `removeLayoutAttachment: true` → verifies `eraseItem` called for layout attachment ID.
8. **Delete orphan (no Zotero item)**: Only storage deletion, no tag/attachment operations.

#### Orphan Cleanup

9. **Clean orphans**: 3 entries, 1 orphan → `cleanOrphans()` deletes 1 folder, returns `{ count: 1, freedBytes }`.
10. **No orphans**: Returns `{ count: 0, freedBytes: 0 }`.

#### Storage Additions

11. **`deleteResult()` full**: Removes entire attachment directory.
12. **`deleteResult()` preciseOnly**: Removes only precise files, keeps lite.
13. **`deleteResult()` liteOnly**: Removes only lite files, keeps precise.
14. **`getAttachmentDirSize()`**: Returns sum of file sizes in directory.

### 8.3 Verification

```bash
npx tsc -p test/tsconfig.json --noEmit    # type check
npm run lint:check                         # lint gate
npm run build                              # production build
npm test                                   # full scaffold suite (if Zotero binary available)
```

---

## 9. Implementation Order & Checklist

### Step 1: Storage API (estimated: small)

- [ ] Add `deleteResult()` to `StorageAdapter` interface and implementation
- [ ] Add `getAttachmentDirSize()` to `StorageAdapter`
- [ ] Add `readManifestSafe()` and `readLiteManifestSafe()`
- [ ] Unit test the new storage methods

### Step 2: Service Layer (estimated: medium)

- [ ] Create `src/modules/resultsManager.ts`
- [ ] Implement `ParsedResultEntry` type
- [ ] Implement `ResultsManagerDependencies` interface
- [ ] Implement `scanAllResults()`
- [ ] Implement `deleteResult()`
- [ ] Implement `cleanOrphans()`
- [ ] Implement `openResultsManagerWindow()`
- [ ] Implement `createResultsManagerService()` factory that wires real Zotero APIs to dependencies
- [ ] Write `test/resultsManager.test.ts`

### Step 3: HTML Dialog (estimated: large)

- [ ] Create `addon/content/resultsManager.html`
- [ ] Theme support (light/dark CSS)
- [ ] Summary cards row
- [ ] Search & filter bar
- [ ] Result card list with action buttons
- [ ] Markdown preview modal
- [ ] Delete confirmation dialog
- [ ] Batch action bar
- [ ] Zotero object resolution (4-tier fallback)
- [ ] Localization via `rmText()` helper

### Step 4: Integration (estimated: small)

- [ ] Add button to `preferences.xhtml`
- [ ] Bind button in `preferenceScript.ts`
- [ ] Add Tools menu entry in `hooks.ts`
- [ ] Expose on `addon.api`
- [ ] Add all locale keys (en-US + zh-CN)

### Step 5: Validation (estimated: small)

- [ ] `npx tsc -p test/tsconfig.json --noEmit` passes
- [ ] `npm run lint:check` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` passes (if Zotero binary available)

---

## 10. Risks & Decisions

| Decision                           | Recommendation                                              | Rationale                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Service data passing to HTML       | **Option A: pass service object via `window.arguments[0]`** | Same proven pattern as `taskStore` in Task Manager; keeps logic in TypeScript                                                 |
| Virtual list for large result sets | **Defer** — use simple DOM rendering first                  | Most users have <200 parsed items; optimize if needed later                                                                   |
| Batch export as zip                | **Defer** to a future phase                                 | Core value is visibility + cleanup; export adds complexity                                                                    |
| Tools menu registration API        | **Verify at implementation time**                           | `Zotero.MenuManager` with `target: "main/menubar/tools"` may or may not be supported — fall back to `ztoolkit.Menu` if needed |
| Sync folder cleanup on delete      | **Include**                                                 | When deleting a result, also remove corresponding folder from Agent sync directory and update `_index.json`                   |
