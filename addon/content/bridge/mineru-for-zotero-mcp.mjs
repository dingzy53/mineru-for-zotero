#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from zotero-S2 (addon/content/bridge/zotero-s2-mcp.mjs at c5370a1).
//
// MinerU for Zotero stdio bridge: an MCP server on stdin/stdout that forwards every
// JSON-RPC message to the plugin's HTTP endpoint inside Zotero.
//
// Why it exists: an MCP client connects to an HTTP server once, when the
// session starts. If Zotero isn't open yet, the tools never appear, even after
// Zotero is started. This process always starts, so the client always has the
// tools: while Zotero is down it answers the handshake and `tools/list` from
// the copy it saved last time, and a tool call says "start Zotero and retry".
// Once Zotero is up, calls go through. No reconnect is needed.
//
// No dependencies; needs Node 18 or later (global fetch).
//
//   MINERU_ZOTERO_TOKEN   bearer token from Zotero → Settings → MinerU for Zotero (required)
//   MINERU_ZOTERO_URL     endpoint (default http://127.0.0.1:23119/mineru-for-zotero/mcp)
//   MINERU_ZOTERO_CACHE   file for the saved tool list
//                     (default ~/.cache/mineru-for-zotero/bridge-cache.json)

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const ENDPOINT =
  process.env.MINERU_ZOTERO_URL ||
  "http://127.0.0.1:23119/mineru-for-zotero/mcp";
const TOKEN = (process.env.MINERU_ZOTERO_TOKEN || "").trim();
const CACHE_FILE =
  process.env.MINERU_ZOTERO_CACHE ||
  join(
    process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
    "mineru-for-zotero",
    "bridge-cache.json",
  );
// The plugin answers a tool call within about 50 s; leave room above that
const TIMEOUT_MS = Number(process.env.MINERU_ZOTERO_TIMEOUT_MS) || 120_000;
const POLL_MS = Number(process.env.MINERU_ZOTERO_POLL_MS) || 5000;

const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
/** Results worth replaying while Zotero is down. */
const CACHED_METHODS = new Set(["initialize", "tools/list", "server/discover"]);
const SETTINGS = "Zotero → Settings → MinerU for Zotero";

function fail(message) {
  process.stderr.write(`mineru-for-zotero-mcp: ${message}\n`);
  process.exit(1);
}

if (!TOKEN) {
  fail(`MINERU_ZOTERO_TOKEN is not set. Copy the command from ${SETTINGS}.`);
}
try {
  // The token must never leave this computer; the plugin listens on loopback only
  const { protocol, hostname } = new URL(ENDPOINT);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
  if (protocol !== "http:" || !loopback) throw new Error("not loopback");
} catch {
  fail(
    `MINERU_ZOTERO_URL must be an http:// URL on 127.0.0.1, got "${ENDPOINT}".`,
  );
}

// --- saved results ---------------------------------------------------------

/** method → the last result Zotero gave for it. */
let cache = {};
/** Writes run one after another, so a slow one can't overwrite a newer one. */
let cacheWrites = Promise.resolve();

async function loadCache() {
  try {
    const saved = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (
      saved?.results &&
      typeof saved.results === "object" &&
      !Array.isArray(saved.results)
    ) {
      cache = saved.results;
    }
  } catch {
    // First run, or an unreadable file: start empty
  }
}

function saveCache() {
  const text = JSON.stringify({
    savedAt: new Date().toISOString(),
    results: cache,
  });
  cacheWrites = cacheWrites.then(async () => {
    try {
      await mkdir(dirname(CACHE_FILE), { recursive: true });
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, CACHE_FILE);
    } catch (e) {
      process.stderr.write(
        `mineru-for-zotero-mcp: could not save ${CACHE_FILE}: ${e}\n`,
      );
    }
  });
}

function remember(method, result) {
  if (!CACHED_METHODS.has(method)) return;
  const text = JSON.stringify(result);
  if (JSON.stringify(cache[method]) === text) return;
  cache[method] = JSON.parse(text);
  saveCache();
}

// --- talking to Zotero -----------------------------------------------------

/** Legacy protocol version agreed in `initialize`, sent on later requests. */
let negotiated = null;

function encodeName(name) {
  const text = String(name);
  // Header values are ASCII; MCP's base64 form carries anything else
  return /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(text)
    ? text
    : `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function headersFor(msg) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const modern = msg?.params?._meta?.[META_VERSION];
  if (modern !== undefined) {
    // The 2026-07-28 revision mirrors these body fields in headers
    headers["MCP-Protocol-Version"] = String(modern);
    headers["Mcp-Method"] = String(msg.method);
    if (msg.method === "tools/call" && msg.params?.name !== undefined) {
      headers["Mcp-Name"] = encodeName(msg.params.name);
    }
  } else if (negotiated && msg?.method !== "initialize") {
    headers["MCP-Protocol-Version"] = negotiated;
  }
  return headers;
}

/**
 * Sends one message to Zotero. Returns `{ rpc }` with its JSON-RPC answer
 * (`null` for an accepted notification), or `{ problem }` with a sentence for
 * the agent when Zotero or the plugin can't answer.
 */
async function forward(msg, timeoutMs = TIMEOUT_MS) {
  let res;
  let text;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: headersFor(msg),
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      return {
        problem: `Zotero did not answer within ${Math.round(timeoutMs / 1000)} s. The call may still be running in Zotero, so check what was done before repeating it.`,
      };
    }
    return {
      down: true,
      problem: `Zotero isn't running (no answer at ${ENDPOINT}). Start Zotero and retry this call; no reconnect is needed.`,
    };
  }
  if (!text && res.status === 202) return { rpc: null };
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: Zotero's own error page
  }
  if (body && body.jsonrpc === "2.0") return { rpc: body };
  if (res.status === 401) {
    return {
      problem: `Zotero rejected the bearer token. Copy the command again from ${SETTINGS} (the token changes when you click Regenerate) and update MINERU_ZOTERO_TOKEN.`,
    };
  }
  if (res.status === 503) {
    return {
      retryable: true,
      problem: `The MinerU for Zotero MCP server is switched off. Tick "Enable MCP server" in ${SETTINGS}.`,
    };
  }
  return {
    // Zotero is up but the plugin isn't answering yet (still starting, or not installed)
    down: true,
    problem: `Zotero answered HTTP ${res.status} instead of the MinerU for Zotero plugin${body?.error ? ` (${body.error})` : ""}. Check that the plugin is installed and enabled, then retry.`,
  };
}

// --- answering the client --------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const result = (id, value) => ({
  jsonrpc: "2.0",
  id,
  result: { resultType: "complete", ...value },
});

const error = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** We announce tool-list changes ourselves, whatever Zotero says. */
function withListChanged(value) {
  return {
    ...value,
    capabilities: {
      ...value?.capabilities,
      tools: { ...value?.capabilities?.tools, listChanged: true },
    },
  };
}

/** The tool list the client last got from us, to tell when it is out of date. */
let servedTools = null;
/** True while the client holds answers that didn't come from a running Zotero. */
let stale = false;
let watching = false;

/** Zotero's answer, adjusted where the bridge behaves differently. */
function live(msg, rpc) {
  if (!rpc.result) return rpc;
  remember(msg.method, rpc.result);
  if (msg.method === "initialize") {
    negotiated = rpc.result.protocolVersion ?? negotiated;
    return { ...rpc, result: withListChanged(rpc.result) };
  }
  if (msg.method === "server/discover") {
    return { ...rpc, result: withListChanged(rpc.result) };
  }
  if (msg.method === "tools/list") {
    servedTools = JSON.stringify(rpc.result.tools ?? []);
    stale = false;
  }
  return rpc;
}

/** What we can say without Zotero. */
function offline(msg, problem, canWatch, isDown) {
  const { id, method, params } = msg;
  const isModern = params?._meta?.[META_VERSION] !== undefined;
  switch (method) {
    case "initialize": {
      if (isModern) return error(id, -32601, "Method not found");
      const saved = cache.initialize ?? {};
      const protocolVersion = LEGACY_VERSIONS.includes(params?.protocolVersion)
        ? params.protocolVersion
        : LEGACY_VERSIONS[0];
      negotiated = protocolVersion;
      if (canWatch) watch();
      const note = isDown
        ? "Zotero was not reachable when this session started. The tools work as soon as Zotero is running; there is no need to reconnect."
        : problem;
      return result(
        id,
        withListChanged({
          ...saved,
          protocolVersion,
          serverInfo: saved.serverInfo ?? {
            name: "MinerU for Zotero",
            version: "0",
          },
          instructions: [saved.instructions, note].filter(Boolean).join(" "),
        }),
      );
    }
    case "ping":
      if (isModern) return error(id, -32601, "Method not found");
      return result(id, {});
    case "server/discover":
      if (!cache[method]) return error(id, -32603, problem);
      if (canWatch) watch();
      return result(id, withListChanged(cache[method]));
    case "tools/list": {
      // With nothing saved yet the list is empty until Zotero starts; the
      // client is then told to ask again (notifications/tools/list_changed)
      const saved = cache[method] ?? { tools: [] };
      servedTools = JSON.stringify(saved.tools ?? []);
      if (canWatch) watch();
      return result(id, saved);
    }
    case "tools/call":
      return result(id, {
        content: [{ type: "text", text: problem }],
        isError: true,
      });
    default:
      return error(id, -32603, problem);
  }
}

/**
 * After answering from the saved copy, looks for Zotero until it is up, then
 * refreshes the copy and tells the client if the tool list changed.
 */
function watch() {
  stale = true;
  if (watching) return;
  watching = true;
  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const { rpc } = await forward(
        {
          jsonrpc: "2.0",
          id: "mineru-for-zotero-bridge",
          method: "tools/list",
        },
        Math.min(TIMEOUT_MS, 5000),
      );
      if (!rpc?.result) return;
      clearInterval(timer);
      watching = false;
      remember("tools/list", rpc.result);
      // A newer request may already have fetched the real list
      if (!stale) return;
      stale = false;
      if (
        servedTools !== null &&
        JSON.stringify(rpc.result.tools ?? []) !== servedTools
      ) {
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    } catch {
      // Try again on the next tick.
    } finally {
      polling = false;
    }
  }, POLL_MS);
  // Don't keep the process alive once the client has closed stdin
  timer.unref();
}

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send(error(null, -32700, "Parse error"));
    return;
  }
  const isRequest =
    msg !== null &&
    typeof msg === "object" &&
    !Array.isArray(msg) &&
    "id" in msg &&
    typeof msg.method === "string";
  const { rpc, problem, down, retryable } = await forward(msg);
  if (rpc) {
    send(isRequest ? live(msg, rpc) : rpc);
  } else if (isRequest) {
    send(offline(msg, problem, Boolean(down || retryable), Boolean(down)));
  } else if (Array.isArray(msg) && problem) {
    send(error(null, -32600, problem));
  }
  // A notification (or a client's response) gets no reply either way
}

process.stdout.on("error", (e) => {
  if (e?.code !== "EPIPE") throw e;
});

await loadCache();

const pending = new Set();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  const work = handle(line)
    .catch((e) =>
      process.stderr.write(`mineru-for-zotero-mcp: ${e?.stack ?? e}\n`),
    )
    .finally(() => pending.delete(work));
  pending.add(work);
});
lines.on("close", async () => {
  // The client is gone; let running calls finish, then leave
  await Promise.allSettled([...pending]);
  await cacheWrites;
  process.exit(0);
});
