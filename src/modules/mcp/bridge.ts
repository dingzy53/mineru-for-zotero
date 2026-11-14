// Adapted from zotero-S2 (src/modules/bridge.ts at c5370a1).

import { joinNativePath } from "../mineruClient/path";
import { MCP_PATH } from "./endpoint";

/**
 * The stdio bridge (`addon/content/bridge/mineru-for-zotero-mcp.mjs`) is a
 * Node script an MCP client starts itself, so the tools exist even when Zotero
 * is opened after the agent session. A client needs a real file to run, and an
 * .xpi is a zip, so a copy is kept in the Zotero data directory.
 */

const FILE = "mineru-for-zotero-mcp.mjs";
const DIRECTORY = "mineru-mcp";
const DEFAULT_ENDPOINT = `http://127.0.0.1:23119${MCP_PATH}`;

/** Name under which the generated commands register the server. */
export const MCP_SERVER_NAME = "mineru-for-zotero";

export function bridgePath(
  dataDirectory: string = Zotero.DataDirectory.dir,
): string {
  return joinNativePath(dataDirectory, DIRECTORY, FILE);
}

/**
 * Writes the packaged bridge to `bridgePath()` unless that copy is current.
 * The path is in commands users have already pasted, so every plugin update
 * must refresh the file there. Returns whether the file was written.
 */
export async function installBridge(
  options: {
    dataDirectory?: string;
    readSource?: () => Promise<string>;
  } = {},
): Promise<boolean> {
  const source = await (
    options.readSource ??
    (() =>
      Zotero.File.getContentsFromURLAsync(`${rootURI}content/bridge/${FILE}`))
  )();
  const path = bridgePath(options.dataDirectory);
  try {
    if ((await IOUtils.readUTF8(path)) === source) return false;
  } catch {
    // Not there yet.
  }
  await IOUtils.makeDirectory(
    joinNativePath(
      options.dataDirectory ?? Zotero.DataDirectory.dir,
      DIRECTORY,
    ),
    { createAncestors: true },
  );
  await IOUtils.writeUTF8(path, source, { tmpPath: `${path}.tmp` });
  return true;
}

/** `claude mcp add` for a direct HTTP connection. */
export function httpCommand(token: string, endpoint: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint} --header "Authorization: Bearer ${token}"`;
}

/** `claude mcp add` for the bridge; the URL is given only when it isn't the default. */
export function bridgeCommand(
  token: string,
  endpoint: string,
  path: string = bridgePath(),
): string {
  const env = [`-e MINERU_ZOTERO_TOKEN=${token}`];
  if (endpoint !== DEFAULT_ENDPOINT) {
    env.push(`-e MINERU_ZOTERO_URL=${endpoint}`);
  }
  return `claude mcp add ${MCP_SERVER_NAME} ${env.join(" ")} -- node "${path}"`;
}
