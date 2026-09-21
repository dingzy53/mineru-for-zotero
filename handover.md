# mineru-for-zotero 代码库重构交接文档 (Handover)

> **目标仓库路径**: `/home/ding/GitHub/mineru-for-zotero`  
> **当前状态**: ✅ **整理完成**（文档清理、死代码删除、`parseManager.ts` 拆分、`storage.ts` 拆分、`readerOverlay`/`preferenceScript` 去重均已完成并提交；代码通过 lint/build；工作区已干净）。所有改动已在本地提交，**尚未 push**。

---

## 📌 为什么仅靠 `cleanup-plan.md` 不够？

原 `cleanup-plan.md` 是上一个 Agent 在**动手前生成的静态方案**，若直接拿给新 Agent 会产生以下严重问题：

1. **未标记执行进度**：原文档没有任何“已完成”标记，新 Agent 会以为任务尚未开始，重复执行导致报错或逻辑冲突。
2. **实际落地与计划存在偏差**：
   - 原计划预计拆出 `parseExecution.ts`、`parseHelpers.ts` 等；但实际拆出的是 `parseProgress.ts`、`parseResume.ts`、`parseNetwork.ts`。
   - 上一个 session 额外删除了死代码文件（`src/modules/parseNotice.ts`、`src/utils/window.ts`），并同步更新了 `addon/prefs.js`、`typings/prefs.d.ts`、`src/utils/prefs.ts`。这些在原 `cleanup-plan.md` 中完全未被记载。
3. **缺少目标路径与环境基线**：原计划中没有仓库绝对路径，也没有说明当前的构建状态与已通过的质检门禁。

---

## 📊 当前工作进度看板

| 计划任务项                         | 状态          | 详细说明                                                                                                                                                                                                                               |
| ---------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 清理历史文档与冗余**          | ✅ **已完成** | 删除了 `docs/superpowers/`（15 个设计与规划文件）、`docs/reader-overlay-selection-debugging.md`、`plan.md`、`.github/dependabot.yml`，减少约 13,000+ 行文档。                                                                          |
| **2. 精简 AGENTS.md**              | ✅ **已完成** | 从 296 行精简至 200 行，去除过时调试记录与重复说明，保留核心架构契约。                                                                                                                                                                 |
| **3. 移除死代码 (额外完成)**       | ✅ **已完成** | 删除了未被引用的 `src/modules/parseNotice.ts` 和 `src/utils/window.ts`，同步清理了 `addon/prefs.js`、`typings/prefs.d.ts`、`src/utils/prefs.ts` 中的冗余引用。                                                                         |
| **4. 拆分 `parseManager.ts`**      | ✅ **已完成** | 抽离 `parseProgress.ts`、`parseResume.ts`、`parseNetwork.ts`；本轮继续抽离纯函数 `parseMerge.ts`（分块结果合并）与 `src/utils/concurrency.ts`（并发队列）。核心流程 `parseAttachmentWithDependencies` 保留在主文件（职责已足够清晰）。 |
| **5. 整理 `storage.ts` (949行)**   | ✅ **已完成** | 将 IOUtils/OS.File、路径与前缀工具抽离到新模块 `src/modules/storageFs.ts`，`storage.ts` 仅保留结果布局与 manifest 领域逻辑（949 → 约 650 行）。                                                                                        |
| **6. 清理 `readerOverlay` 等模块** | ✅ **已完成** | 新增 `readerOverlay/dom.ts` 统一 `hasClassName`/`isInsideClassTarget`，消除 `render.ts`、`positioning.ts` 中的重复实现；`preferenceScript.ts` 合并三个原生文件选择器脚手架，并删除未使用的 `pickDirectoryAsync`。                      |
| **7. 验证与提交**                  | ✅ **已完成** | 每个逻辑变更独立提交；`npm run lint:check` 与 `npm run build` 全部通过；storage/parseMerge/concurrency 单测通过。                                                                                                                      |

---

## ✅ 本轮提交记录 (`git log --oneline`)

全部为本地提交，**未 push**：

1. `docs: remove obsolete design and planning documents`
2. `chore: remove dependabot configuration`
3. `docs(agents): streamline repository guidelines`
4. `refactor(parse): extract progress, resume, and network helpers from parseManager`
5. `chore: remove unused exports and dead modules`
6. `fix(prefs): register pdftkPath preference`
7. `refactor(storage): extract low-level filesystem helpers into storageFs`
8. `refactor(parse): extract chunk result merging into parseMerge`
9. `refactor(parse): extract bounded concurrency runner into utils`
10. `refactor(readerOverlay): share class-name DOM helpers`
11. `chore: remove remaining dead exports`
12. `refactor(preferences): share native file picker scaffolding`
13. `fix(test): use chai assert so the browser test bundler resolves it`
14. `fix(test): restore global Zotero and Components after results manager tests`
15. `fix(resultsManager): inject window lookups and stop mutating read-only globals in tests`
16. `fix(test): isolate storage tests from persistent temp results`

新增/调整的模块：`parseMerge.ts`、`storageFs.ts`、`readerOverlay/dom.ts`、`utils/concurrency.ts`，以及对应单测 `test/parseMerge.test.ts`、`test/concurrency.test.ts`。

---

## 🧪 当前质量验证基线 (已全部通过)

在 `/home/ding/GitHub/mineru-for-zotero` 目录下验证：

```bash
# 1. 代码格式与 Lint 检查 (已通过，0 error)
npm run lint:check

# 2. 生产环境构建与主源码类型检查 (已通过，0 error)
npm run build

# 3. 测试文件类型检查 (已通过，0 error)
npx tsc -p test/tsconfig.json --noEmit

# 4. 独立脚本单元测试 (已通过，3 passed)
node --test scripts/*.test.mjs
```

---

## 📝 后续建议

- `parseAttachmentWithDependencies` 仍较长，但其内部闭包（分块提交/轮询/下载）强耦合于 `client`、`task`、`resume` 等局部状态，进一步抽离收益有限、风险较高；合并与并发这两个纯逻辑已抽离，可读性已明显改善。
- 若修改核心流程，建议继续保持“纯函数抽离优先”的策略，并为新抽离的纯函数补充 `test/*.test.ts` 单测。
- 完整 `npm test` 已在本机运行通过：在 `/tmp/zotero-test` 下载 Zotero 10 beta 后，使用 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/tmp/zotero-test/Zotero_linux-x86_64/zotero npm test -- --exit-on-finish`，全部 **373 passed / 0 failed**（19 个测试套件）。
- 为让套件真正跑绿，额外修复了 3 个测试基础设施问题：`resultsManager.test.ts` 误用 Node `assert`（改为 chai，浏览器打包可解析）、`openResultsManagerWindow` 测试污染只读全局 `Components`/`Zotero` 并劫持报告器（改为注入 `ResultsManagerWindowDependencies`）、`storage.test.ts` 跨运行复用 `TmpD` 导致的脏状态（root 目录加随机后缀）。
