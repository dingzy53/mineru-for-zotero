# Move "Open Task Manager" to the Zotero Tools menu

## Context

The Task Manager is only reachable through a button in the plugin's Settings pane, which is buried. Zotero 8+ (and so 9/10) provides `Zotero.MenuManager.registerMenu` with a `main/menubar/tools` target (per https://www.zotero.org/support/dev/zotero_8_for_developers), so the entry can live in **Tools → MinerU Task Manager** and be removed from Settings. Separately, AGENTS.md must pin all pushes/PRs to the fork `git@github.com:dingzy53/mineru-for-zotero.git` (upstream author is Asianfleet; never push or PR there).

## Steps

1. `git checkout -b feat/tools-menu-task-manager` (from clean `main`).
2. Write `PLAN.md` at repo root (copy of this plan, for the branch).
3. **New menu registration** — `src/modules/itemMenu.ts` (reuse its `MenuRegistration`/`MenuManager` types and `getMenuManager()`; widen `target` to `"main/library/item" | "main/menubar/tools"` and make `onShowing` optional):
   - Add `TASK_MANAGER_MENU_ID = \`${config.addonRef}-open-task-manager\``.
   - `createTaskManagerMenuRegistration(deps = { openTaskManagerWindow })` → `{ menuID, pluginID: config.addonID, target: "main/menubar/tools", menus: [{ menuType: "menuitem", l10nID: getLocaleID("tools-open-task-manager-menuitem"), icon: mineru.svg, onCommand: () => deps.openTaskManagerWindow() }] }`, with `openTaskManagerWindow` imported from `./taskStore`.
   - `registerToolsMenu(menuManager = getMenuManager())`.
   - Call it from `src/hooks.ts` `onMainWindowLoad` beside `registerItemMenu()` (same pattern; MenuManager auto-unregisters on plugin disable by `pluginID`).
4. **Locale** — `addon/locale/en-US/mainWindow.ftl`: add
   ```
   tools-open-task-manager-menuitem =
       .label = MinerU Task Manager
   ```
   Remove `pref-open-task-manager` from `preferences.ftl`.
5. **Remove settings button** — delete the `<hbox>` with `__addonRef__-open-task-manager` in `addon/content/preferences.xhtml` and its click handler in `src/modules/preferenceScript.ts` (~L62-69).
6. **Tests** — `test/itemMenu.test.ts`: add cases that `createTaskManagerMenuRegistration` targets `main/menubar/tools`, uses the prefixed l10n ID, and `onCommand` calls the injected `openTaskManagerWindow` stub (no real window).
7. **AGENTS.md** — update "Commit & Pull Request Guidelines" with a rule: push only to `origin` = `git@github.com:dingzy53/mineru-for-zotero.git`; never push to, open PRs against, or add as a push remote the original upstream (Asianfleet) repo; `gh pr create` must target `--repo dingzy53/mineru-for-zotero`. Also mention the Tools-menu entry in the Item Context Menu / module overview where `itemMenu.ts` is described, and remove any mention of the settings button.
8. `npm run build` (regenerates `typings/i10n.d.ts`), `npm run lint:check`, `npx tsc -p test/tsconfig.json --noEmit`; commit (Conventional: `feat(menu): open Task Manager from Tools menu`). Push to origin only if the user asks.

## Verification

- Build + lint + test typecheck pass; run `zotero-plugin test --exit-on-finish` if a Zotero binary is available.
- `npm start`: Tools menu shows "MinerU Task Manager" with icon and opens/focuses the Task Manager; Settings pane no longer has the button; no raw `mineruForZotero-…` ids.
