import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, "install-skill.mjs");
const sourceDir = join(scriptsDir, "..", "mineru-for-zotero-cli");

/** Run the installer against a temporary home directory. */
function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), "skill-home-"));
  try {
    run(home, (...args) =>
      execFileSync(process.execPath, [script, "--home", home, ...args], {
        encoding: "utf8",
      }),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("copies the skill into existing skill folders only", () => {
  withHome((home, install) => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });

    const output = install();
    const target = join(home, ".claude", "skills", "mineru-for-zotero-cli");

    assert.match(output, /added SKILL\.md/);
    assert.equal(
      readFileSync(join(target, "SKILL.md"), "utf8"),
      readFileSync(join(sourceDir, "SKILL.md"), "utf8"),
    );
    assert.equal(
      readFileSync(join(target, "scripts", "query-markdown.mjs"), "utf8"),
      readFileSync(join(sourceDir, "scripts", "query-markdown.mjs"), "utf8"),
    );
    assert.throws(() => lstatSync(join(home, ".pi")));
    assert.match(install(), /up to date/);
  });
});

test("updates a stale copy and keeps the local invocation line", () => {
  withHome((home, install) => {
    const target = join(
      home,
      ".pi",
      "agent",
      "skills",
      "mineru-for-zotero-cli",
    );
    mkdirSync(join(target, "scripts"), { recursive: true });
    writeFileSync(
      join(target, "SKILL.md"),
      "---\nname: mineru-for-zotero-cli\ndescription: old\ndisable-model-invocation: true\n---\n\nOld body\n",
    );
    writeFileSync(join(target, "scripts", "query-markdown.mjs"), "// old\n");
    writeFileSync(join(target, "scripts", "gone.mjs"), "// removed upstream\n");

    const output = install();
    const installed = readFileSync(join(target, "SKILL.md"), "utf8");

    assert.match(output, /updated SKILL\.md/);
    assert.match(output, /removed scripts\/gone\.mjs/);
    assert.match(output, /kept local "disable-model-invocation: true"/);
    assert.match(installed, /\ndisable-model-invocation: true\n---\n/);
    assert.equal(
      installed.replace("disable-model-invocation: true\n", ""),
      readFileSync(join(sourceDir, "SKILL.md"), "utf8"),
    );
    assert.throws(() => lstatSync(join(target, "scripts", "gone.mjs")));
    assert.match(install(), /up to date/);
  });
});

test("links the skill to the repository with --link", () => {
  withHome((home, install) => {
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });

    install("--link");
    const target = join(home, ".agents", "skills", "mineru-for-zotero-cli");

    assert.ok(lstatSync(target).isSymbolicLink());
    assert.equal(realpathSync(target), realpathSync(sourceDir));
    assert.match(install("--link"), /up to date/);
  });
});

test("reports when no skill folder exists", () => {
  withHome((home, install) => {
    assert.match(install(), /No agent skill folder found/);
  });
});
