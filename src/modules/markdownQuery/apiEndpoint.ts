import {
  getMarkdownApiEnabled,
  getMarkdownApiRequireToken,
  getMarkdownApiToken,
} from "../../utils/prefs";
import { getMinerUStorageRoot } from "../preferenceScript";
import { createStorage } from "../storage";
import {
  createMarkdownQueryService,
  MarkdownQueryService,
} from "./queryService";
import { MarkdownQueryError, ZoteroItemLike } from "./types";
import type { ItemSearchInput } from "./types";

interface MarkdownEndpointRequest {
  method: "GET" | "POST";
  pathname: string;
  searchParams?: URLSearchParams;
  query: Record<string, string>;
  headers: Record<string, string>;
  data: unknown;
}

export const MARKDOWN_ENDPOINT_PATHS = [
  "/mineru-for-zotero/search",
  "/mineru-for-zotero/markdown",
  "/mineru-for-zotero/parse",
  "/mineru-for-zotero/tasks",
  "/mineru-for-zotero/libraries",
  "/mineru-for-zotero/collections",
  "/mineru-for-zotero/tags",
] as const;

/**
 * 注册 Markdown 查询 HTTP endpoint，供外部本地客户端调用。
 */
export function registerMarkdownQueryApiEndpoint(): void {
  const service = createMarkdownQueryService({
    items: Zotero.Items,
    storage: createStorage(getMinerUStorageRoot()),
    searchItems,
  });
  const EndpointClass = createMarkdownQueryEndpointClass(service);

  for (const path of MARKDOWN_ENDPOINT_PATHS) {
    Zotero.Server.Endpoints[path] = toZoteroEndpoint(EndpointClass);
  }
}

/**
 * 卸载 Markdown 查询 HTTP endpoint，避免插件停用后残留路由。
 */
export function unregisterMarkdownQueryApiEndpoint(): void {
  for (const path of MARKDOWN_ENDPOINT_PATHS) {
    delete Zotero.Server.Endpoints[path];
  }
}

/**
 * 创建同时处理标题检索与 Markdown 读取的 endpoint 实例。
 */
export function createMarkdownQueryEndpoint(service: MarkdownQueryService) {
  return {
    supportedMethods: ["GET", "POST"],
    async init(options: MarkdownEndpointRequest) {
      try {
        const query = getQuery(options);
        authorize(query, options.headers);
        let payload;
        if (options.pathname === "/mineru-for-zotero/search") {
          payload = await service.searchByTitle({
            libraryID: requireInteger(query.libraryID, "libraryID"),
            ...pickDefined({
              title: optionalString(query.title),
              creator: optionalString(query.creator),
              year: parseYearParam(query.year),
              tag: optionalString(query.tag),
              collection: optionalString(query.collection),
              abstract: optionalString(query.abstract),
              publication: optionalString(query.publication),
              citekey: optionalString(query.citekey),
              doi: optionalString(query.doi),
              itemType: optionalString(query.itemType),
              since: optionalString(query.since),
              hasPdf: parseOptionalBoolean(query.hasPdf),
              parsedOnly: parseOptionalBoolean(query.parsedOnly),
              sortBy: parseSortBy(query.sortBy),
              sortOrder: parseSortOrder(query.sortOrder),
              limit: parseOptionalLimit(query.limit),
            }),
          });
        } else if (options.pathname === "/mineru-for-zotero/libraries") {
          payload = await service.getLibraries();
        } else if (options.pathname === "/mineru-for-zotero/collections") {
          payload = await service.getCollections({
            libraryID: requireInteger(query.libraryID, "libraryID"),
            parentKey: optionalString(
              query.parentKey || query.parentCollectionKey,
            ),
          });
        } else if (options.pathname === "/mineru-for-zotero/tags") {
          payload = await service.getTags({
            libraryID: requireInteger(query.libraryID, "libraryID"),
            limit: parseOptionalLimit(query.limit),
          });
        } else if (options.pathname === "/mineru-for-zotero/parse") {
          if (options.method !== "POST")
            throw new MarkdownQueryError(
              "invalid-request",
              405,
              "Method not allowed",
            );
          payload = await service.triggerParse({
            libraryID: requireInteger(query.libraryID, "libraryID"),
            key: requireString(query.key, "key"),
            attachmentKey: optionalString(query.attachmentKey),
          });
        } else if (options.pathname === "/mineru-for-zotero/tasks") {
          payload = await service.getTasks();
        } else {
          payload = await service.queryMarkdown({
            libraryID: requireInteger(query.libraryID, "libraryID"),
            key: requireString(query.key, "key"),
            attachmentKey: optionalString(query.attachmentKey),
            granularity: optionalString(query.granularity) as
              | "full"
              | "headings"
              | "section"
              | "search"
              | undefined,
            sectionPath: parseSectionPath(query.sectionPath),
            includeSubsections: parseOptionalBoolean(query.includeSubsections),
            q: optionalString(query.q),
            contextParagraphs: parseOptionalInteger(query.contextParagraphs),
          });
        }

        return json(200, payload);
      } catch (error) {
        return jsonError(error);
      }
    },
  };
}

/**
 * 创建 Zotero.Server.Endpoints 需要的可构造 endpoint class。
 */
export function createMarkdownQueryEndpointClass(
  service: MarkdownQueryService,
) {
  const endpoint = createMarkdownQueryEndpoint(service);

  return class MarkdownQueryEndpoint {
    supportedMethods = endpoint.supportedMethods;

    /**
     * 代理到共享 endpoint 逻辑，保持测试和运行时行为一致。
     */
    init(options: MarkdownEndpointRequest) {
      return endpoint.init(options);
    }
  };
}

/**
 * 将 promise-style endpoint 对象适配到 zotero-types 当前的 endpoint 注册类型。
 */
function toZoteroEndpoint(
  EndpointClass: ReturnType<typeof createMarkdownQueryEndpointClass>,
) {
  return EndpointClass as unknown as typeof _ZoteroTypes.Server.Endpoint;
}

/**
 * 通过 Zotero.Search 按标题、创作者、分类等条件模糊检索库内条目。
 */
async function searchItems(input: ItemSearchInput): Promise<ZoteroItemLike[]> {
  const search = new Zotero.Search({ libraryID: input.libraryID });
  if (input.title) {
    search.addCondition("title", "contains", input.title);
  }
  if (input.creator) {
    search.addCondition("creator", "contains", input.creator);
  }
  if (input.tag) {
    search.addCondition("tag", "is", input.tag);
  }
  if (input.abstract) {
    search.addCondition("abstractNote", "contains", input.abstract);
  }
  if (input.publication) {
    search.addCondition("publicationTitle", "contains", input.publication);
  }
  if (input.doi) {
    search.addCondition("DOI", "contains", input.doi);
  }
  if (input.itemType) {
    search.addCondition("itemType", "is", input.itemType);
  }
  if (input.collection) {
    const col = resolveCollection(input.libraryID, input.collection);
    if (col) {
      search.addCondition("collectionID", "is", col.id);
    }
  }

  const ids = await search.search();
  let items = await Zotero.Items.getAsync(ids);

  if (input.year) {
    items = items.filter((item) => itemMatchesYear(item, input.year!));
  }
  if (input.citekey) {
    const targetKey = input.citekey.toLowerCase();
    items = items.filter((item) => {
      const extra = item.getField("extra") || "";
      const match = /Citation Key:\s*([^\s\n]+)/i.exec(extra);
      if (match && match[1].toLowerCase().includes(targetKey)) {
        return true;
      }
      try {
        const fieldKey = item.getField("citationKey");
        if (fieldKey && fieldKey.toLowerCase().includes(targetKey)) {
          return true;
        }
      } catch {
        // ignore
      }
      return false;
    });
  }
  if (input.since) {
    const sinceDate = input.since.trim();
    items = items.filter((item) => {
      const added = item.dateAdded || item.getField("dateAdded") || "";
      return added.startsWith(sinceDate) || added >= sinceDate;
    });
  }
  if (input.hasPdf) {
    const itemAttachments = await Promise.all(
      items.map(async (item) => {
        if (item.isPDFAttachment()) return { item, hasPdf: true };
        const attIds = item.getAttachments(false);
        if (!attIds || attIds.length === 0) return { item, hasPdf: false };
        const atts = await Zotero.Items.getAsync(attIds);
        return { item, hasPdf: atts.some((a) => a.isPDFAttachment()) };
      }),
    );
    items = itemAttachments.filter((x) => x.hasPdf).map((x) => x.item);
  }

  if (input.sortBy) {
    const order = input.sortOrder === "asc" ? 1 : -1;
    items.sort((a, b) => {
      let valA = "";
      let valB = "";
      if (input.sortBy === "dateAdded") {
        valA = a.dateAdded || a.getField("dateAdded") || "";
        valB = b.dateAdded || b.getField("dateAdded") || "";
      } else if (input.sortBy === "dateModified") {
        valA = a.dateModified || a.getField("dateModified") || "";
        valB = b.dateModified || b.getField("dateModified") || "";
      } else if (input.sortBy === "year") {
        valA = a.getField("date") || "";
        valB = b.getField("date") || "";
      } else if (input.sortBy === "title") {
        valA = a.getDisplayTitle() || a.getField("title") || "";
        valB = b.getDisplayTitle() || b.getField("title") || "";
      }
      return valA.localeCompare(valB) * order;
    });
  }

  if (input.limit !== undefined) {
    items = items.slice(0, input.limit);
  }
  return items;
}

function resolveCollection(
  libraryID: number,
  collectionParam: string,
): { id: number; key: string } | undefined {
  if (
    typeof Zotero === "undefined" ||
    !(Zotero as any).Collections?.getByLibrary
  ) {
    return undefined;
  }
  if ((Zotero as any).Collections.getByLibraryAndKey) {
    const byKey = (Zotero as any).Collections.getByLibraryAndKey(
      libraryID,
      collectionParam,
    );
    if (byKey) return byKey;
  }
  const cols = (Zotero as any).Collections.getByLibrary(libraryID);
  if (Array.isArray(cols)) {
    const target = collectionParam.toLowerCase();
    const matched = cols.find(
      (c: any) =>
        String(c.key).toLowerCase() === target ||
        String(c.name).toLowerCase() === target,
    );
    return matched;
  }
  return undefined;
}

/**
 * 判断条目 date 字段是否以指定四位年份开头。
 */
function itemMatchesYear(item: ZoteroItemLike, year: string): boolean {
  return (item.getField("date") ?? "").trim().startsWith(year);
}

/**
 * 校验 API 开关与 token，支持 Bearer 和 query token 两种来源。
 */
function authorize(
  query: Record<string, string>,
  headers: Record<string, string>,
): void {
  if (!getMarkdownApiEnabled()) {
    throw new MarkdownQueryError(
      "api-disabled",
      403,
      "Markdown query API is disabled",
    );
  }
  if (!getMarkdownApiRequireToken()) {
    return;
  }

  const expected = getMarkdownApiToken();
  const provided = getBearerToken(headers) || optionalString(query.token) || "";
  if (!expected || provided !== expected) {
    throw new MarkdownQueryError("invalid-token", 403, "Invalid API token");
  }
}

/**
 * 兼容单元测试中的 query 字典和 Zotero 运行时传入的 searchParams。
 */
function getQuery(options: MarkdownEndpointRequest): Record<string, string> {
  if (options.searchParams) {
    return Object.fromEntries(options.searchParams.entries());
  }
  return options.query;
}

/**
 * 从 Authorization header 提取 Bearer token。
 */
function getBearerToken(headers: Record<string, string>): string {
  const header = headers.authorization ?? headers.Authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? "";
}

/**
 * 读取必填字符串参数，并在缺失时抛出标准请求错误。
 */
function requireString(value: string | undefined, name: string): string {
  const text = optionalString(value);
  if (!text) {
    throw new MarkdownQueryError(
      "invalid-request",
      400,
      `Missing required parameter: ${name}`,
    );
  }
  return text;
}

/**
 * 读取必填整数参数，并拒绝非整数值。
 */
function requireInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new MarkdownQueryError(
      "invalid-request",
      400,
      `Invalid integer parameter: ${name}`,
    );
  }
  return parsed;
}

/**
 * 清理可选字符串参数，空白值会被视为未提供。
 */
function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 去掉值为 undefined 的字段，保持注入边界上的参数形状干净。
 */
function pickDefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * 解析可选年份参数，必须是恰好四位的数字字符串。
 */
function parseYearParam(value: string | undefined): string | undefined {
  const text = optionalString(value);
  if (text === undefined) {
    return undefined;
  }
  if (!/^\d{4}$/.test(text)) {
    throw new MarkdownQueryError(
      "invalid-request",
      400,
      `Invalid year parameter: ${text}`,
    );
  }
  return text;
}

/**
 * 解析可选正整数 limit 参数，非法值直接拒绝。
 */
function parseOptionalLimit(value: string | undefined): number | undefined {
  const parsed = parseOptionalInteger(value);
  if (parsed !== undefined && parsed <= 0) {
    throw new MarkdownQueryError(
      "invalid-request",
      400,
      `Invalid positive integer parameter: ${value}`,
    );
  }
  return parsed;
}

/**
 * 解析可选排序字段。
 */
function parseSortBy(
  value: string | undefined,
): "dateAdded" | "dateModified" | "title" | "year" | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  if (["dateAdded", "dateModified", "title", "year"].includes(text)) {
    return text as "dateAdded" | "dateModified" | "title" | "year";
  }
  throw new MarkdownQueryError(
    "invalid-request",
    400,
    `Invalid sortBy parameter: ${text}`,
  );
}

/**
 * 解析可选排序方向。
 */
function parseSortOrder(value: string | undefined): "asc" | "desc" | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  const lower = text.toLowerCase();
  if (lower === "asc" || lower === "desc") {
    return lower;
  }
  throw new MarkdownQueryError(
    "invalid-request",
    400,
    `Invalid sortOrder parameter: ${text}`,
  );
}

/**
 * 解析可选布尔参数，仅接受 true/1 为真值。
 */
function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const text = optionalString(value);
  if (text === undefined) {
    return undefined;
  }
  return text === "true" || text === "1";
}

/**
 * 解析可选整数参数，非法值交给下游默认逻辑处理。
 */
function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * 允许 sectionPath 以 JSON 数组、slash path 或单值字符串形式传入。
 */
function parseSectionPath(
  value: string | undefined,
): string[] | string | undefined {
  const text = optionalString(value);
  if (!text) {
    return undefined;
  }
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (
        Array.isArray(parsed) &&
        parsed.every((part) => typeof part === "string")
      ) {
        return parsed;
      }
    } catch {
      // 保持回退到字符串路径解析。
    }
  }

  const parts = text
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : text;
}

/**
 * 生成标准 JSON HTTP 响应。
 */
function json(code: number, payload: unknown) {
  return [code, "application/json", JSON.stringify(payload)] as const;
}

/**
 * 将领域错误映射为稳定的 JSON 错误响应。
 */
function jsonError(error: unknown) {
  if (error instanceof MarkdownQueryError) {
    return json(error.status, {
      error: error.code,
      message: error.message,
      ...(typeof error.details === "object" && error.details
        ? (error.details as Record<string, unknown>)
        : {}),
    });
  }

  logUnexpectedError(error);
  return json(500, {
    error: "internal-error",
    message: "Unexpected internal error",
  });
}

/**
 * 将未知内部异常写入 Zotero debug，但不影响测试环境或 HTTP 响应。
 */
function logUnexpectedError(error: unknown): void {
  const debug = (
    globalThis as unknown as {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug;
  if (typeof debug !== "function") {
    return;
  }

  const detail =
    error instanceof Error
      ? (error.stack ?? error.message)
      : String(error ?? "Unknown error");
  debug(`[MinerU] Markdown query API internal error: ${detail}`);
}
