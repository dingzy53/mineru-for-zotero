import type { MarkdownQueryService } from "../markdownQuery/queryService";
import { MarkdownQueryError } from "../markdownQuery/types";
import { ToolError, errorMessage } from "./errors";
import { describeQueryError } from "./format";
import { prepareArgs } from "./schema";
import type { ToolDef, ToolOutcome } from "./types";

/**
 * How long one tool call may take. MCP clients stop waiting after about 60 s
 * and then the agent cannot tell what was done, so a tool that waits (a parse)
 * answers before that with the state it reached.
 */
export const TOOL_BUDGET_MS = 50_000;

/**
 * Longest text one tool call returns. MCP clients reject or silently cut
 * larger results; cutting here lets the last line say how to get the rest.
 */
export const MAX_RESULT_CHARS = 80_000;

/** What `runTool()` needs from its surroundings; tests replace the clock. */
export interface ToolRuntime {
  service: MarkdownQueryService;
  defaultLibraryID(): number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Reports a bug (anything that is not a ToolError or a query error). */
  logError?(error: unknown): void;
}

/** Cut an over-long result at a line break and say that it was cut. */
export function capResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) {
    return text;
  }
  const lineBreak = text.lastIndexOf("\n", MAX_RESULT_CHARS);
  const end = lineBreak > MAX_RESULT_CHARS / 2 ? lineBreak : MAX_RESULT_CHARS;
  return `${text.slice(0, end)}\n\n[Cut at ${end} of ${text.length} characters. Narrow the request: a smaller limit or max_chars, a single section, or a more specific query.]`;
}

/** Validates the arguments and runs the tool. Never throws. */
export async function runTool(
  tool: ToolDef,
  rawArgs: unknown,
  runtime: ToolRuntime,
): Promise<ToolOutcome> {
  const now = runtime.now ?? (() => Date.now());
  try {
    const args = prepareArgs(tool.inputSchema, rawArgs);
    const text = await tool.handler(args, {
      service: runtime.service,
      defaultLibraryID: runtime.defaultLibraryID(),
      deadline: now() + TOOL_BUDGET_MS,
      now,
      sleep:
        runtime.sleep ??
        ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    });
    return { ok: true, text: capResult(text) };
  } catch (error) {
    // Mistakes the agent can fix are expected; anything else is a bug.
    if (error instanceof ToolError) {
      return { ok: false, message: error.message };
    }
    if (error instanceof MarkdownQueryError) {
      return { ok: false, message: describeQueryError(error) };
    }
    runtime.logError?.(error);
    return { ok: false, message: `Internal error: ${errorMessage(error)}` };
  }
}
