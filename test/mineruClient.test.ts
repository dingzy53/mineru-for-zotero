import { assert } from "chai";
import {
  createMinerUClientForSettings,
  createV1MinerUClient,
  MinerUTaskError,
} from "../src/modules/mineruClient";
import { fallbackDownloadBinary } from "../src/modules/mineruClient/http";
import { extractJobError } from "../src/modules/mineruClient/v1";

const ONLINE_BASE = "https://mineru.net/api";
const LOCAL_BASE = "http://127.0.0.1:8000";

interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordCall(
  calls: RecordedCall[],
  url: string,
  init: RequestInit | undefined,
): RecordedCall {
  const call: RecordedCall = {
    method: init?.method ?? "GET",
    url: String(url),
    headers: toHeaderRecord(init?.headers),
    body: init?.body,
  };
  calls.push(call);
  return call;
}

function toHeaderRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

function healthResponse(sources: string[]): Response {
  return jsonResponse({
    status: "ok",
    features: {
      webhook: false,
      sources,
      output_formats: ["markdown", "middle_json", "structured_content", "zip"],
    },
  });
}

describe("mineruClient (V1)", function () {
  it("uses the official V1 base URL for online parsing", async function () {
    const calls: RecordedCall[] = [];
    const client = createMinerUClientForSettings({
      source: "online",
      apiKey: "secret-token",
      tier: "standard",
      readBinary: async () => new Uint8Array([37, 80, 68, 70]),
      fetch: async (url, init) => {
        const call = recordCall(calls, url, init);
        if (call.url.endsWith("/v1/health")) {
          return healthResponse(["file_id", "url"]);
        }
        if (call.url.endsWith("/v1/uploads")) {
          return jsonResponse({
            id: "upload_1",
            status: "pending",
            upload_url: "https://upload.example/u/1",
            upload_method: "PUT",
            upload_headers: {
              "Content-Type": "application/pdf",
              "x-amz-content-sha256": "abc",
            },
          });
        }
        if (call.url === "https://upload.example/u/1") {
          return new Response("", { status: 200 });
        }
        if (call.url.endsWith("/v1/uploads/upload_1/complete")) {
          return jsonResponse({ status: "completed", file: { id: "file-1" } });
        }
        if (call.url.endsWith("/v1/parse/jobs")) {
          return jsonResponse({ job_id: "job-1", status: "queued" }, 202);
        }
        throw new Error(`unexpected ${call.method} ${call.url}`);
      },
    });

    const result = await client.submitPdf("C:/tmp/a.pdf");

    assert.deepEqual(result, { taskID: "job-1" });
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].url, `${ONLINE_BASE}/v1/health`);

    const createUpload = calls.find((call) => call.url.endsWith("/v1/uploads"));
    assert.isDefined(createUpload);
    assert.equal(createUpload!.method, "POST");
    assert.equal(createUpload!.headers.Authorization, "Bearer secret-token");
    const uploadBody = JSON.parse(String(createUpload!.body));
    assert.equal(uploadBody.filename, "a.pdf");
    assert.equal(uploadBody.bytes, 4);
    assert.equal(uploadBody.mime_type, "application/pdf");
    assert.equal(uploadBody.purpose, "parse");
    assert.match(uploadBody.sha256sum, /^[0-9a-f]{64}$/);

    const upload = calls.find(
      (call) => call.url === "https://upload.example/u/1",
    );
    assert.isDefined(upload);
    assert.equal(upload!.method, "PUT");
    assert.equal(upload!.headers["Content-Type"], "application/pdf");
    assert.equal(upload!.headers["x-amz-content-sha256"], "abc");
    // The presigned host differs from the API origin, so the key must not leak.
    assert.isUndefined(upload!.headers.Authorization);

    const complete = calls.find((call) =>
      call.url.endsWith("/v1/uploads/upload_1/complete"),
    );
    assert.isDefined(complete);
    assert.equal(complete!.headers.Authorization, "Bearer secret-token");

    const job = calls.find((call) => call.url.endsWith("/v1/parse/jobs"));
    assert.isDefined(job);
    const jobBody = JSON.parse(String(job!.body));
    assert.deepEqual(jobBody.files, [
      { source: { type: "file_id", file_id: "file-1" } },
    ]);
    assert.equal(jobBody.tier, "standard");
    assert.includeMembers(jobBody.output_formats, [
      "markdown",
      "middle_json",
      "zip",
    ]);
  });

  it("uses the local source without uploading when health advertises it", async function () {
    const calls: RecordedCall[] = [];
    const client = createMinerUClientForSettings({
      source: "local",
      apiKey: "",
      tier: "basic",
      localApiBaseURL: LOCAL_BASE,
      readBinary: async () => new Uint8Array([37, 80, 68, 70]),
      fetch: async (url, init) => {
        const call = recordCall(calls, url, init);
        if (call.url.endsWith("/v1/health")) {
          return healthResponse(["file_id", "local"]);
        }
        if (call.url.endsWith("/v1/parse/jobs")) {
          return jsonResponse({ job_id: "job-local" }, 202);
        }
        throw new Error(`unexpected ${call.method} ${call.url}`);
      },
    });

    const result = await client.submitPdf("C:/tmp/a.pdf", {
      pageRange: "1-100",
    });

    assert.deepEqual(result, { taskID: "job-local" });
    assert.isEmpty(calls.filter((call) => call.url.includes("/v1/uploads")));
    const job = calls.find((call) => call.url.endsWith("/v1/parse/jobs"));
    const jobBody = JSON.parse(String(job!.body));
    assert.deepEqual(jobBody.files, [
      { source: { type: "local", path: "C:/tmp/a.pdf" }, page_range: "1-100" },
    ]);
    assert.equal(jobBody.tier, "basic");
  });

  it("adds auth to same-origin uploads only", async function () {
    const calls: RecordedCall[] = [];
    const client = createMinerUClientForSettings({
      source: "local",
      apiKey: "local-key",
      tier: "standard",
      localApiBaseURL: LOCAL_BASE,
      readBinary: async () => new Uint8Array([37, 80, 68, 70]),
      fetch: async (url, init) => {
        const call = recordCall(calls, url, init);
        if (call.url.endsWith("/v1/health")) {
          return healthResponse(["file_id"]);
        }
        if (call.url.endsWith("/v1/uploads")) {
          return jsonResponse({
            id: "upload_2",
            status: "pending",
            upload_url: "/v1/uploads/upload_2/content",
            upload_method: "PUT",
            upload_headers: { "Content-Type": "application/pdf" },
          });
        }
        if (call.url.endsWith("/v1/uploads/upload_2/content")) {
          return new Response("", { status: 200 });
        }
        if (call.url.endsWith("/v1/uploads/upload_2/complete")) {
          return jsonResponse({ file: { id: "file-2" } });
        }
        if (call.url.endsWith("/v1/parse/jobs")) {
          return jsonResponse({ job_id: "job-2" }, 202);
        }
        throw new Error(`unexpected ${call.method} ${call.url}`);
      },
    });

    await client.submitPdf("C:/tmp/a.pdf");

    const upload = calls.find((call) =>
      call.url.endsWith("/v1/uploads/upload_2/content"),
    );
    assert.isDefined(upload);
    assert.equal(upload!.url, `${LOCAL_BASE}/v1/uploads/upload_2/content`);
    assert.equal(upload!.headers.Authorization, "Bearer local-key");
  });

  it("reuses a deduplicated file without re-uploading", async function () {
    const calls: RecordedCall[] = [];
    const client = createMinerUClientForSettings({
      source: "online",
      apiKey: "secret-token",
      tier: "standard",
      readBinary: async () => new Uint8Array([37, 80, 68, 70]),
      fetch: async (url, init) => {
        const call = recordCall(calls, url, init);
        if (call.url.endsWith("/v1/health")) {
          return healthResponse(["file_id"]);
        }
        if (call.url.endsWith("/v1/uploads")) {
          return jsonResponse({
            status: "completed",
            file: { id: "file-dedup" },
          });
        }
        if (call.url.endsWith("/v1/parse/jobs")) {
          return jsonResponse({ job_id: "job-3" }, 202);
        }
        throw new Error(`unexpected ${call.method} ${call.url}`);
      },
    });

    await client.submitPdf("C:/tmp/a.pdf");

    assert.isEmpty(
      calls.filter(
        (call) => call.method === "PUT" || call.url.includes("/complete"),
      ),
    );
    const job = calls.find((call) => call.url.endsWith("/v1/parse/jobs"));
    const jobBody = JSON.parse(String(job!.body));
    assert.deepEqual(jobBody.files, [
      { source: { type: "file_id", file_id: "file-dedup" } },
    ]);
  });

  it("maps V1 job statuses to plugin statuses", async function () {
    const statuses: string[] = [];
    const client = createV1MinerUClient({
      apiKey: "k",
      baseURL: ONLINE_BASE,
      fetch: async (url, init) => {
        const value = String(url);
        if (value.endsWith("/v1/parse/jobs/job-x")) {
          const status = statuses.shift();
          if (status === "failed" || status === "partial") {
            return jsonResponse({
              status,
              files: [{ status: "failed", error: { message: "boom" } }],
            });
          }
          return jsonResponse({ status });
        }
        throw new Error(`unexpected ${String(url)}`);
      },
    });

    statuses.push("queued");
    assert.deepEqual(await client.pollTask("job-x"), { status: "running" });

    statuses.push("running");
    assert.deepEqual(await client.pollTask("job-x"), { status: "running" });

    statuses.push("completed");
    assert.deepEqual(await client.pollTask("job-x"), { status: "succeeded" });

    statuses.push("partial");
    assert.deepEqual(await client.pollTask("job-x"), {
      status: "failed",
      error: "boom",
    });
  });

  it("surfaces the MinerU job error code together with the message", function () {
    assert.equal(
      extractJobError({
        status: "failed",
        error: {
          code: "-60015",
          message: "convert failed, please try again later",
        },
      }),
      "convert failed, please try again later (-60015)",
    );
  });

  it("forwards authorization headers through the download fallback wrapper", async function () {
    const primaryCalls: Array<{
      url: string;
      headers?: Record<string, string>;
    }> = [];
    const fallbackCalls: Array<{
      url: string;
      headers?: Record<string, string>;
    }> = [];
    const downloadBinary = fallbackDownloadBinary(
      async (url, headers) => {
        primaryCalls.push({ url, headers });
        return new Response(new Uint8Array([1]), { status: 200 });
      },
      async (url, headers) => {
        fallbackCalls.push({ url, headers });
        return new Response(new Uint8Array([2]), { status: 200 });
      },
    );

    await downloadBinary("https://mineru.net/api/v1/files/md/content", {
      Authorization: "Bearer secret",
    });

    assert.deepEqual(primaryCalls, [
      {
        url: "https://mineru.net/api/v1/files/md/content",
        headers: { Authorization: "Bearer secret" },
      },
    ]);
    assert.lengthOf(fallbackCalls, 0);
  });

  it("forwards authorization headers to the fallback downloader too", async function () {
    const fallbackCalls: Array<{
      url: string;
      headers?: Record<string, string>;
    }> = [];
    const downloadBinary = fallbackDownloadBinary(
      async () => {
        throw new Error("primary failed");
      },
      async (url, headers) => {
        fallbackCalls.push({ url, headers });
        return new Response(new Uint8Array([2]), { status: 200 });
      },
    );

    await downloadBinary("https://mineru.net/api/v1/files/md/content", {
      Authorization: "Bearer secret",
    });

    assert.deepEqual(fallbackCalls, [
      {
        url: "https://mineru.net/api/v1/files/md/content",
        headers: { Authorization: "Bearer secret" },
      },
    ]);
  });

  it("downloads markdown, middle json, and zip images for precise results", async function () {
    const middleJson = {
      schema: "docvortex.middle",
      schema_version: "2.0",
      pages: [
        {
          page_idx: 0,
          blocks: [
            {
              type: "image",
              index: 0,
              bbox: [0, 0, 0.5, 0.5],
              content: [
                {
                  type: "image_body",
                  index: 0,
                  bbox: [0, 0, 0.5, 0.5],
                  content: "",
                  image_path: "page_0_image_0.png",
                },
              ],
            },
          ],
        },
      ],
    };
    const zip = createStoredZipBytes({
      "markdown.md": "# Title",
      "middle_json.json": JSON.stringify(middleJson),
      "images/page_0_image_0.png": new Uint8Array([137, 80, 78, 71]),
    });

    const client = createV1MinerUClient({
      apiKey: "k",
      baseURL: ONLINE_BASE,
      fetch: async (url, init) => {
        const value = String(url);
        if (value.endsWith("/v1/parse/jobs/job-4")) {
          return jsonResponse({
            status: "completed",
            files: [
              {
                status: "completed",
                output_files: {
                  markdown: { file_id: "md" },
                  middle_json: { file_id: "mj" },
                  zip: { file_id: "zip" },
                },
              },
            ],
          });
        }
        if (value.endsWith("/v1/files/md/content")) {
          return new Response("# Title from API", { status: 200 });
        }
        if (value.endsWith("/v1/files/mj/content")) {
          return new Response(JSON.stringify(middleJson), { status: 200 });
        }
        if (value.endsWith("/v1/files/zip/content")) {
          return new Response(zip, { status: 200 });
        }
        throw new Error(`unexpected ${String(url)}`);
      },
    });

    const result = await client.downloadResult("job-4");

    assert.equal(result.kind, "precise");
    if (result.kind !== "precise") {
      return;
    }
    assert.equal(result.markdown, "# Title from API");
    assert.deepEqual(result.rawResult, middleJson);
    assert.deepEqual(result.images, [
      { path: "page_0_image_0.png", bytes: new Uint8Array([137, 80, 78, 71]) },
    ]);
  });

  it("returns a lite result when only markdown is available", async function () {
    const client = createV1MinerUClient({
      apiKey: "k",
      baseURL: ONLINE_BASE,
      fetch: async (url) => {
        const value = String(url);
        if (value.endsWith("/v1/parse/jobs/job-5")) {
          return jsonResponse({
            status: "completed",
            files: [
              {
                status: "completed",
                output_files: { markdown: { file_id: "md" } },
              },
            ],
          });
        }
        if (value.endsWith("/v1/files/md/content")) {
          return new Response("# Only markdown", { status: 200 });
        }
        throw new Error(`unexpected ${String(url)}`);
      },
    });

    const result = await client.downloadResult("job-5");

    assert.deepEqual(result, { kind: "lite", markdown: "# Only markdown" });
  });

  it("throws a task error when the job fails to submit", async function () {
    const client = createV1MinerUClient({
      apiKey: "k",
      baseURL: ONLINE_BASE,
      readBinary: async () => new Uint8Array([1]),
      fetch: async (url) => {
        const value = String(url);
        if (value.endsWith("/v1/health")) {
          return healthResponse(["file_id"]);
        }
        if (value.endsWith("/v1/uploads")) {
          return jsonResponse({ status: "completed", file: { id: "f" } });
        }
        if (value.endsWith("/v1/parse/jobs")) {
          return jsonResponse({ status: "queued" }, 202);
        }
        throw new Error(`unexpected ${String(url)}`);
      },
    });

    let error: unknown;
    try {
      await client.submitPdf("C:/tmp/a.pdf");
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, MinerUTaskError);
    assert.match((error as Error).message, /missing job_id/);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createStoredZipBytes(
  files: Record<string, string | Uint8Array>,
): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const contentBytes =
      typeof content === "string" ? encoder.encode(content) : content;
    const crc = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const local = new DataView(localHeader.buffer);
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, contentBytes.length, true);
    local.setUint32(22, contentBytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const central = new DataView(centralHeader.buffer);
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(10, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, contentBytes.length, true);
    central.setUint32(24, contentBytes.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, contentBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + contentBytes.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, Object.keys(files).length, true);
  endView.setUint16(10, Object.keys(files).length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);

  return concatBytes([...localParts, ...centralParts, end]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
