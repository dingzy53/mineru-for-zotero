// Adapted from zotero-S2 (src/mcp/schema.ts at c5370a1).

import { ToolError } from "./errors";

export type SchemaType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "array"
  | "object";

/** The subset of JSON Schema our tool definitions use. */
export interface JSONSchema {
  type?: SchemaType | readonly SchemaType[];
  description?: string;
  enum?: readonly (string | number)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JSONSchema;
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function closestArgument(input: string, valid: string[]): string | null {
  if (!valid.length) return null;
  const strip = (s: string) => s.toLowerCase().replace(/[_-]/g, "");
  const norm = strip(input);
  const exact = valid.find((cand) => strip(cand) === norm);
  if (exact) return exact;

  const lower = input.toLowerCase();
  let best: string | null = null;
  let bestDist = Infinity;
  for (const cand of valid) {
    const dist = levenshtein(lower, cand.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = cand;
    }
  }
  const threshold = best
    ? Math.max(2, Math.floor(Math.max(input.length, best.length) / 2))
    : 0;
  return best && bestDist <= threshold ? best : null;
}

function check(schema: JSONSchema, value: unknown, path: string): void {
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.some(
      (t) => actual === t || (t === "number" && actual === "integer"),
    );
    if (!ok) {
      throw new ToolError(
        `${path} must be ${allowed.join(" or ")}, got ${actual}`,
      );
    }
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    throw new ToolError(`${path} must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      throw new ToolError(`${path} must be ≥ ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      throw new ToolError(`${path} must be ≤ ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new ToolError(`${path} needs at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      throw new ToolError(
        `${path} allows at most ${schema.maxItems} items; split the request`,
      );
    }
    if (schema.items) {
      value.forEach((v, i) => check(schema.items!, v, `${path}[${i}]`));
    }
  }
}

/**
 * Validates tool arguments against the tool's input schema, drops empty
 * strings (agents often send `""` for "not set"), and fills defaults.
 */
export function prepareArgs(
  schema: JSONSchema,
  raw: unknown,
): Record<string, any> {
  if (raw !== undefined && typeOf(raw) !== "object") {
    throw new ToolError("arguments must be an object");
  }
  const args: Record<string, any> = {};
  const valid = Object.keys(schema.properties ?? {});
  for (const [key, value] of Object.entries((raw ?? {}) as object)) {
    if (value === "" || value === null || value === undefined) continue;
    if (!Object.hasOwn(schema.properties ?? {}, key)) {
      const suggestion = closestArgument(key, valid);
      const didYouMean = suggestion ? ` Did you mean "${suggestion}"?` : "";
      const accepted = valid.length ? valid.join(", ") : "(none)";
      throw new ToolError(
        `Unknown argument "${key}".${didYouMean} Accepted arguments: ${accepted}`,
      );
    }
    args[key] = value;
  }
  for (const name of schema.required ?? []) {
    if (args[name] === undefined) {
      throw new ToolError(`Missing required argument "${name}"`);
    }
  }
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (args[key] === undefined) {
      if (prop.default !== undefined) args[key] = prop.default;
      continue;
    }
    check(prop, args[key], key);
  }
  return args;
}
