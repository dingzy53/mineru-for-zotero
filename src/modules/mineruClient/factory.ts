import type { MinerUClient, MinerUClientFactoryOptions } from "./types";
import { createV1MinerUClient } from "./v1";
import { createV4MinerUClient } from "./v4";

const ONLINE_BASE_URL = "https://mineru.net/api";
const LOCAL_BASE_URL = "http://127.0.0.1:8000";

/**
 * 根据 parse source 选择 MinerU client。
 *
 * - `online`：官方文档化的 v4 精准解析 API（`/v4/file-urls/batch` 等）。
 * - `local`：自托管 MinerU 4.0 的 V1 API（`/v1/parse/jobs`）。
 *
 * 官方云不宜用 V1：其输出格式转换可能返回 `file_conversion_failed`，而 v4
 * 稳定产出包含 markdown/layout.json/images 的标准 zip。
 */
export function createMinerUClientForSettings(
  options: MinerUClientFactoryOptions,
): MinerUClient {
  if (options.source === "local") {
    return createV1MinerUClient({
      ...options,
      baseURL: options.localApiBaseURL ?? LOCAL_BASE_URL,
      outputFormats: ["markdown", "middle_json", "zip"],
    });
  }
  return createV4MinerUClient({
    ...options,
    baseURL: options.baseURL ?? ONLINE_BASE_URL,
    modelVersion: "vlm",
  });
}
