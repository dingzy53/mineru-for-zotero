import type { MinerUClient, MinerUClientFactoryOptions } from "./types";
import { createV1MinerUClient } from "./v1";
import { createV4MinerUClient } from "./v4";

const ONLINE_BASE_URL = "https://mineru.net/api";
const LOCAL_BASE_URL = "http://127.0.0.1:8000";

/**
 * Select a MinerU client based on parse source.
 *
 * - `online`: Official documented v4 precise parsing API (`/v4/file-urls/batch`, etc.).
 * - `local`: Self-hosted MinerU 4.0 V1 API (`/v1/parse/jobs`).
 *
 * The official cloud should not be routed through V1: its output format conversion may return
 * `file_conversion_failed`, while v4 reliably produces standard zips containing markdown/layout.json/images.
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
