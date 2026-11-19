import { assert } from "chai";
import { config } from "../package.json";
import {
  MCP_PATH,
  createMcpEndpointClass,
  ensureMcpToken,
  generateToken,
} from "../src/modules/mcp/endpoint";
import type { MarkdownQueryService } from "../src/modules/markdownQuery/queryService";
import {
  getMcpEnabled,
  getMcpToken,
  setMcpEnabled,
  setMcpToken,
} from "../src/utils/prefs";

const TOKEN = "test-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const service = {
  async getTasks() {
    return {
      tasks: [{ id: "9", libraryID: 1, key: "PDF00001", status: "running" }],
    };
  },
} as unknown as MarkdownQueryService;

function rpc(method: string, params?: object) {
  return { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) };
}

const Endpoint = createMcpEndpointClass(() => service);

describe("MCP endpoint", function () {
  let savedToken: string;
  let savedEnabled: boolean;

  async function init(
    headers: Record<string, string>,
    data: unknown = rpc("tools/list"),
    method = "POST",
  ) {
    const [status, responseHeaders, body] = await new Endpoint().init({
      method,
      headers,
      data,
    });
    return {
      status,
      headers: responseHeaders,
      json: body ? JSON.parse(body) : null,
    };
  }

  before(function () {
    savedToken = getMcpToken();
    savedEnabled = getMcpEnabled();
    setMcpToken(TOKEN);
    setMcpEnabled(true);
  });

  after(function () {
    setMcpToken(savedToken);
    setMcpEnabled(savedEnabled);
  });

  it("keeps the one-argument init Zotero's server dispatches on", function () {
    const endpoint = new Endpoint();

    assert.lengthOf(endpoint.init, 1);
    assert.deepEqual(endpoint.supportedDataTypes, ["application/json"]);
    assert.isTrue(endpoint.allowRequestsFromUnsafeWebContent);
  });

  it("answers 503 while the server is disabled", async function () {
    setMcpEnabled(false);
    try {
      assert.equal((await init(AUTH)).status, 503);
    } finally {
      setMcpEnabled(true);
    }
  });

  it("rejects requests that carry an Origin, even with the token", async function () {
    const response = await init({ ...AUTH, origin: "http://localhost:3000" });

    assert.equal(response.status, 403);
    assert.equal(response.json.error.message, "Origin not allowed");
  });

  it("requires the bearer token", async function () {
    for (const headers of [
      {},
      { authorization: "Bearer wrong-token-0123456789" },
      { authorization: TOKEN },
      { authorization: `Bearer ${TOKEN}x` },
    ]) {
      const response = await init(headers);

      assert.equal(response.status, 401, JSON.stringify(headers));
      assert.equal(response.headers["WWW-Authenticate"], "Bearer");
    }
  });

  it("refuses every request while no token is set", async function () {
    setMcpToken("");
    try {
      assert.equal((await init({ authorization: "Bearer " })).status, 401);
      assert.equal((await init({})).status, 401);
    } finally {
      setMcpToken(TOKEN);
    }
  });

  it("serves the handshake, the tool list and a tool call", async function () {
    const hello = await init(
      AUTH,
      rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
    );
    const list = await init(AUTH);
    const call = await init(
      { authorization: `bearer ${TOKEN}` },
      rpc("tools/call", { name: "mineru_list_tasks", arguments: {} }),
    );

    assert.equal(hello.status, 200);
    assert.equal(hello.json.result.serverInfo.name, config.addonName);
    assert.include(hello.json.result.instructions, "parsed in Zotero");
    assert.lengthOf(list.json.result.tools, 11);
    assert.deepEqual(list.json.result.tools[0].inputSchema.type, "object");
    assert.equal(call.status, 200);
    assert.include(call.json.result.content[0].text, "PDF: PDF00001");
    assert.notProperty(call.json.result, "isError");
  });

  it("reports a tool failure as an isError result, not an HTTP error", async function () {
    const call = await init(
      AUTH,
      rpc("tools/call", { name: "mineru_get_outline", arguments: {} }),
    );

    assert.equal(call.status, 200);
    assert.isTrue(call.json.result.isError);
    assert.include(
      call.json.result.content[0].text,
      'Missing required argument "key"',
    );
  });

  it("answers 405 to GET", async function () {
    assert.equal((await init(AUTH, null, "GET")).status, 405);
  });

  it("generates a token once and keeps it", function () {
    setMcpToken("");
    try {
      const token = ensureMcpToken();

      assert.match(token, /^[0-9a-f]{64}$/);
      assert.equal(ensureMcpToken(), token);
      assert.notEqual(generateToken(), token);
    } finally {
      setMcpToken(TOKEN);
    }
  });

  describe("through Zotero's local server", function () {
    async function send(
      method: string,
      headers: Record<string, string>,
      body?: unknown,
    ) {
      const port = Zotero.Prefs.get("httpServer.port");
      const xhr = await Zotero.HTTP.request(
        method,
        `http://127.0.0.1:${port}${MCP_PATH}`,
        {
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          responseType: "text",
          successCodes: false,
          errorDelayMax: 0,
        } as never,
      );
      return {
        status: xhr.status as number,
        json: xhr.responseText ? JSON.parse(xhr.responseText) : null,
      };
    }

    before(function () {
      // Only a running Zotero has the server; the standalone harness does not.
      if (typeof Zotero.HTTP?.request !== "function") {
        this.skip();
      }
    });

    it("serves the registered endpoint with the token", async function () {
      const response = await send(
        "POST",
        {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        rpc("tools/list"),
      );

      assert.equal(response.status, 200);
      assert.lengthOf(response.json.result.tools, 11);
    });

    it("answers 401 without the token and 405 to GET", async function () {
      const unauthorized = await send(
        "POST",
        { "Content-Type": "application/json" },
        rpc("tools/list"),
      );
      const get = await send("GET", { Authorization: `Bearer ${TOKEN}` });

      assert.equal(unauthorized.status, 401);
      assert.equal(get.status, 405);
    });

    it("accepts a notification with 202", async function () {
      const response = await send(
        "POST",
        {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      );

      assert.equal(response.status, 202);
    });
  });
});
