import type { MarkdownQueryService } from "../markdownQuery/queryService";
import type { JSONSchema } from "./schema";

/** What a tool handler gets besides its arguments. */
export interface ToolContext {
  service: MarkdownQueryService;
  /** Library used when a call gives no `library_id`. */
  defaultLibraryID: number;
  /** Epoch ms by which the call should answer (`TOOL_BUDGET_MS`). */
  deadline: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * One MCP tool. A handler returns the text shown to the agent: parsed papers
 * are Markdown, and wrapping them in JSON would only add escapes.
 */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JSONSchema & { type: "object" };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  handler(args: Record<string, any>, ctx: ToolContext): Promise<string>;
}

/** Result of running a tool; a failure carries a message the agent can act on. */
export type ToolOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string };
