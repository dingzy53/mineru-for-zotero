# PLAN: fix what agents ran into when reading parsed papers

> Branch `fix/agent-usage-findings`. Written 2026-11-14. Steps 1 to 6 are implemented, one commit each (`dd6b016`, `691888d`, `95325fd`, `236a6b6`, `c450848`, `53bf371`).
>
> Still open, all by hand in the owner's Zotero: step 1.1 (replace the installed 0.10.2 plugin), `npm run skill:install` (add `--allow-model-invocation` for the step 2 decision), deleting the two `mineru-part-53-*.json` files, and the checks under Verification. The scaffold suite (`zotero-plugin test`) was not run for these commits because no Zotero binary was available; the changed test files were run with standalone Mocha and `node --test`.
>
> One deviation: `parse --wait` is bounded by its own `--wait-timeout-ms` (default 15 minutes) instead of `--timeout-ms`, which stays the per-request timeout.
>
> This replaces the "Open Task Manager from the Tools menu" plan, which shipped in `65c9a80` (see git history for its text).

## Where this comes from

I read every Claude Code transcript under `~/.claude/projects` that touched this plugin's output (2026-10-31 to 2026-11-10): the `mineru-for-zotero-cli` skill, the local query API, and direct reads of the result folders. I then compared the installed plugin and skill copies with this repo and read the agent-facing code (`mineru-for-zotero-cli/`, `src/modules/markdownQuery/`).

| How agents reached parsed papers                                              | Sessions | Calls |
| ----------------------------------------------------------------------------- | -------: | ----: |
| The CLI (`query-markdown.mjs`), after the user typed `/mineru-for-zotero-cli` |        2 |    13 |
| Reading `~/Zotero/mineru-copy/` and `~/Zotero/MinerU-Sync/` directly          |        2 |    75 |

The parsing itself held up: 85 of 87 UGRP items and 21 of 23 SSCU3622 items had usable Markdown, and no session reported a failed or corrupt parse. The problems are all in how agents find and reach the results.

## Findings

### 1. Everything installed is older than this repo

| Copy                                       | Installed       | Repo    |
| ------------------------------------------ | --------------- | ------- |
| Plugin in the everyday Zotero              | 0.10.2 (old ID) | 0.11.0  |
| `~/.claude/skills/mineru-for-zotero-cli`   | from 2026-10-01 | differs |
| `~/.pi/agent/skills/mineru-for-zotero-cli` | from 2026-08/09 | differs |

- **Plugin:** `7693f95` changed the addon ID to `mineru-for-zotero@dingzy53.github.io`. The installed 0.10.2 still has the old ID (`…@asianfleet.github.io`), and `update.json` now lists only the new ID. The installed copy will never update by itself. A stale `mineru-for-zotero.xpi` (0.9.8) also sits in the profile's `extensions/` folder.
- **Skill:** the copies are hand-copied and have drifted. A visible symptom: `search --creator …` printed `Title: undefined` in the 10-31 session, which the repo's CLI no longer does. The installed CLI also lacks `libraries`, `collections`, `tags`, `--has-pdf`, `--parsed-only` and the documented exit codes.
- Nothing tells the user or the agent that the CLI and the plugin don't match.

### 2. Agents don't discover the skill, so they read the result folders

- Both installed `SKILL.md` copies carry `disable-model-invocation: true` (the repo's copy doesn't). An agent can't load the skill unless the user types the slash command. On 10-31 an agent answered "my attempt to invoke it was blocked" and read nothing until the user pointed at the folder.
- In the two biggest reading sessions (11-07 with 23 papers and subagents, 11-10 with 87 items) the user said "the papers are parsed in Zotero". The agents never used the CLI. They listed `~/Zotero/mineru-copy/attachments/1-<KEY>/content.md`, built their own item → attachment → file map (one from a copy of `zotero.sqlite`, one from Zotero's local API), and read the files.
- That worked, but it skips attachment selection, section reading and `locate`, depends on the internal folder layout, and one session copied the SQLite database to do the mapping.
- The README's "direct your Agent to read `SKILL.md`" step is the only install instruction.

### 3. No batch view: "which papers in this collection are parsed?"

- Both sessions needed this first. The repo's `search --collection X --parsed-only` gets close, but the installed CLI doesn't have it, and the output has no per-collection summary (parsed, not parsed, no PDF) or path to `content.md`.

### 4. The API can start a parse and list tasks, but the CLI can't

- `POST /mineru-for-zotero/parse` and `GET /mineru-for-zotero/tasks` exist (`apiEndpoint.ts`). The CLI has no `parse` or `tasks` command, and `SKILL.md` says the CLI "does not parse PDFs".
- On 11-08 the agent attached new PDFs and could only tell the user "let MinerU parse them if it does that automatically". Two items in the 11-07 session had no parse and fell back to `pdftotext`.
- `triggerParse()` always passes `force: true`, so a parse request for an already-parsed PDF re-parses it and spends MinerU quota.

### 5. Inline HTML in the Markdown

- MinerU writes `<sub>`/`<sup>` tags. In three commands agents piped the CLI through `sed` to strip them before reading or grepping.
- `locate` and `search` are literal substring matches, so a query that spans a `<sub>` tag or a line break in the PDF finds nothing.

### 6. Leftovers in the Zotero data directory

- `~/Zotero/mineru-part-53-0-result.json` and `…-53-2-result.json` (90 MB together, 2026-08-14) are chunk caches from before they moved under `mineru-resume/`.
- `~/Zotero/mineru-resume/` holds empty folders for attachments 186, 230 and 342 from September. `cleanupTaskResume()` doesn't cover tasks that no longer exist.

## Steps

Ordered by value. Each step is one commit with its tests.

### Step 1: get the current build and skill installed, and keep them in sync

1. Owner, by hand (README already describes it): remove the 0.10.2 plugin in **Tools → Plugins**, delete the stray `mineru-for-zotero.xpi` from the profile's `extensions/` folder, install 0.11.0 or the release from this branch. Settings and results carry over because the pref prefix and folders didn't change.
2. Add `scripts/install-skill.mjs` and `npm run skill:install`: copy `mineru-for-zotero-cli/` to each existing agent skill folder (`~/.claude/skills`, `~/.pi/agent/skills`, `~/.agents/skills`), or symlink with `--link`. It keeps a local `disable-model-invocation` line if the target has one and prints what it changed.
3. Version handshake: every API response envelope gains `pluginVersion` and `apiVersion` (an integer bumped on breaking changes). The CLI carries its own `API_VERSION` and prints a one-line warning to stderr when they differ ("this CLI is older than the plugin; run npm run skill:install").
4. README: replace the "direct your Agent to read SKILL.md" paragraph with the install command and a note on updating after each plugin update.
5. Tests: `test/queryMarkdownCli.test.mjs` for the mismatch warning; `test/markdownApiEndpoint.test.ts` for the envelope fields.

### Step 2: make the skill discoverable (decision for the owner)

- `disable-model-invocation: true` is a local edit, so it may be deliberate. It is also the direct cause of finding 2.
- Recommended: remove it in the installed copies (the CLI is read-only apart from `parse`, and `parse` gets a guard in step 4). Then tighten the `description` in `SKILL.md` so it triggers on the words users actually wrote: "parsed in Zotero", "read the paper in my Zotero collection", "MinerU".
- Add a short "don't read `mineru-copy/` directly" note to `SKILL.md` with the reason (attachment selection, sections, page lookup).

### Step 3: a collection-level status command (finding 3)

1. API: `GET /mineru-for-zotero/status?libraryID=…&collection=…&includeSubcollections=…` → for each regular item: key, title, year, first creator, each PDF attachment's key, parse state (`precise`, `lite`, `none`, `running`, `failed`) and word count, plus totals. Reuse `searchItems` and `storage` from `queryService.ts`; no new Zotero queries beyond what `search` does.
2. CLI: `status --library-id 1 --collection "UGRP" [--include-subcollections]`, text output as one line per item, grouped as parsed / not parsed / no PDF.
3. `markdown --granularity full --output <file>` to write the Markdown to a file instead of stdout, so subagents can be handed a path without knowing the storage layout.
4. Tests in `markdownQueryService.test.ts`, `markdownApiEndpoint.test.ts` and the CLI test.

### Step 4: `parse` and `tasks` in the CLI (finding 4)

1. `triggerParse()`: default to **not** forcing. If a ready result exists for the current PDF mtime, return `{ status: "already-parsed" }`. Accept `force=true` explicitly. Keep it non-interactive either way (no modal prompt).
2. CLI: `parse --library-id 1 --key K [--attachment-key A] [--force]` and `tasks` (id, title, status, progress, error). Add `parse --wait` that polls `tasks` until the task ends or `--timeout-ms` passes.
3. `SKILL.md`: a "PDF has no parse result yet" workflow, with a warning that parsing uses the user's MinerU quota, so ask before parsing more than a few items.
4. Tests: service test for the already-parsed short-circuit; CLI tests with the stub server.

### Step 5: plain-text matching (finding 5)

1. `queryService.ts` search and `locate`: match on a normalized form (strip `<sub>`/`<sup>` and other inline tags, collapse whitespace, join hyphenated line breaks) while returning the original text. Keep literal matching as the first attempt so current results don't change.
2. CLI: `--plain` on `markdown` to strip inline HTML tags from the output.
3. Tests with a fixture paragraph containing `CO<sub>2</sub>` and a query "CO2 emissions".

### Step 6: clean up leftovers (finding 6)

1. On startup, after resume state is loaded: remove `mineru-resume/<id>` folders that are empty and have no entry in the task store. Never touch non-empty folders of unknown tasks; log them.
2. The two root-level `mineru-part-53-*.json` files predate the resume folder. Don't add code for them; the owner deletes them by hand (listed in Verification).

## Verification

- `npm run build`, `npm run lint:check`, `npx tsc -p test/tsconfig.json --noEmit` and `zotero-plugin test --exit-on-finish` pass after each step.
- After Step 1: **Tools → Plugins** shows one MinerU plugin with the new ID; `diff -r mineru-for-zotero-cli ~/.claude/skills/mineru-for-zotero-cli` shows only the optional frontmatter line; `search --creator Sukprasert` no longer prints `Title: undefined`.
- After Step 3: `status --collection UGRP --include-subcollections` matches the 85-of-87 count the 11-10 session derived by hand.
- After Step 4: attach a new PDF, run `parse --wait`, then `markdown --granularity headings` on it. Run `parse` again and get `already-parsed` without a new MinerU task.
- By hand: delete `~/Zotero/mineru-part-53-0-result.json` and `~/Zotero/mineru-part-53-2-result.json`.

## Out of scope

- An MCP server inside this plugin, like zotero-S2 has. It would solve discovery too, but it is a larger feature; revisit if step 2 isn't enough.
- Authentication for the local query API. The reasoning in `apiEndpoint.ts` (local-only, opt-in pref, no browser origins) still holds; step 4 removes the one costly unauthenticated action (forced re-parse by default).
- Parse quality. No session reported a wrong or missing parse that wasn't simply "not parsed yet".
