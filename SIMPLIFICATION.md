# MinerU for Zotero —— 依赖盘点与简化实施计划

> 状态：**草案 / 仅分析，未改动任何代码**
> 基线版本：`0.9.8`（commit `5eaec01`）
> 目的：记录依赖现状、体积构成与可简化项，作为后续实施清单。

## 0. 方法与基线数据

分析均为只读操作（探针输出写入 `/tmp`，仓库工作区保持干净）：

```bash
npm ls --depth=0                                   # 依赖树 + extraneous
du -sh node_modules .scaffold/build                # 体积
npx esbuild src/index.ts --bundle --target=firefox115 \
  --define:__env__='"production"' \
  --outfile=/tmp/bundle-probe.js --metafile=/tmp/meta.json   # 打包构成
```

关键基线：

| 指标 | 数值 |
|---|---|
| `node_modules` 体积 / 包数 | 231 MB / 232 |
| XPI 体积 | 344 KB |
| 打包后 JS（未压缩） | 1.31 MB（`.scaffold/build/addon/content/scripts/mineruForZotero.js`） |
| `src/` 总行数 | 15,911 |
| `test/` 总行数 | 13,346 |

### 打包构成（esbuild `bytesInOutput`）

| 组成 | 体积 | 占比 |
|---|---|---|
| **pdf-lib 全家桶**（`pdf-lib` + `pako` + `@pdf-lib/standard-fonts` + `@pdf-lib/upng`） | **824 KB** | **≈63%** |
| 本项目 `src/` | 333 KB | 25% |
| `zotero-plugin-toolkit` | 119 KB | 9% |
| `tslib` | 4 KB | <1% |

> 结论：**超过一半的打包体积只服务于「读取 PDF 页数」这一件事。**

---

## 1. 依赖清单

### 1.1 运行时依赖（`package.json` → `dependencies`，仅 2 个）

| 依赖 | 版本 | 实际用途 | 可替换性 |
|---|---|---|---|
| `pdf-lib` | `^1.17.1` | **仅** `src/modules/pdfPageCount.ts` 的 `getPdfPageCount()` 数页数 | 高 |
| `zotero-plugin-toolkit` | `^5.1.0-beta.13` | `log` / `Clipboard` / `getGlobal` / `unregisterAll` / 少量类型 | 高 |

`pdf-lib` 传递依赖：`@pdf-lib/standard-fonts`、`@pdf-lib/upng`、`pako`、`tslib`。

### 1.2 开发依赖（11 个）

`@types/chai`、`@types/mocha`、`@types/node`、`@zotero-plugin/eslint-config`、`chai`、`eslint`、`mocha`、`prettier`、`typescript`、`zotero-plugin-scaffold`、`zotero-types`。

### 1.3 依赖卫生问题

- [ ] `node_modules` 中 `ts-morph`、`@ts-morph/common`、`code-block-writer`、`path-browserify` 为 **extraneous**（不在 `package.json` 中），需 `npm ci` 重装清理。
- [ ] `tsconfig.tsbuildinfo`（约 100 KB）已被 `.gitignore` 忽略，但工作区存在；无需处理，仅记录。
- [ ] `pdf-lib` / `zotero-plugin-toolkit` 会被 esbuild 打进 XPI，语义上可从 `dependencies` 移到 `devDependencies`（非必需，视发布流程而定）。

---

## 2. 简化项总览（按收益排序）

| 编号 | 项目 | 预估收益 | 风险 | 依赖决策 |
|---|---|---|---|---|
| **A** | 移除/替换 `pdf-lib` | 体积 −约 63% | 中 | 需确认 Zotero 页数 API |
| **B** | 精简/移除 `zotero-plugin-toolkit` | 体积 −9%（119 KB） | 低-中 | 否 |
| **C** | 删除死代码 | 维护性；体积少量 | 低 | 否 |
| **D** | 功能/结构合并 | 行数与维护面大幅下降 | 高 | 需产品取舍 |
| **E** | 依赖与工程卫生 | 安装体积、清晰度 | 低 | 否 |

---

## 3. 详细实施项

### A. 移除或替换 `pdf-lib`（最高优先）

**结论：可以删。** 页数只服务两处，且插件在页数未知时**已经**能降级为整篇解析。但如果要保留「按页分块」能力，就必须找到替代页数来源；MinerU V1 API 目前**不暴露页数**。

**调用点（全仓仅 2 处，均通过 `src/modules/pdfPageCount.ts`）**

- `src/hooks.ts:76` —— 自动解析的页数上限判断（pref `autoParsePageLimit` 默认 `0`，即关闭）；
- `src/modules/parseManager.ts:520-524` —— 决定分页 chunk 数（`CHUNK_PAGE_LIMIT = 200`）。
- `src/modules/pdfPageCount.ts` 是 `pdf-lib` 的唯一引用点，失败时返回 `-1`，**不参与** PDF 切分（V1 API 用 `page_range`）。

#### A.1 已核实事实 —— MinerU（`/home/ding/GitHub/MinerU`）

- `page_range` 语义（`docs/next/page-ranges.md`）：支持 `1-10`、`1,3,5-7`、`r5-r1`、`all`、缺省=全部；有效页取**与文档页数的交集**（10 页文档 `8-15` → `8-10`），只有整个表达式为空时（10 页文档 `20`）才报 `page_range_invalid`。
  - ⇒ `page_range: "1-{limit}"` **永远合法且会被自动裁剪**，可用于替代「先数页数再判断」。
- `POST /v1/parse/jobs` 的 `files[].page_range` 省略/`null` = 解析整篇（`docs/next/api/parse-jobs.md`）。
- 终态响应的 `page_range` 会被规范化为 `1-{total}`，但**发生在解析之后**，不能用于提交前决策。
- V1 API **没有任何返回页数的字段**：`FileObjectModel` = `id/object/bytes/created_at/expires_at/filename/purpose/sha256sum`；`GET /v1/health` 只含 `webhook/output_formats/sources`。`max_pages_per_file = 1000` 只出现在 `GET /v1/usage` 的 limits 中（`mineru/parser/api_server.py:594`）。
- 本地 server **解析路径不强制 1000 页上限**：它把 `page_range` 直接传给 `parse_async`（`api_server.py:1440-1500`），后端自行按窗口切分（`window_size` 默认 64，`mineru/backend/analysis/pdf/window.py:71`）。⇒ 整篇解析大 PDF 是后端支持的。
- 仓库 NEXT 文档写「单文件页数 1000」（`docs/next/api/usage-limits.md`），但**生产官方 server 实际限制为 200 页**（用户确认）。插件的 `CHUNK_PAGE_LIMIT = 200` 正是对齐该生产限制。⇒ **必须保留按页分块，页数是刚需。**

#### A.2 已核实事实 —— Zotero（`/tmp/zotapp` + `zotero-types`）

- **没有** `Zotero.PDFWorker.getPageCount`。worker 动作仅有：`writeAnnotations`、`importAnnotations`、`importMendeleyAnnotations`、`importCitaviAnnotations`、`deletePages`、`rotatePages`、`getFulltext`、`getRecognizerData`、`getStructuredDocumentText`、`renderAnnotations`、`renderArea`、`hasAnnotations`（`/tmp/zotapp/resource/document-worker/worker.js`）。
- **打开的 reader 有页数**：`reader._state.primaryViewStats.pagesCount`，或 `reader._primaryView._iframeWindow.PDFViewerApplication.pagesCount`（`zotero-types/types/reader/...`；`/tmp/zotapp/resource/reader/reader.js:44604` `let pagesCount = pdfDocument.numPages`）。仅当 PDF 已在 reader 中打开时可用。
- Zotero 自带 pdf.js：`resource://zotero/reader/pdf/build/pdf.mjs`（导出 `getDocument`、`PDFWorker`），可用 `ChromeUtils.importESModule` 引入，**可替代 pdf-lib 且不新增依赖**，但与 Zotero 内置 pdf.js 版本耦合。

#### A.3 关键事实 —— 插件当前已能「无页数」运行

- `pdfPageCount.ts` 失败返回 `-1`。
- `parseManager.ts:524` `chunks = Math.max(1, Math.ceil(-1 / 200)) = 1`。
- 单 chunk 分支调用 `client.submitPdf(filePath)`，**不传 `page_range`**（`v1.ts:284-290` 仅在提供 `pageRange` 时才设置 `fileEntry.page_range`）。
- `createTaskResume` 会算出 `endPage = -1`，但该字段在单 chunk 分支不参与提交。

⇒ **页数未知时插件自动退化为整篇解析，无需任何新增代码。**

#### A.4 方案决策矩阵

| 方案 | 新增依赖 | 保留分块 | 支持 >200 页（生产限制） | 备注 |
|---|---|---|---|---|
| 1. 直接删 pdf-lib，走整篇解析 | 无 | 否 | 否（官方 200 页会被拒） | 不满足生产需求 |
| **2a. 换用 Zotero 自带 pdf.js（已选）** | 无（用内置资源） | 是 | 是 | 与 Zotero 版本耦合，需探测+兜底 |
| 2b. 用打开 reader 的 `pagesCount` | 无 | 部分是 | 部分是 | 仅覆盖已打开 reader，不覆盖后台/右键 |
| 2c. 极简 `/Count` 解析 | 无 | 是 | 是 | 压缩 xref 需 fallback，实现量大 |
| 3. 让服务端在 File/job 响应里加 `page_count` | 服务端改动 | 是 | 是 | 需改 MinerU，不在本仓库 |
| 4. 保留 pdf-lib | — | 是 | 是 | 接受体积 |

**决策：采用 2a。** 理由：官方生产限制 200 页 ⇒ 分块不可移除 ⇒ 必须有页数；而 Zotero 已内置 pdf.js，用它替代 `pdf-lib` 既不新增依赖，又能删掉约 800 KB 打包体积。

#### A.5 实施方案（2a）：用 Zotero 内置 pdf.js 替代 pdf-lib

**目标文件**：`src/modules/pdfPageCount.ts`（保持 `getPdfPageCount(filePath): Promise<number>` 签名与**失败返回 `-1`** 契约）。

**实现要点**

> ⚠️ **关键：不能用 `ChromeUtils.importESModule`。** Zotero 10 / Gecko 140 的系统模块 realm 内置对象被冻结，pdf.js 顶层 `Map.prototype.getOrInsertComputed = …` polyfill 会抛 `TypeError: Map.prototype is not extensible`。实测（Run JavaScript，主窗口 realm）：窗口 realm `Object.isExtensible(Map.prototype) === true`，`ChromeUtils.importESModule` 失败，而**窗口 realm 动态 `import()` 可用**。Zotero reader 本身也是用 `<script type="module">` 在内容 realm 加载 pdf.js。

- [ ] 在主窗口 realm 中用**动态 `import()`** 加载 pdf.js：通过 `Zotero.getMainWindow().eval(...)` 执行（与 Run JavaScript 机制一致）。
- [ ] 在窗口 realm 内设置 `GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs"`。
- [ ] 在窗口 realm 内用 `IOUtils.read()` 读字节，`getDocument({ data: bytes, isEvalSupported: false }).promise` 取 `numPages`，最后 `destroy()`；把路径作为字符串传入，避免跨 realm 传递 `Uint8Array`。
- [ ] 资源路径需**运行时探测**：不同 Zotero 版本路径可能变化；主窗口缺失、eval 被拒或 worker 创建失败时回退 `-1`。
- [ ] 对加密/损坏 PDF、超大文件设置超时与 try/catch，确保任何异常都返回 `-1`，不阻断整篇解析降级路径。
- [ ] 删除 `pdf-lib` 依赖与 import；移除 `pdfPageCount.ts` 中的 `PDFDocument`。

**验证**

已核实环境：Zotero **10.0.1**（Gecko 140），`app/omni.ja` 内确实存在 `resource/reader/pdf/build/pdf.mjs` 与 `pdf.worker.mjs`，故 `resource://zotero/reader/pdf/build/pdf.mjs` 路径在当前目标版本有效（`application.ini` 的 `Version=10.0.1`）。

最快的手动验证：Zotero → Tools → Developer → Run JavaScript（该窗口用 `win.eval`，本身就在窗口 realm，可直接 `await`/`return`）：

```js
const pdfjs = await import("resource://zotero/reader/pdf/build/pdf.mjs");
pdfjs.GlobalWorkerOptions.workerSrc =
  "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const bytes = await IOUtils.read("/path/to/sample.pdf");
const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
const doc = await task.promise;
const pages = doc.numPages;
await task.destroy();
return pages;
```

这组代码与插件的 `Zotero.getMainWindow().eval(...)` 路径等价；返回的页数应与 pdf-lib / pdfinfo 一致。

- [ ] `npm run build`：XPI / JS 体积应减少约 800 KB（移除 pdf-lib 后对照第 0 节基线；spike 阶段仍保留 pdf-lib，体积不变）。
- [ ] `npm test`：`parseManager.test.ts` 注入 `getPdfPageCount`，确认 `-1` 与正常页数两条路径均覆盖。
- [ ] 手工验证：<=200 页整篇、>200 页分块、加密/损坏 PDF 降级、Zotero 重启后续传。
- [ ] 看日志区分路径：`MinerU page count source=pdfjs pages=N` 表示内置 pdf.js 生效；出现 `source=pdf-lib` 或 `Failed to get pdf page count via Zotero pdf.js` 则说明 pdf.js 路径在该环境失败（需转方案 2b）。

**风险与回退**：内置 pdf.js 路径/worker 行为随 Zotero 版本变化；保持 `-1` 兜底即可回到「整篇解析」安全路径。若某版本完全不可用，可临时把 `pdf-lib` 作为动态 fallback 或改用方案 2b。

**实施结果（`spike/zotero-pdfjs-page-count` 分支实测）**

- JS bundle：`1,324,785` → `465,127` bytes（**−859,658 B，约 −65%**）。
- XPI：`344 KB` → `132 KB`（约 −62%）。
- `pdf-lib` 已从 `package.json`、`package-lock.json` 及 bundle 中完全移除（bundle 内 `pdf-lib`/`PDFDocument` 引用均为 0）。
- 已通过：`tsc --noEmit`、`tsc -p test/tsconfig.json --noEmit`、`prettier`、`eslint`、`npm run build`。
- 待插件内最终确认：实际解析时日志出现 `source=pdfjs`；>200 页 PDF 正常按 `page_range` 分块。

---

### B. 精简或移除 `zotero-plugin-toolkit`

**实际使用点（全量）**

| API | 位置 |
|---|---|
| `ztoolkit.log` | 33 处（`taskStore.ts`、`agentSync.ts`、`parseManager.ts` 等） |
| `ztoolkit.Clipboard()` | `src/modules/readerOverlay/copy.ts:46`、`:70` |
| `ztoolkit.getGlobal("Localization")` | `src/utils/locale.ts:12` |
| `ztoolkit.unregisterAll()` | `src/hooks.ts:140`、`:160` |
| `ztoolkit.ProgressWindow.setIconURI` | `src/utils/ztoolkit.ts:28`（**无 ProgressWindow 实例，疑似遗留**） |
| 类型 `ColumnOptions` / `DialogHelper` | `src/addon.ts:2`（仅类型） |
| `BasicTool` / `ZoteroToolkit` / `UITool` / `unregister` | `src/index.ts:1`、`src/utils/ztoolkit.ts` |

**问题**

- 当前 `new ZoteroToolkit()` 引入**整包**；`src/utils/ztoolkit.ts:34-46` 的 `MyToolkit` 类**从未被实例化**（死代码），却使其 `BasicTool`/`UITool`/`unregister` import 被保留。

**实施清单**

- [ ] 删除 `src/utils/ztoolkit.ts` 中的 `MyToolkit` 类及其独占 import。
- [ ] 只引入实际使用的 tool 子模块（或改用 `MyToolkit` 白名单模式），替换 `new ZoteroToolkit()`。
- [ ] 评估完全移除 toolkit：
  - `log` → `Zotero.debug` 封装（`src/` 中禁止 `console.*`，遵循 AGENTS 约定）；
  - `Clipboard` → `Zotero.Utilities.Internal.copyTextToClipboard` 等；
  - `getGlobal` → 直接访问 `globalThis`/`Localization`；
  - `unregisterAll` → 确认是否真有注册项（当前 `ztoolkit.UI` 仅出现在 `basicOptions`）。
- [ ] 若 `ProgressWindow.setIconURI` 确认为遗留，连同调用一起删除。
- [ ] 回归验证：剪贴板复制、locale 初始化、启动/卸载钩子、日志输出。
- [ ] `npm run lint:check` + `npm test`。

---

### C. 删除死代码（低风险）

#### C1. `src/modules/parseProgress.ts`（230 行）

仅 `createProgressWindowTexts()`（`src/modules/parseManager.ts:1179` 使用）与 `normalizeProgressWindowText()` 为运行时活跃；以下函数**只被 `parseManager` 再导出 + 测试引用，生产路径无人调用**：

- `applyProgressWindowItemIcon`
- `applyProgressWindowDescriptionLineLayout`
- `scheduleProgressWindowPresentation`
- `findNextProgressWindowDetailRow`
- `styleProgressWindowDetailRow`
- `getProgressWindowItemParent`
- `createProgressWindowDetailLines`
- `createProgressWindowDisplayText`
- `createProgressWindowLineOptions`
- 关联常量：`PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX`、`PROGRESS_WINDOW_DETAIL_LEFT_OFFSET_PX`、`ELEMENT_NODE_TYPE`、`PROGRESS_WINDOW_PRESENTATION_RETRY_DELAYS_MS`（如无其它引用）

- [ ] 在 `parseManager.ts` 的 re-export 块中移除对应条目。
- [ ] 删除 `parseProgress.ts` 中上述函数与常量。
- [ ] 同步裁剪 `test/parseManager.test.ts` 中对它们的测试。
- [ ] 保留并验证 `createProgressWindowTexts` 的失败消息文本行为。

#### C2. `mineruClient` 未引用导出

- [ ] `src/modules/mineruClient/http.ts`：`createFormDataRequest`、`xhrFetch`（仅文件内定义，无外部引用）。
- [ ] `src/modules/mineruClient/path.ts`：`safeURL`。
- [ ] `src/modules/mineruClient/zip.ts`：`textMapToZipEntries`。
- [ ] `src/modules/mineruClient/index.ts`：核对 barrel 中是否有多余 re-export（`downloadPlainFileBytes`、`createV1MinerUClient` 等）。

> 注意：`fallbackDownloadBinary`、`fetchUploadBinary`、`fetchDownloadBinary`、`xhrUploadBinary`、`xhrDownloadBinary` **仍被 `v1.ts` 使用**，不可删。

#### C3. Windows-only curl 下载路径

- [ ] 评估 `src/modules/mineruClient/download.ts` 中 `downloadWithCurl`（:60）、`downloadWithNsIProcess`（:135）、`findCurlPath`（:180）约 100 行的必要性。当前非 Windows 走 `Zotero.File.download`，curl 仅是 Windows 优化；若可接受 `Zotero.File.download`，可整体移除 `Subprocess`/`nsIProcess` 复杂度。

#### C4. 遗留迁移

- [ ] `src/modules/parseResume.ts:120` `cleanupLegacyChunkCacheFiles`（`src/modules/parseManager.ts:551` 调用）：确认是否还需保留旧 chunk 缓存迁移，不需要则可删。

---

### D. 功能 / 结构合并（高风险，需产品决策）

`src/` 行数分布：

| 子系统 | 行数 |
|---|---|
| `readerOverlay/` | 3,616 |
| `parse*`（编排/合并/网络/进度/续传） | 2,150 |
| `mineruClient/` | 2,037 |
| `markdownQuery/` | 1,781 |
| `readerToolbar/` | 1,382 |
| `storage.ts` + `storageFs.ts` | 952 |
| `preferenceScript.ts` | 727 |
| `addon/content/*.html`（Task/Results 管理器 + 首选项） | 1,724 |

- [ ] **Task Manager 与 Results Manager 合并**：`taskStore.ts`/`taskManager.html` 与 `resultsManager.ts`/`resultsManager.html` 为两套独立窗口，评估合并为单窗口多标签。
- [ ] **`markdownQuery/` + `mineru-for-zotero-cli/`**（1.8k 行）为可选子系统，评估拆分独立插件或按需构建开关。
- [ ] **`agentSync.ts`**（313 行）可选功能，评估是否默认关闭/独立模块。
- [ ] 测试规模（13,346 行）接近源码，先随 C 项删除死代码测试，再评估进一步瘦身。

---

### E. 依赖与工程卫生（低风险）

- [ ] 清理 extraneous 包：删除 `node_modules` 后 `npm ci`，确认 232 包下降。
- [ ] （可选）将 `pdf-lib` / `zotero-plugin-toolkit` 迁到 `devDependencies`（它们被打包进 XPI）。
- [ ] 校验 `package-lock.json` 与 `package.json` 一致（`npm ci` 应无 extraneous 警告）。

---

## 4. 建议实施顺序

1. **C（死代码清理）** —— 零/低风险，先降低后续改动噪声与测试负担。
2. **E（依赖卫生）** —— 低风险，独立于功能。
3. **B（toolkit 精简）** —— 中等收益、低-中风险。
4. **A（pdf-lib 替换）** —— 需先做技术验证，收益最大。
5. **D（结构合并）** —— 需要产品决策，最后进行。

---

## 5. 每项的通用验证步骤

```bash
# 类型检查 + 生产构建
npm run build

# 格式与 lint（CI 门禁）
npm run lint:check

# 测试（本地 Linux 需提供 Zotero 二进制路径）
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=<extracted>/zotero npm test --exit-on-finish

# 测试类型检查（无法跑测试时）
npx tsc -p test/tsconfig.json --noEmit

# 体积回归
ls -la .scaffold/build/mineru-for-zotero.xpi
unzip -l .scaffold/build/mineru-for-zotero.xpi | grep scripts
```

**验收标准（每项完成后）**

- [ ] `npm run build` 通过（`tsc --noEmit` 无错误）。
- [ ] `npm run lint:check` 通过。
- [ ] `npm test` 全绿；死代码删除项需同步更新对应测试。
- [ ] 体积变化记录到本文档「基线数据」小节。
- [ ] 遵循 Conventional Commits 提交，PR 描述含测试结果。

---

## 6. 待确认的开放问题

1. ~~Zotero 9/10 是否有稳定的内置「PDF 页数」接口？~~ **已核实（见 A.2）**：无 `PDFWorker.getPageCount`；仅打开 reader 时有 `pagesCount`，另可 `importESModule` 内置 pdf.js。剩余决策：是否保留分块。
2. ~~官方云是否严格执行「1000 页/文件」上限？~~ **已确认：生产官方 server 限制 200 页**（与 `CHUNK_PAGE_LIMIT` 一致），必须保留分块。剩余待办：内置 pdf.js 资源路径与 worker 行为在目标 Zotero 版本上的实测。
2. `ztoolkit.ProgressWindow.setIconURI` 是否真有对应窗口？若无，是否随 B 删除？
3. `ztoolkit.unregisterAll()` 是否注册过实际 UI？无注册项则可安全移除。
4. Task Manager / Results Manager 是否有用户依赖「两个独立窗口」？
5. `markdownQuery` HTTP API 与 CLI 是否为必须随主插件发布的能力？
