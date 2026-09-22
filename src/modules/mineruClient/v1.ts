import {
  authHeaders,
  jsonHeaders,
  requestJson,
  requestOk,
  resolveUploadURL,
  sameOriginUploadHeaders,
} from "./api";
import { zoteroDownloadFileBytes } from "./download";
import { MinerUTaskError } from "./errors";
import { readFileBytes, readPdfBytes } from "./file";
import {
  createDefaultRequest,
  errorMessage,
  fallbackDownloadBinary,
  fetchDownloadBinary,
  fetchUploadBinary,
  normalizeBinary,
  sha256Hex,
  xhrDownloadBinary,
  xhrUploadBinary,
} from "./http";
import type { MinerUImageFile } from "../domain";
import { basename, normalizeBaseURL } from "./path";
import { readImagesFromZip, readRawResultFromZip } from "./result";
import type {
  MinerUClient,
  MinerUClientOptions,
  MinerUOutputFormat,
  MinerUTier,
  V1Health,
  V1ParseJob,
  V1Upload,
  ZipEntries,
} from "./types";
import { decodeText, readZipWithFileFallback } from "./zip";

const DEFAULT_BASE_URL = "https://mineru.net/api";
const DEFAULT_OUTPUT_FORMATS: MinerUOutputFormat[] = [
  "markdown",
  "middle_json",
  "zip",
];

export interface V1MinerUClientOptions extends MinerUClientOptions {
  tier?: MinerUTier;
  outputFormats?: MinerUOutputFormat[];
  /**
   * 当服务端 /v1/health 声明支持 `local` source 时优先直接引用本地路径。
   * 默认允许；显式设为 false 可强制走上传流程。
   */
  useLocalSource?: boolean;
}

/**
 * 创建统一的 MinerU V1 API client，同时用于官方远程 API 和本地服务。
 *
 * 官方远程 base URL 为 `https://mineru.net/api`，本地为
 * `http://127.0.0.1:8000`；两者的 endpoint 与请求结构一致。
 */
export function createV1MinerUClient(
  options: V1MinerUClientOptions,
): MinerUClient {
  const baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
  const request = options.fetch ?? createDefaultRequest();
  const readBinary = options.readBinary ?? readFileBytes;
  const uploadBinary =
    options.uploadBinary ??
    (options.fetch ? fetchUploadBinary(request) : xhrUploadBinary);
  const downloadBinary =
    options.downloadBinary ??
    (options.fetch
      ? fetchDownloadBinary(request)
      : fallbackDownloadBinary(
          xhrDownloadBinary,
          fetchDownloadBinary(request),
        ));
  const downloadFileBytes =
    options.downloadFileBytes ?? zoteroDownloadFileBytes;
  const requestedFormats = options.outputFormats ?? DEFAULT_OUTPUT_FORMATS;
  const useLocalSource = options.useLocalSource !== false;

  let health: V1Health | null | undefined;
  let cachedFileID: string | null = null;

  const getHealth = async (): Promise<V1Health | null> => {
    if (health !== undefined) {
      return health;
    }
    try {
      health = await requestJson<V1Health>(
        request,
        `${baseURL}/v1/health`,
        "health",
        { method: "GET", headers: authHeaders(options.apiKey) },
      );
    } catch {
      health = null;
    }
    return health;
  };

  const effectiveOutputFormats = (value: V1Health | null) => {
    const supported = value?.features?.output_formats;
    if (!Array.isArray(supported)) {
      return requestedFormats;
    }
    const filtered = requestedFormats.filter((format) =>
      supported.includes(format),
    );
    return filtered.length > 0
      ? filtered
      : (["markdown"] as MinerUOutputFormat[]);
  };

  const ensureUploaded = async (filePath: string): Promise<string> => {
    if (cachedFileID) {
      return cachedFileID;
    }
    const bytes = normalizeBinary(await readPdfBytes(readBinary, filePath));
    const digest = await sha256Hex(bytes);
    const response = await requestJson<V1Upload>(
      request,
      `${baseURL}/v1/uploads`,
      "upload",
      {
        method: "POST",
        headers: jsonHeaders(options.apiKey),
        body: JSON.stringify({
          filename: basename(filePath),
          bytes: bytes.byteLength,
          mime_type: "application/pdf",
          purpose: "parse",
          ...(digest ? { sha256sum: digest } : {}),
        }),
      },
    );

    if (response.status === "completed" && response.file?.id) {
      cachedFileID = response.file.id;
      return cachedFileID;
    }

    const uploadURL = response.upload_url;
    if (!uploadURL || !response.id) {
      throw new MinerUTaskError("MinerU upload response missing upload_url");
    }

    const resolvedURL = resolveUploadURL(baseURL, uploadURL);
    const headers = sameOriginUploadHeaders(
      baseURL,
      resolvedURL,
      response.upload_headers,
      options.apiKey,
    );
    await requestOk(
      () => uploadBinary(resolvedURL, bytes, headers),
      resolvedURL,
      "upload",
      { method: "PUT" },
    );

    const completed = await requestJson<V1Upload>(
      request,
      `${baseURL}/v1/uploads/${encodeURIComponent(response.id)}/complete`,
      "upload",
      {
        method: "POST",
        headers: jsonHeaders(options.apiKey),
        body: JSON.stringify({}),
      },
    );
    const fileID = completed.file?.id;
    if (!fileID) {
      throw new MinerUTaskError(
        "MinerU upload completion response missing file id",
      );
    }
    cachedFileID = fileID;
    return fileID;
  };

  const resolveSource = async (filePath: string) => {
    const value = await getHealth();
    const sources = value?.features?.sources;
    if (useLocalSource && Array.isArray(sources) && sources.includes("local")) {
      return { type: "local", path: filePath };
    }
    const fileID = await ensureUploaded(filePath);
    return { type: "file_id", file_id: fileID };
  };

  const fetchJob = (taskID: string, stage: string) =>
    requestJson<V1ParseJob>(
      request,
      `${baseURL}/v1/parse/jobs/${encodeURIComponent(taskID)}`,
      stage,
      { method: "GET", headers: authHeaders(options.apiKey) },
    );

  const downloadOutputBytes = async (
    fileID: string,
    stage: string,
  ): Promise<Uint8Array> => {
    const url = `${baseURL}/v1/files/${encodeURIComponent(fileID)}/content`;
    let primaryError: unknown;
    try {
      const response = await requestOk(
        () => downloadBinary(url, authHeaders(options.apiKey)),
        url,
        stage,
        { method: "GET" },
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 0) {
        return bytes;
      }
      primaryError = new MinerUTaskError(
        "MinerU output download returned an empty response",
      );
    } catch (error) {
      primaryError = error;
    }

    try {
      const result = await downloadFileBytes(url);
      if (result instanceof Map) {
        throw new MinerUTaskError("Unexpected ZIP response for text output");
      }
      if (result.byteLength > 0) {
        return result;
      }
    } catch (fallbackError) {
      throw new MinerUTaskError(
        `${errorMessage(primaryError)}; fallback failed: ${errorMessage(fallbackError)}`,
        { cause: primaryError },
      );
    }

    throw primaryError instanceof Error
      ? primaryError
      : new MinerUTaskError("MinerU output download failed");
  };

  const downloadZip = async (fileID: string): Promise<ZipEntries> => {
    const url = `${baseURL}/v1/files/${encodeURIComponent(fileID)}/content`;
    let primaryError: unknown;
    try {
      const response = await requestOk(
        () => downloadBinary(url, authHeaders(options.apiKey)),
        url,
        "download",
        { method: "GET" },
      );
      return await readZipWithFileFallback(
        await response.arrayBuffer(),
        "mineru-v1-result.zip",
      );
    } catch (error) {
      primaryError = error;
    }

    try {
      const result = await downloadFileBytes(url);
      if (result instanceof Map) {
        return result;
      }
      return await readZipWithFileFallback(
        toArrayBuffer(result),
        "mineru-v1-result.zip",
      );
    } catch (fallbackError) {
      throw new MinerUTaskError(
        `${errorMessage(primaryError)}; fallback failed: ${errorMessage(fallbackError)}`,
        { cause: primaryError },
      );
    }
  };

  const downloadText = async (fileID: string, stage: string) =>
    decodeText(await downloadOutputBytes(fileID, stage));

  return {
    async submitPdf(filePath, submitOptions) {
      const source = await resolveSource(filePath);
      const value = await getHealth();
      const fileEntry: Record<string, unknown> = { source };
      if (submitOptions?.pageRange) {
        fileEntry.page_range = submitOptions.pageRange;
      }
      const payload: Record<string, unknown> = {
        files: [fileEntry],
        output_formats: effectiveOutputFormats(value),
      };
      if (options.tier) {
        payload.tier = options.tier;
      }
      const response = await requestJson<V1ParseJob>(
        request,
        `${baseURL}/v1/parse/jobs`,
        "submit",
        {
          method: "POST",
          headers: jsonHeaders(options.apiKey),
          body: JSON.stringify(payload),
        },
      );
      if (!response.job_id) {
        throw new MinerUTaskError("MinerU parse job response missing job_id");
      }
      return { taskID: response.job_id };
    },

    async pollTask(taskID) {
      const job = await fetchJob(taskID, "poll");
      return mapJobStatus(job);
    },

    async downloadResult(taskID) {
      const job = await fetchJob(taskID, "download");
      const status = mapJobStatus(job);
      if (status.status === "failed") {
        throw new MinerUTaskError(status.error || "MinerU task failed");
      }
      const outputs = job.files?.[0]?.output_files ?? {};
      const markdownRef = outputs.markdown?.file_id;
      const middleRef = outputs.middle_json?.file_id;
      const zipRef = outputs.zip?.file_id;

      let markdown = markdownRef
        ? await downloadText(markdownRef, "download")
        : "";
      let rawResult: unknown = null;
      let images: MinerUImageFile[] | undefined;

      if (zipRef) {
        const zip = await downloadZip(zipRef);
        rawResult = readRawResultFromZip(zip);
        images = readImagesFromZip(zip);
        if (!markdown) {
          markdown = readMarkdownFromZip(zip);
        }
      }

      if (middleRef) {
        const parsed = parseJson(await downloadText(middleRef, "download"));
        rawResult = parsed ?? rawResult;
      }

      if (rawResult == null || typeof rawResult !== "object") {
        return { kind: "lite", markdown };
      }

      return { kind: "precise", rawResult, markdown, images };
    },
  };
}

/**
 * 把 V1 job 状态映射为插件内部状态。
 */
export function mapJobStatus(job: V1ParseJob): {
  status: "running" | "succeeded" | "failed";
  error?: string;
} {
  const status = String(job.status ?? "").toLowerCase();
  if (status === "completed") {
    return { status: "succeeded" };
  }
  if (status === "partial") {
    return job.files?.some((file) => file.status === "completed")
      ? { status: "succeeded" }
      : { status: "failed", error: extractJobError(job) };
  }
  if (status === "failed" || status === "canceled") {
    return { status: "failed", error: extractJobError(job) };
  }
  return { status: "running" };
}

/**
 * 从 job 或文件级错误中提取可读消息。
 */
export function extractJobError(job: V1ParseJob): string {
  const fileError = job.files?.find((file) => file.error)?.error;
  const error = job.error ?? fileError;
  return (
    error?.message ||
    error?.code ||
    `MinerU job ended with status ${job.status ?? "unknown"}`
  );
}

/**
 * 从结果 ZIP 中读取 Markdown 正文。
 */
function readMarkdownFromZip(zip: ZipEntries): string {
  const entry =
    zip.get("markdown.md") ??
    zip.get("full.md") ??
    Array.from(zip.entries()).find(([name]) =>
      name.toLowerCase().endsWith(".md"),
    )?.[1];
  return entry ? decodeText(entry.bytes) : "";
}

/**
 * 解析 JSON 文本，失败时返回 null。
 */
function parseJson(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * 生成独立 ArrayBuffer，供 ZIP 回退解析使用。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
