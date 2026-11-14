#!/usr/bin/env node

/**
 * Install the companion agent skill (`mineru-for-zotero-cli/`) into the agent
 * skill folders that exist on this machine.
 *
 *   node scripts/install-skill.mjs            copy the skill
 *   node scripts/install-skill.mjs --link     symlink the skill to this repo
 *
 * A `disable-model-invocation` line in an installed SKILL.md is a local choice
 * (it hides the skill from the agent until the user types the slash command),
 * so a copy keeps it. Pass `--allow-model-invocation` to drop it, so agents
 * can load the skill by themselves. `--home <dir>` replaces the home
 * directory, for tests.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "mineru-for-zotero-cli";
const SKILL_FILE = "SKILL.md";
const LOCAL_LINE = /^disable-model-invocation:.*$/m;

/** Skill folders of the supported agents, relative to the home directory. */
const SKILL_ROOTS = [
  [".claude", "skills"],
  [".pi", "agent", "skills"],
  [".agents", "skills"],
];

const sourceDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  SKILL_NAME,
);

/** Parse the command line; throws on an unknown option. */
function parseArgs(argv) {
  const options = {
    link: false,
    allowModelInvocation: false,
    home: homedir(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--link") {
      options.link = true;
    } else if (arg === "--allow-model-invocation") {
      options.allowModelInvocation = true;
    } else if (arg === "--home" && argv[index + 1]) {
      options.home = resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
  }
  return options;
}

/** Relative paths of every file under a directory, sorted. */
function listFiles(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory()
        ? listFiles(path, base)
        : [relative(base, path)];
    })
    .sort();
}

/** Whether a path exists, without following a symlink. */
function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The local `disable-model-invocation` line of an installed skill, if any. */
function readLocalLine(targetDir) {
  try {
    const text = readFileSync(join(targetDir, SKILL_FILE), "utf8");
    return LOCAL_LINE.exec(text)?.[0];
  } catch {
    return undefined;
  }
}

/** Insert a line at the end of the SKILL.md frontmatter. */
function withFrontmatterLine(text, line) {
  if (LOCAL_LINE.test(text)) {
    return text;
  }
  const end = text.indexOf("\n---", 3);
  if (!text.startsWith("---") || end === -1) {
    return text;
  }
  return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
}

/** Copy the skill into `targetDir`; returns one line per change. */
function copySkill(targetDir, allowModelInvocation) {
  const changes = [];
  if (pathExists(targetDir) && lstatSync(targetDir).isSymbolicLink()) {
    rmSync(targetDir);
    changes.push("replaced the symlink with a copy");
  }
  const installedLine = readLocalLine(targetDir);
  const localLine = allowModelInvocation ? undefined : installedLine;
  const sourceFiles = listFiles(sourceDir);

  for (const file of sourceFiles) {
    let content = readFileSync(join(sourceDir, file));
    if (file === SKILL_FILE && localLine) {
      content = Buffer.from(
        withFrontmatterLine(content.toString("utf8"), localLine),
      );
    }
    const target = join(targetDir, file);
    const existed = existsSync(target);
    if (existed && readFileSync(target).equals(content)) {
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    changes.push(`${existed ? "updated" : "added"} ${file}`);
  }

  for (const file of listFiles(targetDir)) {
    if (!sourceFiles.includes(file)) {
      rmSync(join(targetDir, file));
      changes.push(`removed ${file}`);
    }
  }
  if (localLine && changes.length > 0) {
    changes.push(`kept local "${localLine}"`);
  }
  if (installedLine && !localLine) {
    changes.push(`dropped local "${installedLine}"`);
  }
  return changes;
}

/** Point `targetDir` at the skill in this repository. */
function linkSkill(targetDir) {
  const changes = [];
  if (pathExists(targetDir)) {
    if (
      lstatSync(targetDir).isSymbolicLink() &&
      realpathSync(targetDir) === realpathSync(sourceDir)
    ) {
      return changes;
    }
    const localLine = readLocalLine(targetDir);
    rmSync(targetDir, { recursive: true, force: true });
    if (localLine) {
      changes.push(
        `dropped local "${localLine}" (a symlink cannot keep local edits)`,
      );
    }
  }
  symlinkSync(sourceDir, targetDir, "dir");
  changes.push(`linked to ${sourceDir}`);
  return changes;
}

function main(argv) {
  const options = parseArgs(argv);
  const roots = SKILL_ROOTS.map((parts) => join(options.home, ...parts)).filter(
    (root) => existsSync(root),
  );
  if (roots.length === 0) {
    console.log(
      `No agent skill folder found under ${options.home} (looked for ${SKILL_ROOTS.map(
        (parts) => parts.join("/"),
      ).join(", ")}).`,
    );
    return;
  }

  for (const root of roots) {
    const targetDir = join(root, SKILL_NAME);
    if (
      existsSync(targetDir) &&
      !lstatSync(targetDir).isSymbolicLink() &&
      realpathSync(targetDir) === realpathSync(sourceDir)
    ) {
      console.log(`${targetDir}: is this repository's copy, skipped`);
      continue;
    }
    const changes = options.link
      ? linkSkill(targetDir)
      : copySkill(targetDir, options.allowModelInvocation);
    console.log(`${targetDir}:`);
    for (const change of changes.length > 0 ? changes : ["up to date"]) {
      console.log(`  ${change}`);
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
