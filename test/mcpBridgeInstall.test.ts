import { assert } from "chai";
import {
  bridgeCommand,
  bridgePath,
  httpCommand,
  installBridge,
} from "../src/modules/mcp/bridge";

describe("MCP bridge install", function () {
  let dataDirectory: string;

  beforeEach(async function () {
    dataDirectory = PathUtils.join(
      PathUtils.tempDir,
      `mineru-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    await IOUtils.makeDirectory(dataDirectory, { createAncestors: true });
  });

  afterEach(async function () {
    await IOUtils.remove(dataDirectory, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  it("writes the bridge once and rewrites it when the packaged copy changes", async function () {
    const path = bridgePath(dataDirectory);
    const install = (source: string) =>
      installBridge({ dataDirectory, readSource: async () => source });

    assert.match(path, /mineru-mcp[\\/]mineru-for-zotero-mcp\.mjs$/);
    assert.isTrue(await install("// v1"));
    assert.equal(await IOUtils.readUTF8(path), "// v1");
    assert.isFalse(await install("// v1"));
    assert.isTrue(await install("// v2"));
    assert.equal(await IOUtils.readUTF8(path), "// v2");
  });

  it("builds the commands a user pastes into a terminal", function () {
    const standard = "http://127.0.0.1:23119/mineru-for-zotero/mcp";
    const custom = "http://127.0.0.1:24000/mineru-for-zotero/mcp";

    assert.equal(
      httpCommand("tok", standard),
      `claude mcp add --transport http mineru-for-zotero ${standard} --header "Authorization: Bearer tok"`,
    );
    assert.equal(
      bridgeCommand("tok", standard, "/data/mineru-mcp/bridge.mjs"),
      'claude mcp add mineru-for-zotero -e MINERU_ZOTERO_TOKEN=tok -- node "/data/mineru-mcp/bridge.mjs"',
    );
    assert.equal(
      bridgeCommand("tok", custom, "/data/mineru-mcp/bridge.mjs"),
      `claude mcp add mineru-for-zotero -e MINERU_ZOTERO_TOKEN=tok -e MINERU_ZOTERO_URL=${custom} -- node "/data/mineru-mcp/bridge.mjs"`,
    );
  });
});
