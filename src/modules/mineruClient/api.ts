import { MinerURequestError } from "./errors";
import { errorMessage, responseErrorDetail } from "./http";
import type { FetchLike } from "./types";

/**
 * 生成 MinerU V1 API 鉴权请求头。
 */
export function authHeaders(apiKey: string): Record<string, string> {
  if (!apiKey.trim()) {
    return {};
  }
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * 生成 MinerU V1 JSON API 请求头。
 */
export function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    ...authHeaders(apiKey),
    "Content-Type": "application/json",
  };
}

/**
 * 发送 HTTP 请求并把成功响应解析为指定 JSON 类型。
 */
export async function requestJson<T>(
  request: FetchLike,
  url: string,
  stage: string,
  init: RequestInit,
): Promise<T> {
  const response = await requestOk(request, url, stage, init);
  return (await response.json()) as T;
}

/**
 * 执行 HTTP 请求，统一把网络异常和非 2xx 响应转换为 MinerURequestError。
 */
export async function requestOk(
  request: FetchLike,
  url: string,
  stage: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await request(url, init);
  } catch (error) {
    throw new MinerURequestError(stage, 0, errorMessage(error));
  }
  if (!response.ok) {
    throw new MinerURequestError(
      stage,
      response.status,
      await responseErrorDetail(response),
    );
  }
  return response;
}

/**
 * 将 V1 返回的 upload_url 解析为绝对地址。
 */
export function resolveUploadURL(baseURL: string, uploadURL: string): string {
  if (/^https?:\/\//i.test(uploadURL)) {
    return uploadURL;
  }
  return `${baseURL}${uploadURL.startsWith("/") ? "" : "/"}${uploadURL}`;
}

/**
 * 合并上传头：仅当上传地址与 API 同源时才附加 Bearer Token，
 * 避免把密钥泄露给外部预签名地址。
 */
export function sameOriginUploadHeaders(
  baseURL: string,
  uploadURL: string,
  uploadHeaders: Record<string, string> | undefined,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = { ...(uploadHeaders ?? {}) };
  if (isSameOrigin(baseURL, uploadURL)) {
    Object.assign(headers, authHeaders(apiKey));
  }
  return headers;
}

/**
 * 判断两个 HTTP(S) 地址是否同源（scheme + host + effective port）。
 */
export function isSameOrigin(left: string, right: string): boolean {
  const a = parseOrigin(left);
  const b = parseOrigin(right);
  return (
    a != null &&
    b != null &&
    a.scheme === b.scheme &&
    a.host === b.host &&
    a.port === b.port
  );
}

function parseOrigin(
  value: string,
): { scheme: string; host: string; port: number } | null {
  try {
    const url = new URL(value);
    const port =
      url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return {
      scheme: url.protocol.toLowerCase(),
      host: url.hostname.toLowerCase(),
      port,
    };
  } catch {
    return null;
  }
}
