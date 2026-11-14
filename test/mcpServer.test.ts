import { assert } from "chai";
import {
  ERR,
  MODERN_VERSION,
  McpRequest,
  createMcpHandler,
} from "../src/modules/mcp/server";
import type { ToolDef } from "../src/modules/mcp/types";

const echo: ToolDef = {
  name: "echo",
  title: "Echo",
  description: "Echo arguments",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    return `echo: ${args.text ?? ""}`;
  },
};

const handle = createMcpHandler({
  name: "MinerU for Zotero",
  version: "test",
  buildTime: "2026-01-02T03:04:05Z",
  instructions: "test instructions",
  tools: () => [echo],
  callTool: async (tool, args) =>
    (args as any)?.text === "fail"
      ? { ok: false, message: "it failed" }
      : { ok: true, text: await tool.handler(args as any, null as any) },
});

const meta = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function post(data: unknown, headers: Record<string, string> = {}): McpRequest {
  return { method: "POST", headers, data };
}

function modern(
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders = {},
) {
  const headers: Record<string, string> = {
    "mcp-protocol-version": MODERN_VERSION,
    "mcp-method": method,
    ...extraHeaders,
  };
  if (method === "tools/call") headers["mcp-name"] = String(params.name);
  return post(
    {
      jsonrpc: "2.0",
      id: 7,
      method,
      params: { ...params, _meta: { ...meta } },
    },
    headers,
  );
}

async function call(req: McpRequest) {
  const [status, headers, body] = await handle(req);
  return { status, headers, json: body ? JSON.parse(body) : null };
}

describe("MCP server", function () {
  describe("MCP legacy era", function () {
    it("negotiates initialize", async function () {
      const r = await call(
        post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "c", version: "1" },
          },
        }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.json.result.protocolVersion, "2025-06-18");
      assert.deepEqual(r.json.result.capabilities, {
        tools: { listChanged: false },
      });
      assert.equal(r.json.result.instructions, "test instructions");
      assert.deepEqual(r.json.result.serverInfo, {
        name: "MinerU for Zotero",
        version: "test",
        buildTime: "2026-01-02T03:04:05Z",
      });
    });

    it("falls back to the newest legacy version", async function () {
      const r = await call(
        post({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05" },
        }),
      );
      assert.equal(r.json.result.protocolVersion, "2025-11-25");
    });

    it("accepts notifications with 202", async function () {
      const [status, , body] = await handle(
        post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      );
      assert.equal(status, 202);
      assert.equal(body, "");
    });

    it("serves tools/list with only the version header (no Mcp-Method)", async function () {
      const r = await call(
        post(
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { "mcp-protocol-version": "2025-11-25" },
        ),
      );
      assert.equal(r.status, 200);
      assert.equal(r.json.result.tools[0].name, "echo");
    });

    it("calls a tool", async function () {
      const r = await call(
        post({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hi" } },
        }),
      );
      assert.deepEqual(r.json.result.content, [
        { type: "text", text: "echo: hi" },
      ]);
      assert.notProperty(r.json.result, "structuredContent");
    });

    it("answers ping and leaves results without _meta", async function () {
      const r = await call(post({ jsonrpc: "2.0", id: 4, method: "ping" }));
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.result, { resultType: "complete" });
    });

    it("rejects an unknown version header", async function () {
      const r = await call(
        post(
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { "mcp-protocol-version": "1999-01-01" },
        ),
      );
      assert.equal(r.status, 400);
    });
  });

  describe("MCP modern era (2026-07-28)", function () {
    it("answers server/discover", async function () {
      const r = await call(modern("server/discover"));
      assert.equal(r.status, 200);
      assert.equal(r.json.result.resultType, "complete");
      assert.include(r.json.result.supportedVersions, MODERN_VERSION);
      assert.equal(
        r.json.result._meta["io.modelcontextprotocol/serverInfo"].name,
        "MinerU for Zotero",
      );
      assert.isNumber(r.json.result.ttlMs);
    });

    it("lists and calls tools with matching headers", async function () {
      const list = await call(modern("tools/list"));
      assert.equal(list.json.result.resultType, "complete");
      assert.equal(list.json.result.cacheScope, "private");
      const r = await call(
        modern("tools/call", { name: "echo", arguments: { text: "yo" } }),
      );
      assert.equal(r.status, 200);
      assert.equal(r.json.result.content[0].text, "echo: yo");
    });

    it("identifies the server in every result's _meta", async function () {
      for (const req of [
        modern("tools/list"),
        modern("tools/call", { name: "echo", arguments: {} }),
        modern("tools/call", { name: "echo", arguments: { text: "fail" } }),
      ]) {
        const r = await call(req);
        assert.deepEqual(r.json.result._meta, {
          "io.modelcontextprotocol/serverInfo": {
            name: "MinerU for Zotero",
            version: "test",
            buildTime: "2026-01-02T03:04:05Z",
          },
        });
      }
    });

    it("treats initialize and ping as removed methods", async function () {
      for (const method of ["initialize", "ping"]) {
        const r = await call(modern(method));
        assert.equal(r.status, 404, method);
        assert.equal(r.json.error.code, ERR.METHOD_NOT_FOUND);
      }
    });

    it("decodes a base64 Mcp-Name", async function () {
      const req = modern("tools/call", { name: "echo", arguments: {} });
      req.headers["mcp-name"] = `=?base64?${btoa("echo")}?=`;
      const r = await call(req);
      assert.equal(r.status, 200);
    });

    it("rejects Mcp-Name mismatch with -32020", async function () {
      const req = modern("tools/call", { name: "echo", arguments: {} });
      req.headers["mcp-name"] = "other";
      const r = await call(req);
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, ERR.HEADER_MISMATCH);
    });

    it("rejects a missing Mcp-Method with -32020", async function () {
      const req = modern("tools/list");
      delete req.headers["mcp-method"];
      const r = await call(req);
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, ERR.HEADER_MISMATCH);
    });

    it("rejects an unsupported version with -32022 and lists supported", async function () {
      const req = modern("tools/list");
      (req.data as any).params._meta[
        "io.modelcontextprotocol/protocolVersion"
      ] = "2099-01-01";
      const r = await call(req);
      assert.equal(r.status, 400);
      assert.equal(r.json.error.code, ERR.UNSUPPORTED_VERSION);
      assert.include(r.json.error.data.supported, MODERN_VERSION);
    });

    it("returns 404 / -32601 for unknown methods", async function () {
      const r = await call(modern("resources/list"));
      assert.equal(r.status, 404);
      assert.equal(r.json.error.code, ERR.METHOD_NOT_FOUND);
    });

    it("reports tool failures as isError results", async function () {
      const r = await call(
        modern("tools/call", { name: "echo", arguments: { text: "fail" } }),
      );
      assert.equal(r.status, 200);
      assert.isTrue(r.json.result.isError);
      assert.equal(r.json.result.content[0].text, "it failed");
    });
  });

  describe("MCP transport basics", function () {
    it("returns 405 for GET and DELETE", async function () {
      for (const method of ["GET", "DELETE"]) {
        const [status] = await handle({ method, headers: {}, data: null });
        assert.equal(status, 405);
      }
    });

    it("rejects batches and non-JSON-RPC bodies", async function () {
      assert.equal(
        (await call(post([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).status,
        400,
      );
      assert.equal((await call(post({ hello: 1 }))).status, 400);
    });
  });
});
