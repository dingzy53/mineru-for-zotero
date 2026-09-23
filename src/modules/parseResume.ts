import { MinerUTaskError } from "./mineruClient";
import { toNativePath } from "./mineruClient/path";
import {
  taskStore,
  TaskChunkRecord,
  TaskRecord,
  TaskResumeRecord,
} from "./taskStore";
import { ParseMode, ParseSource } from "../utils/prefs";
import { mkdir, readdir, readFile, rm, writeFile, unlink } from "fs/promises";
import path from "path";

export function createTaskResume(
  existing: TaskResumeRecord | undefined,
  source: ParseSource,
  mode: ParseMode,
  localApiBaseURL: string,
  filePath: string,
  pdfMtime: number,
  pageCount: number,
  chunkSize: number,
  chunkCount: number,
): TaskResumeRecord {
  const expectedChunks = Array.from({ length: chunkCount }, (_, index) => ({
    index,
    startPage: index * chunkSize + 1,
    endPage: Math.min((index + 1) * chunkSize, pageCount),
  }));
  const canReuse =
    existing?.source === source &&
    existing.mode === mode &&
    existing.filePath === filePath &&
    existing.pdfMtime === pdfMtime &&
    existing.pageCount === pageCount &&
    existing.chunkSize === chunkSize &&
    existing.chunks.length === expectedChunks.length &&
    expectedChunks.every((expected) => {
      const actual = existing.chunks[expected.index];
      return (
        actual?.index === expected.index &&
        actual.startPage === expected.startPage &&
        actual.endPage === expected.endPage
      );
    });

  if (canReuse) {
    return {
      ...existing,
      localApiBaseURL,
      chunks: existing.chunks.map((chunk) => ({ ...chunk })),
    };
  }

  return {
    source,
    mode,
    localApiBaseURL,
    filePath,
    pdfMtime,
    pageCount,
    chunkSize,
    chunks: expectedChunks.map(
      (chunk): TaskChunkRecord => ({
        ...chunk,
        status: "pending",
      }),
    ),
  };
}
export async function persistTaskResume(
  task: TaskRecord,
  resume: TaskResumeRecord,
): Promise<void> {
  task.resume = resume;
  const current = taskStore.getTask(task.id);
  const completed = resume.chunks.filter(
    (chunk) => chunk.status === "succeeded",
  ).length;
  const status = current?.status === "failed" ? "failed" : "running";
  await taskStore.upsertTask({
    ...task,
    ...current,
    resume,
    status,
    progress: Math.round((completed / resume.chunks.length) * 100),
    error: status === "failed" ? current?.error : undefined,
  });
}
export async function updateTaskDetail(
  id: string,
  detail: string,
): Promise<void> {
  const current = taskStore.getTask(id);
  if (!current) {
    return;
  }
  await taskStore.upsertTask({ ...current, detail });
}
export function getTaskResumeDirectory(attachmentID: number): string {
  return toNativePath(
    `${Zotero.DataDirectory.dir}/mineru-resume/${attachmentID}`,
  );
}
export async function ensureTaskResumeDirectory(path: string): Promise<void> {
  if (typeof IOUtils === "undefined") {
    throw new MinerUTaskError("IOUtils is unavailable for MinerU resume data");
  }
  await IOUtils.makeDirectory(path, { ignoreExisting: true });
}
export async function resetTaskResumeDirectory(path: string): Promise<void> {
  if (typeof IOUtils === "undefined") {
    throw new MinerUTaskError("IOUtils is unavailable for MinerU resume data");
  }
  try {
    await IOUtils.remove(path, { recursive: true });
  } catch {
    // A first parse has no resume directory yet.
  }
}
export async function readChunkResult(path: string): Promise<any | null> {
  if (typeof IOUtils === "undefined") {
    return null;
  }
  try {
    if (!(await IOUtils.exists(path))) {
      return null;
    }
    const content = await IOUtils.readUTF8(path);
    const result = JSON.parse(content, reviveChunkValue);
    return result && typeof result === "object" ? result : null;
  } catch {
    return null;
  }
}
export async function writeChunkResult(
  path: string,
  result: unknown,
): Promise<void> {
  if (typeof IOUtils === "undefined") {
    throw new MinerUTaskError("IOUtils is unavailable for MinerU resume data");
  }
  await IOUtils.writeUTF8(path, JSON.stringify(result, serializeChunkValue), {
    tmpPath: `${path}.tmp`,
  });
}
export function serializeChunkValue(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array
    ? { __mineruUint8Array: Array.from(value) }
    : value;
}
export function reviveChunkValue(_key: string, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "__mineruUint8Array" in value &&
    Array.isArray(
      (value as { __mineruUint8Array?: unknown }).__mineruUint8Array,
    )
  ) {
    return new Uint8Array(
      (value as { __mineruUint8Array: number[] }).__mineruUint8Array,
    );
  }
  return value;
}
export async function cleanupTaskResume(
  taskID: string,
  resume: TaskResumeRecord,
): Promise<void> {
  if (typeof IOUtils !== "undefined") {
    for (const chunk of resume.chunks) {
      if (chunk.resultPath) {
        try {
          await IOUtils.remove(chunk.resultPath);
        } catch {
          // Cleanup is best effort after the final result is ready.
        }
      }
    }
    try {
      await IOUtils.remove(getTaskResumeDirectory(Number(taskID)), {
        recursive: true,
      });
    } catch {
      // The directory may already be empty or unavailable.
    }
  }
  const current = taskStore.getTask(taskID);
  if (current) {
    await taskStore.upsertTask({
      ...current,
      resume: undefined,
      detail: undefined,
    });
  }
}
