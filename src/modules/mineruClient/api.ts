import { MinerURequestError } from "./errors";
import { errorMessage, responseErrorDetail } from "./http";
import type { FetchLike } from "./types";

/**
 * Generate MinerU V1 API authentication request headers.
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
 * Generate MinerU V1 JSON API request headers.
 */
export function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    ...authHeaders(apiKey),
    "Content-Type": "application/json",
  };
}

/**
 * Send an HTTP request and parse successful response as the specified JSON type.
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
 * Execute an HTTP request, uniformly converting network errors and non-2xx responses into MinerURequestError.
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
 * Resolve an upload_url returned by V1 to an absolute URL.
 */
export function resolveUploadURL(baseURL: string, uploadURL: string): string {
  if (/^https?:\/\//i.test(uploadURL)) {
    return uploadURL;
  }
  return `${baseURL}${uploadURL.startsWith("/") ? "" : "/"}${uploadURL}`;
}

/**
 * Merge upload headers: attach Bearer Token only when the upload URL is same-origin with the API,
 * avoiding leaking secrets to external presigned destinations.
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
 * Determine whether two HTTP(S) URLs are same-origin (scheme + host + effective port).
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
