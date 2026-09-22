import { authHeaders, jsonHeaders, requestJson, requestOk } from "./api";
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
  xhrDownloadBinary,
  xhrUploadBinary,
} from "./http";
import { basename, normalizeBaseURL } from "./path";
import {
  readImagesFromZip,
  readMarkdownFromZip,
  readRawResultFromZip,
} from "./result";
import type { MinerUClient, MinerUClientOptions, ZipEntries } from "./types";
import { readZipWithFileFallback } from "./zip";

const DEFAULT_BASE_URL = "https://mineru.net/api";

/** Official MinerU v4 model versions. */
export type MinerUModelVersion = "pipeline" | "vlm";

export interface V4MinerUClientOptions extends MinerUClientOptions {
  modelVersion?: MinerUModelVersion;
}

interface V4Envelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface V4FileUrlsData {
  batch_id?: string;
  file_urls?: string[];
}

interface V4ExtractResultItem {
  file_name?: string;
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
}

interface V4ExtractResultsData {
  batch_id?: string;
  extract_result?: V4ExtractResultItem[];
}

/**
 * 创建官方 MinerU v4 精准解析 API client。
 *
 * 官方文档：https://mineru.net/apiManage/docs
 *
 * 本地文件流程（与 v1 的 uploads/parse jobs 不同）：
 *   POST /v4/file-urls/batch → 拿到 batch_id + 预签名上传链接
 *   PUT 字节（不带 Content-Type）
 *   轮询 GET /v4/extract-results/batch/{batch_id}
 *   下载 full_zip_url（zip 内含 full.md/layout.json/images）
 *
 * 之所以 online 走 v4：官方 v1 在转换 `middle_json`/`zip` 等输出格式时可能
 * 返回 `file_conversion_failed`，而文档化的 v4 稳定产出标准 zip。
 */
export function createV4MinerUClient(
  options: V4MinerUClientOptions,
): MinerUClient {
  const baseURL = normalizeBaseURL(options.baseURL ?? DEFAULT_BASE_URL);
  const modelVersion = options.modelVersion ?? "vlm";
  const request = options.fetch ?? createDefaultRequest();
  const readBinary = options.readBinary ?? readFileBytes;
  const fetchLikeUpload = fetchUploadBinary(request);
  const globalFetch = (
    globalThis as typeof globalThis & { fetch?: typeof fetch }
  ).fetch;
  // Pre-signed PUT to external object storage. Bare sandbox XHR can fail at the
  // cross-origin layer, so try the privileged global fetch (no Content-Type)
  // first, then Zotero.HTTP, then sandbox XHR.
  const uploadCandidates: Array<
    (url: string, body: Uint8Array) => Promise<Response>
  > = [];
  if (options.uploadBinary) {
    const upload = options.uploadBinary;
    uploadCandidates.push((url, body) => upload(url, body));
  } else if (options.fetch) {
    uploadCandidates.push((url, body) => fetchLikeUpload(url, body));
  } else {
    if (globalFetch) {
      uploadCandidates.push((url, body) =>
        globalFetch(url, { method: "PUT", body }),
      );
    }
    uploadCandidates.push((url, body) => fetchLikeUpload(url, body));
    uploadCandidates.push((url, body) => xhrUploadBinary(url, body));
  }
  const uploadBinary = async (
    url: string,
    body: Uint8Array,
  ): Promise<Response> => {
    let lastError: unknown;
    for (const candidate of uploadCandidates) {
      try {
        const response = await candidate(url, body);
        if (response.ok) {
          return response;
        }
        lastError = new MinerUTaskError(
          `MinerU v4 upload failed with status ${response.status}`,
        );
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new MinerUTaskError("MinerU v4 upload failed");
  };
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

  const requestV4 = async <T>(
    path: string,
    stage: string,
    init: RequestInit,
  ): Promise<T> => {
    const envelope = await requestJson<V4Envelope<T>>(
      request,
      `${baseURL}${path}`,
      stage,
      init,
    );
    if (envelope.code !== 0) {
      throw new MinerUTaskError(
        envelope.msg ||
          `MinerU v4 request failed (code ${envelope.code ?? "unknown"})`,
      );
    }
    return (envelope.data ?? {}) as T;
  };

  const fetchResults = (taskID: string, stage: string) =>
    requestV4<V4ExtractResultsData>(
      `/v4/extract-results/batch/${encodeURIComponent(taskID)}`,
      stage,
      { method: "GET", headers: authHeaders(options.apiKey) },
    );

  const downloadZip = async (url: string): Promise<ZipEntries> => {
    try {
      const response = await requestOk(
        () => downloadBinary(url),
        url,
        "download",
        { method: "GET" },
      );
      return await readZipWithFileFallback(
        await response.arrayBuffer(),
        "mineru-v4-result.zip",
      );
    } catch (primaryError) {
      try {
        const fallback = await downloadFileBytes(url);
        return fallback instanceof Map
          ? fallback
          : await readZipWithFileFallback(
              toArrayBuffer(fallback),
              "mineru-v4-result.zip",
            );
      } catch (fallbackError) {
        throw new MinerUTaskError(
          `${errorMessage(primaryError)}; fallback failed: ${errorMessage(
            fallbackError,
          )}`,
          { cause: primaryError },
        );
      }
    }
  };

  return {
    async submitPdf(filePath, submitOptions) {
      const fileEntry: Record<string, unknown> = { name: basename(filePath) };
      if (submitOptions?.pageRange) {
        fileEntry.page_ranges = submitOptions.pageRange;
      }
      const data = await requestV4<V4FileUrlsData>(
        "/v4/file-urls/batch",
        "upload",
        {
          method: "POST",
          headers: jsonHeaders(options.apiKey),
          body: JSON.stringify({
            files: [fileEntry],
            model_version: modelVersion,
          }),
        },
      );
      const batchID = data.batch_id;
      const uploadURL = data.file_urls?.[0];
      if (!batchID || !uploadURL) {
        throw new MinerUTaskError(
          "MinerU v4 upload response missing batch_id or file_urls",
        );
      }
      const bytes = normalizeBinary(await readPdfBytes(readBinary, filePath));
      // The upload URL is pre-signed object storage: never send the MinerU
      // API key, and do not set a Content-Type header (per the official docs).
      await requestOk(
        () => uploadBinary(uploadURL, bytes),
        uploadURL,
        "upload",
        { method: "PUT" },
      );
      return { taskID: batchID };
    },

    async pollTask(taskID) {
      const results = await fetchResults(taskID, "poll");
      const item = results.extract_result?.[0];
      const state = String(item?.state ?? "").toLowerCase();
      if (state === "done") {
        return { status: "succeeded" };
      }
      if (state === "failed") {
        return {
          status: "failed",
          error: item?.err_msg || "MinerU v4 task failed",
        };
      }
      return { status: "running" };
    },

    async downloadResult(taskID) {
      const results = await fetchResults(taskID, "download");
      const item = results.extract_result?.[0];
      if (String(item?.state ?? "").toLowerCase() === "failed") {
        throw new MinerUTaskError(item?.err_msg || "MinerU v4 task failed");
      }
      const zipURL = item?.full_zip_url;
      if (!zipURL) {
        throw new MinerUTaskError("MinerU v4 result missing full_zip_url");
      }
      const zip = await downloadZip(zipURL);
      const markdown = readMarkdownFromZip(zip);
      const rawResult = readRawResultFromZip(zip);
      const images = readImagesFromZip(zip);
      if (rawResult == null || typeof rawResult !== "object") {
        return { kind: "lite", markdown };
      }
      return { kind: "precise", rawResult, markdown, images };
    },
  };
}

/**
 * 生成独立 ArrayBuffer，供 ZIP 回退解析使用。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
