// Adapted from zotero-S2 (bridge/bridge.test.mjs at c5370a1).
//
// Tests for the stdio bridge (addon/content/bridge/mineru-for-zotero-mcp.mjs).
// Runs in plain Node, not in Zotero: `npm run test:bridge`.
// A stub HTTP server stands in for the plugin, so nothing here needs Zotero.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const BRIDGE = fileURLToPath(
  new URL("../addon/content/bridge/mineru-for-zotero-mcp.mjs", import.meta.url),
);
const TOKEN = "test-token";
const TOOL = (name) => ({ name, inputSchema: { type: "object" } });

/** A stand-in for the plugin's /mineru-for-zotero/mcp. `tools` and `status` can be changed. */
function stubZotero() {
  const stub = {
    tools: [TOOL("mineru_list_collections")],
    status: 200,
    seen: [],
    server: null,
    port: 0,
    async listen(port = 0) {
      stub.server = createServer((req, res) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const msg = JSON.parse(raw);
          stub.seen.push({ headers: req.headers, msg });
          const json = (status, body) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
          };
          if (req.headers.authorization !== `Bearer ${TOKEN}`) {
            return json(401, { error: "Missing or invalid bearer token" });
          }
          if (stub.status !== 200) return json(stub.status, { error: "off" });
          if (!("id" in msg)) {
            res.writeHead(202);
            return res.end();
          }
          const reply = (result) =>
            json(200, { jsonrpc: "2.0", id: msg.id, result });
          switch (msg.method) {
            case "initialize":
              return reply({
                protocolVersion: msg.params.protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "MinerU for Zotero", version: "9.9.9" },
                instructions: "stub instructions",
              });
            case "tools/list":
              return reply({ tools: stub.tools });
            case "tools/call":
              return reply({
                content: [{ type: "text", text: `ran ${msg.params.name}` }],
              });
            default:
              return json(200, {
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: "Method not found" },
              });
          }
        });
      });
      await new Promise((resolve) =>
        stub.server.listen(port, "127.0.0.1", resolve),
      );
      stub.port = stub.server.address().port;
      return stub;
    },
    async close() {
      stub.server?.closeAllConnections();
      await new Promise((resolve) => stub.server?.close(resolve) ?? resolve());
      stub.server = null;
    },
  };
  return stub;
}

/** A port nothing listens on. */
async function freePort() {
  const stub = await stubZotero().listen();
  const { port } = stub;
  await stub.close();
  return port;
}

/** Starts the bridge and talks to it over stdio like an MCP client. */
function startBridge(port, cacheFile, env = {}) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      MINERU_ZOTERO_TOKEN: TOKEN,
      MINERU_ZOTERO_URL: `http://127.0.0.1:${port}/mineru-for-zotero/mcp`,
      MINERU_ZOTERO_CACHE: cacheFile,
      MINERU_ZOTERO_POLL_MS: "50",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const waiters = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const i = waiters.findIndex((w) => w.match(message));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(message);
      else messages.push(message);
    }
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let nextId = 1;
  const bridge = {
    messages,
    stderr: () => stderr,
    exited,
    /** Resolves with the first message `match` accepts. */
    waitFor(match, ms = 5000) {
      const i = messages.findIndex(match);
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no matching message; stderr: ${stderr}`)),
          ms,
        );
        waiters.push({
          match,
          resolve: (m) => (clearTimeout(timer), resolve(m)),
        });
      });
    },
    sendRaw(line) {
      child.stdin.write(line + "\n");
    },
    notify(method, params) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
      );
    },
    request(method, params) {
      const id = nextId++;
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
      return bridge.waitFor((m) => m.id === id);
    },
    initialize: () =>
      bridge.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
    async stop() {
      child.stdin.end();
      await exited;
    },
  };
  return bridge;
}

describe("stdio bridge", () => {
  let dir;
  let n = 0;
  const cachePath = () => join(dir, `cache-${n++}.json`);
  const saved = (tools) =>
    JSON.stringify({ results: { "tools/list": { tools } } });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mineru-for-zotero-bridge-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("forwards to a running Zotero and saves the tool list", async () => {
    const zotero = await stubZotero().listen();
    const cacheFile = cachePath();
    const bridge = startBridge(zotero.port, cacheFile);
    try {
      const init = await bridge.initialize();
      assert.equal(init.result.serverInfo.version, "9.9.9");
      assert.equal(init.result.protocolVersion, "2025-06-18");
      // The bridge itself announces list changes
      assert.equal(init.result.capabilities.tools.listChanged, true);
      assert.equal(zotero.seen[0].headers.authorization, `Bearer ${TOKEN}`);

      bridge.notify("notifications/initialized");
      const list = await bridge.request("tools/list");
      assert.deepEqual(list.result.tools, zotero.tools);
      // Later legacy requests carry the negotiated version
      assert.equal(
        zotero.seen.at(-1).headers["mcp-protocol-version"],
        "2025-06-18",
      );

      const call = await bridge.request("tools/call", {
        name: "mineru_list_collections",
        arguments: {},
      });
      assert.equal(call.result.content[0].text, "ran mineru_list_collections");
      assert.equal(call.result.isError, undefined);

      // Zotero's own JSON-RPC errors pass through untouched
      const unknown = await bridge.request("resources/list");
      assert.equal(unknown.error.code, -32601);

      await bridge.stop();
      // The notification was forwarded and produced no output
      assert.ok(
        zotero.seen.some((s) => s.msg.method === "notifications/initialized"),
      );
      assert.deepEqual(bridge.messages, []);
      const cache = JSON.parse(await readFile(cacheFile, "utf8"));
      assert.deepEqual(cache.results["tools/list"].tools, zotero.tools);
      assert.equal(cache.results.initialize.instructions, "stub instructions");
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("mirrors a modern request's version, method and tool name in headers", async () => {
    const zotero = await stubZotero().listen();
    const bridge = startBridge(zotero.port, cachePath());
    try {
      await bridge.request("tools/call", {
        name: "mineru_añadir",
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      });
      const { headers } = zotero.seen[0];
      assert.equal(headers["mcp-protocol-version"], "2026-07-28");
      assert.equal(headers["mcp-method"], "tools/call");
      assert.equal(
        headers["mcp-name"],
        `=?base64?${Buffer.from("mineru_añadir").toString("base64")}?=`,
      );
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("answers from the saved list while Zotero is down", async () => {
    const cacheFile = cachePath();
    await writeFile(cacheFile, saved([TOOL("mineru_get_outline")]));
    const bridge = startBridge(await freePort(), cacheFile);
    try {
      const init = await bridge.initialize();
      assert.equal(init.result.protocolVersion, "2025-06-18");
      assert.equal(init.result.capabilities.tools.listChanged, true);
      assert.match(init.result.instructions, /no need to reconnect/);

      const list = await bridge.request("tools/list");
      assert.deepEqual(list.result.tools, [TOOL("mineru_get_outline")]);

      assert.deepEqual((await bridge.request("ping")).result, {
        resultType: "complete",
      });

      // A call is a tool error the agent can act on, not a protocol failure
      const call = await bridge.request("tools/call", {
        name: "mineru_get_outline",
        arguments: {},
      });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /Start Zotero and retry/);
    } finally {
      await bridge.stop();
    }
  });

  it("works without reconnecting once Zotero starts", async () => {
    const port = await freePort();
    const cacheFile = cachePath();
    // Saved by an older plugin version: one tool fewer than Zotero has now
    await writeFile(cacheFile, saved([TOOL("mineru_list_collections")]));
    const zotero = stubZotero();
    zotero.tools = [TOOL("mineru_list_collections"), TOOL("mineru_parse_pdf")];
    const bridge = startBridge(port, cacheFile);
    try {
      await bridge.initialize();
      const before = await bridge.request("tools/list");
      assert.equal(before.result.tools.length, 1);

      await zotero.listen(port);
      // The client is told the list changed, and asks again
      await bridge.waitFor(
        (m) => m.method === "notifications/tools/list_changed",
      );
      const now = await bridge.request("tools/list");
      assert.deepEqual(now.result.tools, zotero.tools);
      const call = await bridge.request("tools/call", {
        name: "mineru_parse_pdf",
        arguments: {},
      });
      assert.equal(call.result.content[0].text, "ran mineru_parse_pdf");
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("stays quiet when the saved list is still right", async () => {
    const port = await freePort();
    const cacheFile = cachePath();
    const zotero = stubZotero();
    await writeFile(cacheFile, saved(zotero.tools));
    const bridge = startBridge(port, cacheFile);
    try {
      await bridge.request("tools/list");
      await zotero.listen(port);
      // Wait until the bridge has noticed Zotero
      while (!zotero.seen.length) await new Promise((r) => setTimeout(r, 20));
      const call = await bridge.request("tools/call", {
        name: "mineru_list_collections",
        arguments: {},
      });
      assert.equal(call.result.isError, undefined);
      await bridge.stop();
      assert.deepEqual(bridge.messages, []);
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("starts with an empty list on a first run without Zotero, then fills it", async () => {
    const port = await freePort();
    const zotero = stubZotero();
    const bridge = startBridge(port, cachePath());
    try {
      const init = await bridge.initialize();
      assert.equal(init.result.serverInfo.name, "MinerU for Zotero");
      assert.deepEqual((await bridge.request("tools/list")).result.tools, []);
      await zotero.listen(port);
      await bridge.waitFor(
        (m) => m.method === "notifications/tools/list_changed",
      );
      assert.deepEqual(
        (await bridge.request("tools/list")).result.tools,
        zotero.tools,
      );
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("explains a rejected token and a disabled server", async () => {
    const zotero = await stubZotero().listen();
    const wrong = startBridge(zotero.port, cachePath(), {
      MINERU_ZOTERO_TOKEN: "stale",
    });
    const bridge = startBridge(zotero.port, cachePath());
    try {
      const args = { name: "mineru_list_collections", arguments: {} };
      const denied = await wrong.request("tools/call", args);
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /rejected the bearer token/);

      zotero.status = 503;
      const off = await bridge.request("tools/call", args);
      assert.equal(off.result.isError, true);
      assert.match(off.result.content[0].text, /switched off/);
    } finally {
      await wrong.stop();
      await bridge.stop();
      await zotero.close();
    }
  });

  it("refuses to start without a token or with a remote URL", async () => {
    const noToken = startBridge(1, cachePath(), { MINERU_ZOTERO_TOKEN: "" });
    assert.equal(await noToken.exited, 1);
    assert.match(noToken.stderr(), /MINERU_ZOTERO_TOKEN is not set/);

    const remote = startBridge(1, cachePath(), {
      MINERU_ZOTERO_URL: "http://example.com/mineru-for-zotero/mcp",
    });
    assert.equal(await remote.exited, 1);
    assert.match(remote.stderr(), /must be an http:\/\/ URL on 127\.0\.0\.1/);
  });

  it("survives a null-results cache file and primitive stdin values", async () => {
    const cacheFile = cachePath();
    await writeFile(cacheFile, JSON.stringify({ results: null }));
    const port = await freePort();
    const zotero = stubZotero();
    const bridge = startBridge(port, cacheFile);
    try {
      const init = await bridge.initialize();
      assert.equal(init.result.serverInfo.name, "MinerU for Zotero");
      // A JSON primitive on stdin must not crash the process
      bridge.sendRaw("42");
      const list = await bridge.request("tools/list");
      assert.deepEqual(list.result.tools, []);
      await zotero.listen(port);
      await bridge.waitFor(
        (m) => m.method === "notifications/tools/list_changed",
      );
      const liveList = await bridge.request("tools/list");
      assert.deepEqual(liveList.result.tools, zotero.tools);
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("keeps the offline-negotiated protocol version once Zotero starts", async () => {
    const port = await freePort();
    const zotero = stubZotero();
    const bridge = startBridge(port, cachePath());
    try {
      const init = await bridge.initialize();
      assert.equal(init.result.protocolVersion, "2025-06-18");
      await bridge.request("tools/list");
      await zotero.listen(port);
      await bridge.waitFor(
        (m) => m.method === "notifications/tools/list_changed",
      );
      await bridge.request("tools/call", {
        name: "mineru_list_collections",
        arguments: {},
      });
      assert.equal(
        zotero.seen.at(-1).headers["mcp-protocol-version"],
        "2025-06-18",
      );
    } finally {
      await bridge.stop();
      await zotero.close();
    }
  });

  it("reports a rejected token honestly at initialize without polling forever", async () => {
    const zotero = await stubZotero().listen();
    const wrong = startBridge(zotero.port, cachePath(), {
      MINERU_ZOTERO_TOKEN: "stale",
    });
    try {
      const init = await wrong.initialize();
      assert.match(init.result.instructions, /rejected the bearer token/);
      assert.doesNotMatch(init.result.instructions, /not reachable/);
      const seenAfterInit = zotero.seen.length;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(zotero.seen.length, seenAfterInit);
    } finally {
      await wrong.stop();
      await zotero.close();
    }
  });
});
