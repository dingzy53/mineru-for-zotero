import type { MinerUImageFile } from "../domain";

export type MinerUParseSource = "online" | "local";
export type MinerUParseMode = "precise" | "lite";

/** MinerU 4 parse quality tiers. */
export type MinerUTier = "flash" | "basic" | "standard" | "advanced";

/** Supported V1 parse job output formats. */
export type MinerUOutputFormat =
  | "markdown"
  | "middle_json"
  | "structured_content"
  | "zip";

export type MinerUPreciseResult = {
  kind: "precise";
  rawResult: unknown;
  markdown: string;
  images?: MinerUImageFile[];
};

export type MinerULiteResult = {
  kind: "lite";
  markdown: string;
};

export type MinerUParseResult = MinerUPreciseResult | MinerULiteResult;

export interface MinerUClient {
  submitPdf(
    filePath: string,
    options?: { pageRange?: string },
  ): Promise<{ taskID: string }>;
  pollTask(taskID: string): Promise<{
    status: "running" | "succeeded" | "failed";
    error?: string;
  }>;
  downloadResult(taskID: string): Promise<MinerUParseResult>;
}

export interface MinerUClientOptions {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
  readBinary?: (filePath: string) => Promise<Uint8Array>;
  uploadBinary?: (
    url: string,
    body: Uint8Array,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  downloadBinary?: (
    url: string,
    headers?: Record<string, string>,
  ) => Promise<Response>;
  downloadFileBytes?: (url: string) => Promise<Uint8Array | ZipEntries>;
  downloadRetryDelayMs?: number;
  maxDownloadAttempts?: number;
}

export interface MinerUClientFactoryOptions extends MinerUClientOptions {
  source: MinerUParseSource;
  tier?: MinerUTier;
  localApiBaseURL?: string;
  saveImages?: boolean;
}

export type FetchLike = typeof fetch;

// ── MinerU V1 API models ────────────────────────────────────────────

export interface V1Health {
  status?: string;
  version?: string;
  features?: {
    webhook?: boolean;
    output_formats?: string[];
    sources?: string[];
  };
}

export interface V1FileObject {
  id?: string;
  object?: string;
  bytes?: number;
  filename?: string;
  purpose?: string;
  [key: string]: unknown;
}

export interface V1Upload {
  id?: string;
  object?: string;
  status?: string;
  upload_url?: string | null;
  upload_method?: string;
  upload_headers?: Record<string, string>;
  file?: V1FileObject;
  [key: string]: unknown;
}

export interface V1OutputFileRef {
  file_id?: string;
  bytes?: number;
}

export type V1OutputFiles = Partial<
  Record<MinerUOutputFormat, V1OutputFileRef>
>;

export interface V1ErrorDetail {
  type?: string;
  code?: string;
  message?: string;
  param?: string | null;
}

export interface V1JobFile {
  file_id?: string | null;
  name?: string;
  page_range?: string;
  status?: string;
  output_files?: V1OutputFiles;
  error?: V1ErrorDetail;
}

export interface V1ParseJob {
  job_id?: string;
  status?: string;
  output_formats?: string[];
  error?: V1ErrorDetail;
  files?: V1JobFile[];
  [key: string]: unknown;
}

export interface V1ErrorEnvelope {
  error?: V1ErrorDetail;
}

export type ZipEntry = {
  name: string;
  bytes: Uint8Array;
};

export type ZipEntries = Map<string, ZipEntry>;
