import type { MinerUClient, MinerUClientFactoryOptions } from "./types";
import { createV1MinerUClient } from "./v1";

const ONLINE_BASE_URL = "https://mineru.net/api";
const LOCAL_BASE_URL = "http://127.0.0.1:8000";

/**
 * 根据当前 parse source 选择 MinerU V1 client 的 base URL。
 *
 * 官方远程与本地服务共用同一套 V1 endpoint，仅 base URL 与鉴权方式不同。
 */
export function createMinerUClientForSettings(
  options: MinerUClientFactoryOptions,
): MinerUClient {
  const baseURL =
    options.source === "local"
      ? (options.localApiBaseURL ?? LOCAL_BASE_URL)
      : (options.baseURL ?? ONLINE_BASE_URL);
  return createV1MinerUClient({
    ...options,
    baseURL,
    outputFormats: ["markdown", "middle_json", "zip"],
  });
}
