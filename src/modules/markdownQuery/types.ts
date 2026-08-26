/**
 * Markdown Query API 使用的标准错误码集合。
 */
export type MarkdownQueryErrorCode =
  | "api-disabled"
  | "invalid-token"
  | "invalid-request"
  | "item-not-found"
  | "pdf-attachment-not-found"
  | "attachment-not-found"
  | "ambiguous-attachment"
  | "parse-result-not-found"
  | "section-not-found"
  | "ambiguous-section"
  | "missing-query"
  | "internal-error";

/**
 * 封装 Markdown Query API 的错误码、HTTP 状态与附加细节。
 */
export class MarkdownQueryError extends Error {
  constructor(
    public readonly code: MarkdownQueryErrorCode,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MarkdownQueryError";
  }
}

/**
 * 表示一个带层级路径信息的 Markdown 标题。
 */
export interface MarkdownHeading {
  level: number;
  title: string;
  path: string[];
  line: number;
}

/**
 * 表示按标题路径读取出的章节内容。
 */
export interface MarkdownSectionResult {
  heading: MarkdownHeading;
  content: string;
}

/**
 * 表示一个带前后文的 Markdown 段落搜索命中。
 */
export interface MarkdownSearchMatch {
  paragraphIndex: number;
  context: string;
  before: string[];
  hit: string;
  after: string[];
}

/**
 * Represents a match found within precise layout boxes, including page and bounding box details.
 */
export interface MarkdownLocateMatch {
  boxIndex: number;
  page: number;
  type: string;
  hit: string;
  context: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * 表示搜索条目时允许的组合条件。
 * title 与 creator 至少提供一个，其余条件可选。
 */
export interface ItemSearchInput {
  libraryID: number;
  title?: string;
  creator?: string;
  /** 四位年份，按条目 date 字段前缀过滤。 */
  year?: string;
  tag?: string;
  limit?: number;
}

/**
 * 表示 Zotero 创作者的最小视图，兼容单名字段。
 */
export interface CreatorLike {
  firstName?: string;
  lastName?: string;
  name?: string;
}

/**
 * 表示 Markdown Query API 解析附件时依赖的最小 Zotero item 视图。
 */
export interface ZoteroItemLike {
  id: number;
  key: string;
  libraryID: number;
  dateAdded?: string;
  attachmentFilename?: string;
  parentItemID?: number | false;
  isRegularItem(): boolean;
  isPDFAttachment(): boolean;
  getDisplayTitle(): string;
  getField(field: string): string;
  getAttachments(includeTrashed?: boolean): number[];
  getBestAttachments(): Promise<ZoteroItemLike[]>;
  getCreators?(): CreatorLike[];
}

/**
 * 表示 Attachment Resolver 读取 Zotero items 所需的最小网关接口。
 */
export interface ZoteroItemsGateway {
  getAsync(ids: number[]): Promise<ZoteroItemLike[]>;
  getByLibraryAndKeyAsync(
    libraryID: number,
    key: string,
  ): Promise<ZoteroItemLike | false>;
}

/**
 * 表示一个 PDF 附件候选项的评分与状态信息。
 */
export interface AttachmentCandidate {
  itemID: number;
  libraryID: number;
  key: string;
  fileName: string;
  preciseReady: boolean;
  liteReady: boolean;
  score: number;
  reasons: string[];
}

/**
 * 表示附件解析完成后的父条目、目标附件与可选候选列表。
 */
export interface ResolvedAttachment {
  item: ZoteroItemLike;
  attachment: ZoteroItemLike;
  candidates?: AttachmentCandidate[];
}

/**
 * 表示读取附件解析状态所需的最小存储接口。
 */
export interface ParseStatusReader {
  readParseStatus(ref: {
    libraryID: number;
    key: string;
  }): Promise<{ preciseReady: boolean; liteReady: boolean }>;
}

/**
 * 表示 Markdown 查询返回内容的粒度。
 */
export type MarkdownGranularity =
  | "full"
  | "headings"
  | "section"
  | "search"
  | "locate";

/**
 * 表示查询结果中的条目摘要信息。
 */
export interface ItemSummary {
  itemID: number;
  libraryID: number;
  key: string;
  type: "regular" | "attachment";
  title: string;
  /** 条目 date 字段中的四位年份，缺失时不输出。 */
  year?: string;
  /** 格式化后的创作者列表，缺失或为空时不输出。 */
  creators?: string[];
}

/**
 * 表示查询结果中的附件摘要信息。
 */
export interface AttachmentSummary {
  itemID: number;
  libraryID: number;
  key: string;
  fileName: string;
  preciseReady?: boolean;
  liteReady?: boolean;
}
