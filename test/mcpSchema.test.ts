import { assert } from "chai";
import { ToolError } from "../src/modules/mcp/errors";
import { JSONSchema, prepareArgs } from "../src/modules/mcp/schema";

const schema: JSONSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    limit: { type: "integer", default: 20, minimum: 1, maximum: 100 },
    plain: { type: "boolean" },
    section_path: { type: "array", items: { type: "string" }, minItems: 1 },
    sort_by: { type: "string", enum: ["title", "year"] },
  },
  required: ["key"],
};

function rejects(raw: unknown, message: RegExp): void {
  try {
    prepareArgs(schema, raw);
  } catch (error) {
    assert.instanceOf(error, ToolError);
    assert.match((error as Error).message, message);
    return;
  }
  assert.fail(`Expected ${message}`);
}

describe("MCP argument validation", function () {
  it("fills defaults and drops empty values", function () {
    assert.deepEqual(prepareArgs(schema, { key: "ABCD1234", sort_by: "" }), {
      key: "ABCD1234",
      limit: 20,
    });
  });

  it("requires required arguments", function () {
    rejects({}, /Missing required argument "key"/);
    rejects({ key: "" }, /Missing required argument "key"/);
    rejects(undefined, /Missing required argument "key"/);
  });

  it("rejects unknown arguments and wrong types", function () {
    rejects({ key: "A", libraryID: 1 }, /Unknown argument "libraryID"/);
    rejects({ key: 5 }, /key must be string, got integer/);
    rejects({ key: "A", plain: "yes" }, /plain must be boolean/);
    rejects("ABCD1234", /arguments must be an object/);
  });

  it("enforces ranges, enums and array items", function () {
    rejects({ key: "A", limit: 0 }, /limit must be ≥ 1/);
    rejects({ key: "A", limit: 101 }, /limit must be ≤ 100/);
    rejects({ key: "A", limit: 1.5 }, /limit must be integer/);
    rejects(
      { key: "A", sort_by: "date" },
      /sort_by must be one of: title, year/,
    );
    rejects({ key: "A", section_path: [] }, /at least 1 item/);
    rejects(
      { key: "A", section_path: ["a", 2] },
      /section_path\[1\] must be string/,
    );
  });
});
