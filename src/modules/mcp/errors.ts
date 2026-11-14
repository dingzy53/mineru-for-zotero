// Adapted from zotero-S2 (src/mcp/errors.ts at c5370a1).

/** An error the agent caused and can fix; reported as a tool result with `isError`. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
