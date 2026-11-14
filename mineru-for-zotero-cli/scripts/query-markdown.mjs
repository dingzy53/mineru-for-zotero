#!/usr/bin/env node
/* global AbortController, URL, clearTimeout, console, fetch, process, setTimeout */

/**
 * Agent-facing CLI for the MinerU for Zotero Markdown query API.
 *
 * The local query API is gated only by the plugin's enable switch, so requests
 * carry no Authorization header.
 *
 * Exit codes (also printed by --help):
 *   0  success
 *   1  API error: the API answered with an HTTP 4xx/5xx error envelope, or a
 *      parse awaited with --wait did not succeed
 *   2  argument or usage error: the usage text is printed to stderr
 *   3  transport error: Zotero is unreachable (connection refused, timeout, or
 *      a non-JSON response)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EXIT_SUCCESS = 0;
const EXIT_API_ERROR = 1;
const EXIT_USAGE_ERROR = 2;
const EXIT_TRANSPORT_ERROR = 3;

/**
 * API contract this CLI was written for. Matches `MARKDOWN_API_VERSION` in the
 * plugin (`src/modules/markdownQuery/apiEndpoint.ts`).
 */
const API_VERSION = 1;

const DEFAULT_LISTEN_PORT = 23119;
const DEFAULT_FORMAT = "text";
const DEFAULT_TIMEOUT_MS = 30000;
const SEARCH_ENDPOINT = "/mineru-for-zotero/search";
const MARKDOWN_ENDPOINT = "/mineru-for-zotero/markdown";
const LIBRARIES_ENDPOINT = "/mineru-for-zotero/libraries";
const COLLECTIONS_ENDPOINT = "/mineru-for-zotero/collections";
const TAGS_ENDPOINT = "/mineru-for-zotero/tags";
const STATUS_ENDPOINT = "/mineru-for-zotero/status";
const PARSE_ENDPOINT = "/mineru-for-zotero/parse";
const TASKS_ENDPOINT = "/mineru-for-zotero/tasks";
const DEFAULT_WAIT_TIMEOUT_MS = 900000;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const FINISHED_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const VALID_FORMATS = new Set(["text", "json"]);
const VALID_GRANULARITIES = new Set([
  "full",
  "headings",
  "section",
  "search",
  "locate",
]);
const VALID_SORT_BY = new Set(["dateAdded", "dateModified", "title", "year"]);
const VALID_SORT_ORDER = new Set(["asc", "desc"]);
const YEAR_PATTERN = /^\d{4}$/;

/**
 * Flags that act as switches and do not consume a value.
 */
const BOOLEAN_FLAGS = new Set([
  "--include-subsections",
  "--include-subcollections",
  "--has-pdf",
  "--parsed-only",
  "--force",
  "--wait",
  "--plain",
]);

/** Tags MinerU writes inside running text, removed by --plain. */
const INLINE_HTML_TAG =
  /<\/?(?:sub|sup|i|b|em|strong|u|s|span|small|mark|font)\b[^>]*>/gi;

/**
 * Runs the CLI entry point and maps failures to stable process output.
 * Returns one of the documented exit codes: 0 success, 1 API error,
 * 2 argument or usage error, 3 transport error.
 */
async function main(argv) {
  let options;
  try {
    options = parseCommand(argv);
    if (options.help) {
      console.log(helpText());
      return EXIT_SUCCESS;
    }
  } catch (error) {
    // Argument errors are the only failures that print the usage block.
    writeArgumentError(error);
    return EXIT_USAGE_ERROR;
  }

  try {
    let response = await requestMarkdownApi(options);
    if (options.wait && response.status !== "already-parsed") {
      response = await waitForParse(options, response);
    }
    if (options.plain) {
      stripInlineTags(response);
    }
    if (options.outputPath) {
      writeContentFile(options, response);
    }
    const envelope = createSuccessEnvelope(options, response);
    if (options.format === "json") {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      console.log(formatTextSuccess(options, response));
    }
    // An awaited parse that failed, was stopped or timed out is not a success.
    return response.waited && response.status !== "succeeded"
      ? EXIT_API_ERROR
      : EXIT_SUCCESS;
  } catch (error) {
    const envelope = createErrorEnvelope(options, error);
    if (options.format === "json") {
      console.log(JSON.stringify(envelope, null, 2));
    } else {
      console.error(formatTextError(envelope));
    }
    // HTTP 4xx/5xx errors arrive as an API envelope; everything else is a
    // transport failure (connection refused, timeout, non-JSON response).
    return envelope.status >= 400 && envelope.status < 600
      ? EXIT_API_ERROR
      : EXIT_TRANSPORT_ERROR;
  }
}

/**
 * Parses subcommands and flag values into a normalized request description.
 */
function parseCommand(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    return { help: true };
  }

  const [command, ...rest] = argv;
  const validCommands = new Set([
    "search",
    "markdown",
    "libraries",
    "collections",
    "tags",
    "status",
    "parse",
    "tasks",
  ]);
  if (!validCommands.has(command)) {
    throw new CliArgumentError(`Unknown command: ${command}`);
  }

  const flags = parseFlags(rest);
  const format = getFlag(flags, "--format", DEFAULT_FORMAT);
  if (!VALID_FORMATS.has(format)) {
    throw new CliArgumentError("Invalid --format. Expected text or json.");
  }

  const listenPort = resolveListenPort(flags);
  const baseUrl = createBaseUrl(listenPort);
  const timeoutMs = parsePositiveInteger(
    getFlag(flags, "--timeout-ms", String(DEFAULT_TIMEOUT_MS)),
    "--timeout-ms",
  );

  if (command === "libraries" || command === "tasks") {
    return {
      command,
      endpoint: command === "tasks" ? TASKS_ENDPOINT : LIBRARIES_ENDPOINT,
      listenPort,
      baseUrl,
      format,
      timeoutMs,
      params: {},
    };
  }

  const libraryID = getRequiredFlag(flags, "--library-id");
  parseInteger(libraryID, "--library-id");

  if (command === "collections") {
    const params = { libraryID };
    addOptionalParam(params, "parentKey", getFlag(flags, "--parent-key"));
    return {
      command,
      endpoint: COLLECTIONS_ENDPOINT,
      listenPort,
      baseUrl,
      format,
      timeoutMs,
      params,
    };
  }

  if (command === "tags") {
    const params = { libraryID };
    const limit = getFlag(flags, "--limit");
    if (limit !== undefined) {
      parsePositiveInteger(limit, "--limit");
      params.limit = limit;
    }
    return {
      command,
      endpoint: TAGS_ENDPOINT,
      listenPort,
      baseUrl,
      format,
      timeoutMs,
      params,
    };
  }

  if (command === "status") {
    const params = {
      libraryID,
      collection: getRequiredFlag(flags, "--collection").trim(),
    };
    if (flags.has("--include-subcollections")) {
      params.includeSubcollections = "true";
    }
    return {
      command,
      endpoint: STATUS_ENDPOINT,
      listenPort,
      baseUrl,
      format,
      timeoutMs,
      params,
    };
  }

  if (command === "search") {
    return {
      command,
      endpoint: SEARCH_ENDPOINT,
      listenPort,
      baseUrl,
      format,
      timeoutMs,
      params: parseSearchParams(flags, libraryID),
    };
  }

  const key = getRequiredFlag(flags, "--key");
  if (command === "parse") {
    const params = { libraryID, key };
    addOptionalParam(
      params,
      "attachmentKey",
      getFlag(flags, "--attachment-key"),
    );
    if (flags.has("--force")) {
      params.force = "true";
    }
    return {
      command,
      method: "POST",
      endpoint: PARSE_ENDPOINT,
      listenPort,
      baseUrl,
      format,
      timeoutMs,
      params,
      wait: flags.has("--wait"),
      waitTimeoutMs: parsePositiveInteger(
        getFlag(flags, "--wait-timeout-ms", String(DEFAULT_WAIT_TIMEOUT_MS)),
        "--wait-timeout-ms",
      ),
      pollIntervalMs: parsePositiveInteger(
        getFlag(flags, "--poll-interval-ms", String(DEFAULT_POLL_INTERVAL_MS)),
        "--poll-interval-ms",
      ),
    };
  }

  const granularity = getFlag(flags, "--granularity", "full");
  if (!VALID_GRANULARITIES.has(granularity)) {
    throw new CliArgumentError(
      "Invalid --granularity. Expected full, headings, section, search, or locate.",
    );
  }

  const params = {
    libraryID,
    key,
    granularity,
  };
  addOptionalParam(params, "attachmentKey", getFlag(flags, "--attachment-key"));
  addOptionalParam(params, "sectionPath", getFlag(flags, "--section-path"));
  addOptionalParam(params, "q", getFlag(flags, "--query"));
  if (flags.has("--include-subsections")) {
    params.includeSubsections = "true";
  }

  const contextParagraphs = getFlag(flags, "--context-paragraphs");
  if (contextParagraphs !== undefined) {
    parseInteger(contextParagraphs, "--context-paragraphs");
    params.contextParagraphs = contextParagraphs;
  }

  const output = getFlag(flags, "--output");
  if (output !== undefined && granularity !== "full") {
    throw new CliArgumentError("--output requires --granularity full.");
  }

  return {
    command,
    endpoint: MARKDOWN_ENDPOINT,
    listenPort,
    baseUrl,
    format,
    timeoutMs,
    params,
    ...(output === undefined ? {} : { outputPath: resolve(output) }),
    plain: flags.has("--plain"),
  };
}

/**
 * Removes inline HTML tags (`CO<sub>2</sub>` becomes `CO2`) from the text of
 * a Markdown response. Heading titles and paths stay as they are, because
 * `--section-path` must match them exactly.
 */
function stripInlineTags(data) {
  const strip = (value) =>
    typeof value === "string" ? value.replace(INLINE_HTML_TAG, "") : value;
  const stripAll = (value) => (Array.isArray(value) ? value.map(strip) : value);

  data.content = strip(data.content);
  if (Array.isArray(data.matches)) {
    data.matches = data.matches.map((match) => ({
      ...match,
      hit: strip(match.hit),
      context: strip(match.context),
      ...(match.before === undefined ? {} : { before: stripAll(match.before) }),
      ...(match.after === undefined ? {} : { after: stripAll(match.after) }),
    }));
  }
}

/**
 * Writes the full Markdown of a response to `--output` and replaces it in the
 * response with the file path, so the paper does not also go to stdout.
 */
function writeContentFile(options, data) {
  const content = typeof data.content === "string" ? data.content : "";
  try {
    writeFileSync(options.outputPath, content, "utf8");
  } catch (error) {
    throw new NetworkError(
      `Could not write ${options.outputPath}: ${error?.message ?? error}`,
    );
  }
  delete data.content;
  data.outputPath = options.outputPath;
  data.outputCharacters = content.length;
}

/**
 * Parses flags that use the `--flag value` shape.
 * Boolean switch flags are accepted with or without a following value.
 */
function parseFlags(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith("--")) {
      throw new CliArgumentError(`Unexpected argument: ${name}`);
    }
    if (name === "--help") {
      flags.set(name, "true");
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, "true");
      continue;
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliArgumentError(`Missing value for option: ${name}`);
    }
    flags.set(name, value);
    index += 1;
  }
  return flags;
}

/**
 * Builds the search request parameters, requiring at least one search filter.
 */
function parseSearchParams(flags, libraryID) {
  const title = getFlag(flags, "--title");
  const creator = getFlag(flags, "--creator");
  const collection = getFlag(flags, "--collection");
  const tag = getFlag(flags, "--tag");
  const abstract = getFlag(flags, "--abstract");
  const publication = getFlag(flags, "--publication");
  const citekey = getFlag(flags, "--citekey");
  const doi = getFlag(flags, "--doi");
  const itemType = getFlag(flags, "--item-type");
  const since = getFlag(flags, "--since");
  const year = getFlag(flags, "--year");
  const hasPdf = flags.has("--has-pdf");
  const parsedOnly = flags.has("--parsed-only");
  const sortBy = getFlag(flags, "--sort-by");
  const sortOrder = getFlag(flags, "--sort-order");
  const limit = getFlag(flags, "--limit");

  const hasAnyFilter =
    hasValue(title) ||
    hasValue(creator) ||
    hasValue(collection) ||
    hasValue(tag) ||
    hasValue(abstract) ||
    hasValue(publication) ||
    hasValue(citekey) ||
    hasValue(doi) ||
    hasValue(itemType) ||
    hasValue(since) ||
    hasValue(year) ||
    hasPdf ||
    parsedOnly ||
    hasValue(sortBy) ||
    hasValue(limit);

  if (!hasAnyFilter) {
    throw new CliArgumentError("Missing required option: --title or --creator");
  }

  const params = { libraryID };
  if (hasValue(title)) params.title = title.trim();
  if (hasValue(creator)) params.creator = creator.trim();
  if (hasValue(collection)) params.collection = collection.trim();
  if (hasValue(tag)) params.tag = tag.trim();
  if (hasValue(abstract)) params.abstract = abstract.trim();
  if (hasValue(publication)) params.publication = publication.trim();
  if (hasValue(citekey)) params.citekey = citekey.trim();
  if (hasValue(doi)) params.doi = doi.trim();
  if (hasValue(itemType)) params.itemType = itemType.trim();
  if (hasValue(since)) params.since = since.trim();

  if (hasPdf) params.hasPdf = "true";
  if (parsedOnly) params.parsedOnly = "true";

  if (year !== undefined) {
    const normalizedYear = year.trim();
    if (!YEAR_PATTERN.test(normalizedYear)) {
      throw new CliArgumentError(
        "Invalid --year. Expected a four-digit year such as 2022.",
      );
    }
    params.year = normalizedYear;
  }

  if (sortBy !== undefined) {
    if (!VALID_SORT_BY.has(sortBy)) {
      throw new CliArgumentError(
        "Invalid --sort-by. Expected dateAdded, dateModified, title, or year.",
      );
    }
    params.sortBy = sortBy;
  }

  if (sortOrder !== undefined) {
    if (!VALID_SORT_ORDER.has(sortOrder.toLowerCase())) {
      throw new CliArgumentError("Invalid --sort-order. Expected asc or desc.");
    }
    params.sortOrder = sortOrder.toLowerCase();
  }

  if (limit !== undefined) {
    parsePositiveInteger(limit, "--limit");
    params.limit = limit;
  }

  return params;
}

/**
 * Returns true when a flag value is present and non-blank.
 */
function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Fetches JSON from the local Zotero Markdown query API.
 * The API is gated only by the plugin's enable switch, so requests are sent
 * without an Authorization header.
 */
async function requestMarkdownApi(options) {
  const url = new URL(options.endpoint, options.baseUrl);
  for (const [key, value] of Object.entries(options.params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      signal: controller.signal,
    });
    const payload = await parseJsonResponse(response);
    warnOnVersionMismatch(payload);
    if (!response.ok) {
      throw new ApiError(response.status, payload);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new NetworkError(`Request timed out after ${options.timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Polls the task list until the parse of `parse --wait` ends or the wait
 * times out. Returns the parse response with the final `status` (a task
 * status, or `wait-timeout`), the last task summary and `waited: true`.
 */
async function waitForParse(options, submitted) {
  const tasksOptions = {
    ...options,
    method: "GET",
    endpoint: TASKS_ENDPOINT,
    params: {},
  };
  const deadline = Date.now() + options.waitTimeoutMs;
  let task;
  for (;;) {
    const tasks = (await requestMarkdownApi(tasksOptions)).tasks;
    task = (Array.isArray(tasks) ? tasks : []).find(
      (candidate) =>
        candidate.key === submitted.key &&
        String(candidate.libraryID) === String(options.params.libraryID),
    );
    // A record last touched before this request is the previous parse of the
    // same PDF, seen before Zotero has reset it.
    const isCurrent =
      task && (task.updatedAt ?? Infinity) >= (submitted.submittedAt ?? 0);
    if (isCurrent && FINISHED_TASK_STATUSES.has(task.status)) {
      return { ...submitted, status: task.status, task, waited: true };
    }
    if (Date.now() + options.pollIntervalMs > deadline) {
      return {
        ...submitted,
        status: "wait-timeout",
        ...(isCurrent ? { task } : {}),
        waited: true,
      };
    }
    await new Promise((done) => setTimeout(done, options.pollIntervalMs));
  }
}

/**
 * Prints a one-line stderr warning when the plugin and this CLI were built for
 * different API versions. The installed skill is a copy, so either side can be
 * the stale one.
 */
function warnOnVersionMismatch(payload) {
  const pluginApi = payload?.apiVersion;
  if (pluginApi === API_VERSION) {
    return;
  }
  const plugin = payload?.pluginVersion ? ` ${payload.pluginVersion}` : "";
  if (!Number.isInteger(pluginApi) || pluginApi < API_VERSION) {
    const reported = Number.isInteger(pluginApi)
      ? `API v${pluginApi}`
      : "no API version reported";
    console.error(
      `Warning: the MinerU for Zotero plugin${plugin} (${reported}) is older than this CLI (API v${API_VERSION}); update the plugin, some commands may fail.`,
    );
    return;
  }
  console.error(
    `Warning: this CLI (API v${API_VERSION}) is older than the plugin${plugin} (API v${pluginApi}); run "npm run skill:install" in the plugin repository to update the skill.`,
  );
}

/**
 * Parses an HTTP response body as JSON and reports malformed responses clearly.
 */
async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new NetworkError(
      `API returned non-JSON response with status ${response.status}`,
    );
  }
}

/**
 * Creates the stable JSON envelope for successful API responses.
 */
function createSuccessEnvelope(options, data) {
  return {
    ok: true,
    request: createRequestSummary(options),
    status: 200,
    data,
  };
}

/**
 * Creates the stable JSON envelope for API, network, and argument errors.
 */
function createErrorEnvelope(options, error) {
  if (error instanceof ApiError) {
    const { error: code, message, ...details } = error.payload;
    // The version fields describe the plugin, not this error.
    delete details.pluginVersion;
    delete details.apiVersion;
    return {
      ok: false,
      request: createRequestSummary(options),
      status: error.status,
      error: {
        code: code || "api-error",
        message: message || "API request failed",
        details,
      },
    };
  }

  return {
    ok: false,
    request: createRequestSummary(options),
    status: 0,
    error: {
      code: "network-error",
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  };
}

/**
 * Builds the request summary embedded in JSON envelopes.
 */
function createRequestSummary(options) {
  return {
    command: options.command,
    listenPort: options.listenPort,
    baseUrl: options.baseUrl,
    endpoint: options.endpoint,
    params: options.params,
  };
}

/**
 * Formats successful API payloads as direct agent-readable text.
 */
function formatTextSuccess(options, data) {
  if (options.command === "search") {
    return formatSearchText(options, data);
  }
  if (options.command === "libraries") {
    return formatLibrariesText(options, data);
  }
  if (options.command === "collections") {
    return formatCollectionsText(options, data);
  }
  if (options.command === "tags") {
    return formatTagsText(options, data);
  }
  if (options.command === "status") {
    return formatStatusText(options, data);
  }
  if (options.command === "parse") {
    return formatParseText(options, data);
  }
  if (options.command === "tasks") {
    return formatTasksText(data);
  }
  return formatMarkdownText(options, data);
}

/**
 * Formats libraries list.
 */
function formatLibrariesText(options, data) {
  const libraries = Array.isArray(data.libraries) ? data.libraries : [];
  const lines = ["Zotero Libraries", `Count: ${libraries.length}`];

  libraries.forEach((lib, index) => {
    lines.push(
      "",
      `${index + 1}. ${valueOrUnknown(lib.name)}`,
      `   libraryID: ${valueOrUnknown(lib.libraryID)}`,
      `   type: ${valueOrUnknown(lib.type)}`,
    );
  });

  return lines.join("\n");
}

/**
 * Formats collections list.
 */
function formatCollectionsText(options, data) {
  const collections = Array.isArray(data.collections) ? data.collections : [];
  const lines = [
    "Zotero Collections",
    `Library: ${options.params?.libraryID ?? "unknown"}`,
    `Collections: ${collections.length}`,
  ];

  collections.forEach((col, index) => {
    lines.push(
      "",
      `${index + 1}. ${valueOrUnknown(col.name)}`,
      `   id: ${valueOrUnknown(col.id)}`,
      `   key: ${valueOrUnknown(col.key)}`,
    );
    if (col.parentKey) {
      lines.push(`   parentKey: ${col.parentKey}`);
    }
  });

  return lines.join("\n");
}

/**
 * Formats tags list.
 */
function formatTagsText(options, data) {
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const lines = [
    "Zotero Tags",
    `Library: ${options.params?.libraryID ?? "unknown"}`,
    `Tags: ${tags.length}`,
    "",
  ];

  if (tags.length === 0) {
    lines.push("(none)");
  } else {
    tags.forEach((tagItem) => {
      const countStr =
        tagItem.numItems !== undefined ? ` (${tagItem.numItems} items)` : "";
      lines.push(`- ${tagItem.tag}${countStr}`);
    });
  }

  return lines.join("\n");
}

/**
 * Formats the answer to a parse request, with the next step for each status.
 */
function formatParseText(options, data) {
  const nextSteps = {
    submitted:
      "Parsing runs in Zotero. Check it with the tasks command, or run parse with --wait.",
    "already-parsed":
      "A result for the current PDF exists, so nothing was submitted. Read it with the markdown command; pass --force only to parse it again (uses MinerU quota).",
    "already-running":
      "This PDF is already being parsed. Check it with the tasks command.",
    succeeded: "The result is ready. Read it with the markdown command.",
    failed: "The parse failed; see the error above.",
    cancelled: "The parse was stopped in Zotero.",
    "wait-timeout":
      "Still not finished when the wait ended. The parse keeps running in Zotero; check it with the tasks command.",
  };
  const lines = [
    "Parse Request",
    `Library: ${options.params.libraryID}`,
    `Attachment: ${valueOrUnknown(data.key)}`,
    `Status: ${valueOrUnknown(data.status)}`,
  ];
  if (data.task) {
    lines.push(...formatTaskDetails(data.task, ""));
  }
  if (nextSteps[data.status]) {
    lines.push("", nextSteps[data.status]);
  }
  return lines.join("\n");
}

/**
 * Formats the parse task list.
 */
function formatTasksText(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const lines = ["MinerU Parse Tasks", `Tasks: ${tasks.length}`];

  tasks.forEach((task, index) => {
    lines.push(
      "",
      `${index + 1}. ${valueOrUnknown(task.title)}`,
      `   id: ${valueOrUnknown(task.id)}`,
      `   key: ${valueOrUnknown(task.key)} (library ${valueOrUnknown(task.libraryID)})`,
      `   status: ${valueOrUnknown(task.status)}`,
      ...formatTaskDetails(task, "   "),
    );
  });

  return lines.join("\n");
}

/**
 * Formats the progress, detail and error lines of a task summary.
 */
function formatTaskDetails(task, indent) {
  const lines = [];
  if (task.progress !== undefined && task.progress !== null) {
    lines.push(`${indent}progress: ${task.progress}%`);
  }
  if (task.detail) {
    lines.push(`${indent}detail: ${task.detail}`);
  }
  if (task.error) {
    lines.push(`${indent}error: ${task.error}`);
  }
  return lines;
}

/**
 * Formats a collection status report: one line per item, grouped by whether
 * the item can be read now.
 */
function formatStatusText(options, data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const attachmentsOf = (item) =>
    Array.isArray(item.attachments) ? item.attachments : [];
  const isParsed = (attachment) =>
    attachment.state === "precise" || attachment.state === "lite";
  const groups = [
    ["Parsed", items.filter((item) => attachmentsOf(item).some(isParsed))],
    [
      "Not parsed",
      items.filter(
        (item) =>
          attachmentsOf(item).length > 0 && !attachmentsOf(item).some(isParsed),
      ),
    ],
    ["No PDF", items.filter((item) => attachmentsOf(item).length === 0)],
  ];
  const totals = data.totals ?? {};
  const lines = [
    "Collection Parse Status",
    `Library: ${options.params.libraryID}`,
    `Collection: ${valueOrUnknown(data.collection ?? options.params.collection)}${
      data.includeSubcollections ? " (with subcollections)" : ""
    }`,
    `Items: ${totals.items ?? items.length} | parsed: ${
      totals.parsed ?? groups[0][1].length
    } | not parsed: ${totals.notParsed ?? groups[1][1].length} | no PDF: ${
      totals.noPdf ?? groups[2][1].length
    }`,
    "Line format: itemKey | first creator, year | title | attachmentKey state words",
  ];

  for (const [label, group] of groups) {
    lines.push("", `[${label}] ${group.length}`);
    for (const item of group) {
      const byline = [item.firstCreator, item.year].filter(Boolean).join(", ");
      const attachments = attachmentsOf(item)
        .map((attachment) =>
          [
            valueOrUnknown(attachment.key),
            valueOrUnknown(attachment.state),
            attachment.words === undefined ? "" : `${attachment.words} words`,
          ]
            .filter(Boolean)
            .join(" "),
        )
        .join("; ");
      lines.push(
        `- ${[
          valueOrUnknown(item.key),
          byline || "unknown",
          valueOrUnknown(item.title),
          ...(attachments ? [attachments] : []),
        ].join(" | ")}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Formats title search candidates.
 */
function formatSearchText(options, data) {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const lines = [
    "Markdown Query Search",
    `Library: ${options.params.libraryID}`,
    `Candidates: ${candidates.length}`,
  ];

  candidates.forEach((candidate, index) => {
    const item = candidate.item ?? {};
    const attachments = Array.isArray(candidate.attachments)
      ? candidate.attachments
      : [];
    lines.push(
      "",
      `${index + 1}. ${valueOrUnknown(item.title)}`,
      `   itemID: ${valueOrUnknown(item.itemID)}`,
      `   key: ${valueOrUnknown(item.key)}`,
      `   type: ${valueOrUnknown(item.type)}`,
    );
    if (item.year !== undefined && item.year !== null && item.year !== "") {
      lines.push(`   year: ${item.year}`);
    }
    const creators = Array.isArray(item.creators) ? item.creators : [];
    if (creators.length > 0) {
      lines.push(`   creators: ${creators.join("; ")}`);
    }
    if (item.itemType) {
      lines.push(`   itemType: ${item.itemType}`);
    }
    if (item.publication) {
      lines.push(`   publication: ${item.publication}`);
    }
    if (item.citekey) {
      lines.push(`   citekey: ${item.citekey}`);
    }
    if (item.doi) {
      lines.push(`   doi: ${item.doi}`);
    }
    lines.push("   attachments:");

    if (attachments.length === 0) {
      lines.push("   - none");
      return;
    }

    for (const attachment of attachments) {
      lines.push(
        `   - ${valueOrUnknown(attachment.fileName)}`,
        `     itemID: ${valueOrUnknown(attachment.itemID)}`,
        `     key: ${valueOrUnknown(attachment.key)}`,
        `     parsed: precise=${yesNo(attachment.preciseReady)} lite=${yesNo(
          attachment.liteReady,
        )}`,
      );
    }
  });

  return lines.join("\n");
}

/**
 * Formats Markdown query responses according to their granularity.
 */
function formatMarkdownText(options, data) {
  const lines = [
    "Markdown Query Result",
    `Library: ${options.params.libraryID}`,
    `Item: ${valueOrUnknown(data.item?.key ?? options.params.key)}`,
    `Attachment: ${formatAttachment(data.attachment)}`,
    `Title: ${valueOrUnknown(data.item?.title)}`,
    `Granularity: ${valueOrUnknown(data.granularity ?? options.params.granularity)}`,
    `Mode: ${valueOrUnknown(data.result?.mode)}`,
    "",
  ];

  const granularity = data.granularity ?? options.params.granularity;
  if (granularity === "headings") {
    lines.push("[Headings]", ...formatHeadings(data.headings));
  } else if (granularity === "section") {
    lines.push(...formatSection(data));
  } else if (granularity === "search") {
    lines.push(...formatSearchMatches(data));
  } else if (granularity === "locate") {
    lines.push(...formatLocateMatches(data));
  } else if (data.outputPath) {
    lines.push(
      "[Content]",
      `Written to ${data.outputPath} (${data.outputCharacters} characters)`,
    );
  } else {
    lines.push("[Content]", data.content ?? "");
  }

  return lines.join("\n");
}

/**
 * Formats heading records as a compact path list.
 */
function formatHeadings(headings) {
  if (!Array.isArray(headings) || headings.length === 0) {
    return ["(none)"];
  }

  return headings.flatMap((heading) => [
    `- ${"#".repeat(Number(heading.level) || 1)} ${valueOrUnknown(
      heading.title,
    )}`,
    `  path: ${formatPath(heading.path)}`,
    `  line: ${valueOrUnknown(heading.line)}`,
  ]);
}

/**
 * Formats a single Markdown section response.
 */
function formatSection(data) {
  return [
    "[Section]",
    `Heading: ${valueOrUnknown(data.heading?.title)}`,
    `Path: ${formatPath(data.heading?.path)}`,
    `Line: ${valueOrUnknown(data.heading?.line)}`,
    "",
    data.content ?? "",
  ];
}

/**
 * Formats paragraph search matches with highlighted hit paragraphs.
 */
function formatSearchMatches(data) {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const lines = [
    `Query: ${valueOrUnknown(data.query)}`,
    `Matches: ${matches.length}`,
  ];

  matches.forEach((match, index) => {
    lines.push(
      "",
      `[Match ${index + 1}]`,
      `Paragraph: ${match.paragraphIndex}`,
    );
    const before = Array.isArray(match.before) ? match.before : [];
    const after = Array.isArray(match.after) ? match.after : [];
    for (const paragraph of before) {
      lines.push("", paragraph);
    }
    lines.push("", `>> ${valueOrUnknown(match.hit)}`);
    for (const paragraph of after) {
      lines.push("", paragraph);
    }
  });

  return lines;
}

/**
 * Formats precise layout box matches indicating physical page numbers.
 */
function formatLocateMatches(data) {
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const lines = [
    `Query: ${valueOrUnknown(data.query)}`,
    `Matches: ${matches.length}`,
  ];

  matches.forEach((match, index) => {
    lines.push(
      "",
      `[Match ${index + 1}]`,
      `Page: ${match.page}`,
      `Type: ${match.type}`,
    );
    if (match.context) {
      lines.push("", "Context:", match.context);
    }
  });

  return lines;
}

/**
 * Formats API and network errors for direct agent reading.
 */
function formatTextError(envelope) {
  const lines = [
    `Error: ${envelope.error.code}`,
    `Message: ${envelope.error.message}`,
    `HTTP Status: ${envelope.status}`,
  ];
  const hint = hintForError(envelope.error.code);
  if (hint) {
    lines.push("", `Hint: ${hint}`);
  }
  const candidates = envelope.error.details?.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    lines.push("", "Candidates:");
    for (const candidate of candidates) {
      lines.push(
        `- ${valueOrUnknown(candidate.fileName)} key=${valueOrUnknown(
          candidate.key,
        )} score=${valueOrUnknown(candidate.score)}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * Returns a short next-step hint for common API errors.
 */
function hintForError(code) {
  const hints = {
    "api-disabled": "Enable the Markdown query API in Zotero preferences.",
    "ambiguous-attachment":
      "Pass --attachment-key with one of the candidate keys.",
    "collection-not-found":
      "Run the collections command and pass an exact collection name or key.",
    "parse-result-not-found":
      "Start a parse with the parse command (uses the user's MinerU quota), or choose another attachment with --attachment-key.",
    "section-not-found":
      "Run with --granularity headings first and use an exact heading path.",
    "missing-query": "Pass a non-empty --query value.",
    "network-error":
      "Zotero may not be running, or the API is unreachable. Start Zotero and retry, or pass --port if it listens on a non-default port.",
  };
  return hints[code];
}

/**
 * Writes argument errors together with concise usage guidance.
 */
function writeArgumentError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("");
  console.error(helpText());
}

/**
 * Returns CLI usage text.
 */
function helpText() {
  return [
    "Usage:",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs libraries [--port <number>] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs collections --library-id <id> [--parent-key <key>] [--port <number>] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs tags --library-id <id> [--limit <n>] [--port <number>] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs search --library-id <id> [--title <text>] [--creator <text>] [--collection <name|key>] [--tag <tag>] [--abstract <text>] [--publication <text>] [--citekey <key>] [--doi <doi>] [--item-type <type>] [--since <date>] [--year YYYY] [--has-pdf] [--parsed-only] [--sort-by dateAdded|dateModified|title|year] [--sort-order asc|desc] [--limit <n>] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs status --library-id <id> --collection <name|key> [--include-subcollections] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs markdown --library-id <id> --key <key> [--granularity full|headings|section|search|locate] [--plain] [--output <file>] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs parse --library-id <id> --key <key> [--attachment-key <key>] [--force] [--wait] [--format text|json]",
    "  node mineru-for-zotero-cli/scripts/query-markdown.mjs tasks [--format text|json]",
    "",
    "Common options:",
    "  --port <number>              Zotero local server port. Default: auto-detect from Zotero profile, then 23119",
    "  --format <text|json>         Output format. Default: text",
    "  --timeout-ms <number>        Request timeout. Default: 30000",
    "",
    "Search options:",
    "  --title <text>               Title substring to match",
    "  --creator <text>             Creator substring to match",
    "  --collection <name|key>      Collection name or key to filter",
    "  --tag <tag>                  Exact tag filter",
    "  --abstract <text>            Abstract substring to match",
    "  --publication <text>         Publication or conference title to match",
    "  --citekey <key>              Citation key substring to match",
    "  --doi <doi>                  DOI substring to match",
    "  --item-type <type>           Item type filter (e.g. journalArticle, conferencePaper)",
    "  --since <date>               Filter items added on or after date (YYYY-MM-DD)",
    "  --year <YYYY>                Four-digit year filter applied after search",
    "  --has-pdf                    Only return items with at least one PDF attachment",
    "  --parsed-only                Only return items with available MinerU parse results",
    "  --sort-by <field>            Sort by dateAdded, dateModified, title, or year",
    "  --sort-order <asc|desc>      Sort direction (default: desc)",
    "  --limit <n>                  Maximum number of candidates to return",
    "",
    "Status options:",
    "  --collection <name|key>      Collection to report on (required)",
    "  --include-subcollections     Also report items in its subcollections",
    "",
    "Markdown options:",
    "  --attachment-key <key>       Select a specific PDF attachment under a regular item.",
    "  --section-path <path>        Section path for granularity=section.",
    "  --include-subsections        Include same-level subsections in section output.",
    "  --query <text>               Search query for granularity=search or locate.",
    "  --context-paragraphs <n>     Context paragraphs for granularity=search or locate.",
    "  --plain                      Remove inline HTML tags such as <sub> and <sup> from the output.",
    "  --output <file>              With granularity=full, write the Markdown to a file instead of stdout.",
    "",
    "Parse options (parsing uses the user's MinerU quota):",
    "  --attachment-key <key>       Select a specific PDF attachment under a regular item.",
    "  --force                      Parse again even when a result for the current PDF exists.",
    "  --wait                       Wait until the parse ends; exit 1 unless it succeeded.",
    "  --wait-timeout-ms <number>   Longest wait for --wait. Default: 900000",
    "  --poll-interval-ms <number>  Delay between task checks for --wait. Default: 3000",
    "",
    "Exit codes:",
    "  0  Success",
    "  1  API error (HTTP 4xx/5xx error envelope), or a parse awaited with --wait did not succeed",
    "  2  Argument or usage error",
    "  3  Transport error (cannot reach Zotero: connection refused, timeout, or non-JSON response)",
  ].join("\n");
}

/**
 * Adds an optional API query parameter when a flag is present.
 */
function addOptionalParam(params, name, value) {
  if (value !== undefined) {
    params[name] = value;
  }
}

/**
 * Reads an optional parsed flag value.
 */
function getFlag(flags, name, defaultValue) {
  return flags.has(name) ? flags.get(name) : defaultValue;
}

/**
 * Reads a required parsed flag value.
 */
function getRequiredFlag(flags, name) {
  const value = getFlag(flags, name);
  if (value === undefined || value.trim() === "") {
    throw new CliArgumentError(`Missing required option: ${name}`);
  }
  return value;
}

/**
 * Parses an integer option for validation without changing API string output.
 */
function parseInteger(value, name) {
  if (!Number.isInteger(Number(value))) {
    throw new CliArgumentError(`Invalid integer for option: ${name}`);
  }
}

/**
 * Parses a positive integer option.
 */
function parsePositiveInteger(value, name) {
  parseInteger(value, name);
  const parsed = Number(value);
  if (parsed <= 0) {
    throw new CliArgumentError(`Invalid positive integer for option: ${name}`);
  }
  return parsed;
}

/**
 * Resolves the local Zotero listen port from CLI flags, profile prefs, or default.
 */
function resolveListenPort(flags) {
  const explicitPort = getFlag(flags, "--port");
  if (explicitPort !== undefined) {
    return parseListenPort(explicitPort, "--port");
  }

  return readZoteroListenPort() ?? DEFAULT_LISTEN_PORT;
}

/**
 * Parses and validates a TCP port value.
 */
function parseListenPort(value, name) {
  const port = parsePositiveInteger(value, name);
  if (port > 65535) {
    throw new CliArgumentError(`Invalid port for option: ${name}`);
  }
  return port;
}

/**
 * Creates the loopback base URL used by the Zotero local API.
 */
function createBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

/**
 * Reads Zotero's configured HTTP server port from the default profile prefs.
 */
function readZoteroListenPort() {
  const profileDir = findDefaultZoteroProfileDir();
  if (!profileDir) {
    return undefined;
  }

  const prefsPath = join(profileDir, "prefs.js");
  if (!existsSync(prefsPath)) {
    return undefined;
  }

  try {
    const prefs = readFileSync(prefsPath, "utf8");
    const match = prefs.match(
      /user_pref\("extensions\.zotero\.httpServer\.port",\s*(\d+)\);/,
    );
    if (!match) {
      return undefined;
    }
    return parseListenPort(match[1], "Zotero profile port");
  } catch {
    return undefined;
  }
}

/**
 * Locates the default Zotero profile directory from profiles.ini.
 */
function findDefaultZoteroProfileDir() {
  const configDir = getZoteroConfigDir();
  if (!configDir) {
    return undefined;
  }

  const profilesIniPath = join(configDir, "profiles.ini");
  if (!existsSync(profilesIniPath)) {
    return undefined;
  }

  try {
    const profiles = parseProfilesIni(readFileSync(profilesIniPath, "utf8"));
    const profile =
      profiles.find((item) => item.Default === "1") ?? profiles[0];
    if (!profile?.Path) {
      return undefined;
    }

    return profile.IsRelative === "1"
      ? resolve(configDir, profile.Path)
      : resolve(profile.Path);
  } catch {
    return undefined;
  }
}

/**
 * Returns the platform-specific Zotero configuration directory.
 * ZOTERO_CONFIG_DIR overrides discovery for tests and portable setups.
 */
function getZoteroConfigDir() {
  if (process.env.ZOTERO_CONFIG_DIR) {
    return process.env.ZOTERO_CONFIG_DIR;
  }

  if (process.platform === "win32") {
    return process.env.APPDATA
      ? join(process.env.APPDATA, "Zotero", "Zotero")
      : undefined;
  }

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Zotero");
  }

  return join(homedir(), ".zotero", "zotero");
}

/**
 * Parses Firefox-style profile sections from a profiles.ini file.
 */
function parseProfilesIni(text) {
  const profiles = [];
  let currentProfile;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[(.+)]$/);
    if (sectionMatch) {
      currentProfile = sectionMatch[1].startsWith("Profile") ? {} : undefined;
      if (currentProfile) {
        profiles.push(currentProfile);
      }
      continue;
    }

    if (!currentProfile) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    currentProfile[line.slice(0, separatorIndex)] = line.slice(
      separatorIndex + 1,
    );
  }

  return profiles;
}

/**
 * Formats an attachment summary.
 */
function formatAttachment(attachment) {
  if (!attachment) {
    return "unknown";
  }
  return `${valueOrUnknown(attachment.key)} ${valueOrUnknown(attachment.fileName)}`;
}

/**
 * Formats a heading path.
 */
function formatPath(path) {
  if (Array.isArray(path)) {
    return path.join(" / ");
  }
  return valueOrUnknown(path);
}

/**
 * Formats booleans as yes/no strings.
 */
function yesNo(value) {
  return value ? "yes" : "no";
}

/**
 * Returns a readable fallback for missing response fields.
 */
function valueOrUnknown(value) {
  return value === undefined || value === null || value === ""
    ? "unknown"
    : String(value);
}

/**
 * Represents invalid command-line arguments.
 */
class CliArgumentError extends Error {}

/**
 * Represents an HTTP API error response.
 */
class ApiError extends Error {
  /**
   * Stores an HTTP API error status and parsed JSON payload.
   */
  constructor(status, payload) {
    super(payload?.message || `API request failed with status ${status}`);
    this.status = status;
    this.payload = payload && typeof payload === "object" ? payload : {};
  }
}

/**
 * Represents transport or response decoding failures.
 */
class NetworkError extends Error {}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
