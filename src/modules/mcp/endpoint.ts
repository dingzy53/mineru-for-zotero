// Adapted from zotero-S2 (src/http/endpoints.ts at c5370a1).

import { BUILD } from "../../utils/build";
import { getMcpEnabled, getMcpToken, setMcpToken } from "../../utils/prefs";
import { getMarkdownQueryService } from "../markdownQuery/apiEndpoint";
import type { MarkdownQueryService } from "../markdownQuery/queryService";
import { runTool } from "./runTool";
import { createMcpHandler } from "./server";
import { TOOLS } from "./tools";

export const MCP_PATH = "/mineru-for-zotero/mcp";

/** Sent to the agent at session start; it decides when the tools are used. */
export const MCP_INSTRUCTIONS = [
  "MinerU for Zotero: read the papers in the user's Zotero library that MinerU has parsed into Markdown (text, tables, LaTeX formulas).",
  'Use these tools whenever the user says papers are "parsed in Zotero" or parsed with MinerU, or asks to read, summarize, search, quote or cite a paper or a collection in Zotero.',
  "For a collection, start with mineru_collection_status: it lists every item with its key and whether it can be read. For one paper, find its key with mineru_search_items.",
  "Then read in this order: mineru_get_outline, then mineru_read_section or mineru_search_in_paper for the parts you need, and mineru_read_markdown only when you need the whole paper. mineru_locate_in_pdf gives page numbers for citations.",
  "Do not read the mineru-copy or MinerU-Sync folders or zotero.sqlite yourself: these tools pick the right PDF of an item and return single sections.",
  "mineru_parse_pdf spends the user's MinerU quota. Parse the one or two PDFs a task needs; ask the user before parsing more.",
  "Item keys are Zotero's own, so keys from other Zotero tools (for example zotero-s2's zotero_list_collection_items) work here.",
].join(" ");

type Reply = [number, Record<string, string>, string];

interface ServerRequest {
  method: string;
  headers: Record<string, string | undefined>;
  data: unknown;
}

function json(status: number, body: unknown): Reply {
  return [status, { "Content-Type": "application/json" }, JSON.stringify(body)];
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The gate every request passes: server enabled, no browser `Origin`
 * (DNS rebinding, CSRF), valid bearer token. Returns the refusal, or null.
 *
 * Zotero itself already rejects a non-local `Host` (Zotero 10) and binds to
 * loopback, so what is left to keep out is another local program, hence the
 * token: unlike the read-only REST API, this server can start a parse.
 */
export function checkAccess(
  headers: Record<string, string | undefined>,
): Reply | null {
  if (!getMcpEnabled()) {
    return json(503, {
      error: "The MinerU for Zotero MCP server is disabled in settings",
    });
  }
  if (headers.origin !== undefined) {
    return json(403, {
      jsonrpc: "2.0",
      error: { code: -32600, message: "Origin not allowed" },
    });
  }
  const token = getMcpToken();
  const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || "");
  if (!token || !match || !timingSafeEqual(match[1].trim(), token)) {
    return [
      401,
      { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
      JSON.stringify({
        error:
          "Missing or invalid bearer token (see Zotero → Settings → MinerU for Zotero)",
      }),
    ];
  }
  return null;
}

/**
 * Build the endpoint class Zotero's server instantiates per request.
 * Exported with an injectable service for tests.
 */
export function createMcpEndpointClass(
  getService: () => MarkdownQueryService = getMarkdownQueryService,
) {
  const mcp = createMcpHandler({
    name: BUILD.name,
    version: BUILD.version,
    buildTime: BUILD.buildTime,
    instructions: MCP_INSTRUCTIONS,
    tools: () => TOOLS,
    callTool: (tool, args) =>
      runTool(tool, args, {
        service: getService(),
        defaultLibraryID: () => Zotero.Libraries.userLibraryID,
        logError: (error) => Zotero.logError(error as Error),
      }),
  });

  return class McpEndpoint {
    supportedMethods = ["GET", "POST", "DELETE"];
    supportedDataTypes = ["application/json"];
    // Zotero would drop a request with an Origin or a browser user agent
    // without answering; we answer an Origin with 403 ourselves instead.
    allowRequestsFromUnsafeWebContent = true;

    // One parameter: Zotero then passes a request object and awaits
    // [status, headers, body]. Do not add parameters.
    async init(req: ServerRequest): Promise<Reply> {
      try {
        return checkAccess(req.headers) ?? (await mcp(req));
      } catch (error) {
        Zotero.logError(error as Error);
        return json(500, { error: String(error) });
      }
    }
  };
}

/** Reason phrases Zotero's server lacks; without one it sends "undefined". */
const EXTRA_STATUS_TEXT: Record<number, string> = {
  202: "Accepted",
  401: "Unauthorized",
  405: "Method Not Allowed",
};

export function registerMcpEndpoint(): void {
  const codes = Zotero.Server.responseCodes as Record<number, string>;
  for (const [code, text] of Object.entries(EXTRA_STATUS_TEXT)) {
    codes[Number(code)] ??= text;
  }
  (Zotero.Server.Endpoints as Record<string, unknown>)[MCP_PATH] =
    createMcpEndpointClass();
}

export function unregisterMcpEndpoint(): void {
  delete (Zotero.Server.Endpoints as Record<string, unknown>)[MCP_PATH];
}

/** The port Zotero's local server listens on. */
export function serverPort(): number {
  try {
    return (
      (Zotero.Server as { port?: number }).port ||
      (Zotero.Prefs.get("httpServer.port") as number) ||
      23119
    );
  } catch {
    return 23119;
  }
}

/** URL an MCP client on this computer connects to. */
export function mcpEndpointURL(): string {
  return `http://127.0.0.1:${serverPort()}${MCP_PATH}`;
}

/** Make sure a token exists; called once at startup. */
export function ensureMcpToken(): string {
  let token = getMcpToken();
  if (!token) {
    token = generateToken();
    setMcpToken(token);
  }
  return token;
}

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
