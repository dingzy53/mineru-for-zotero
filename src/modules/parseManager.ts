import type { AttachmentRef, NormalizedBox } from "./domain";
import type { FluentMessageId } from "../../typings/i10n";
import { config } from "../../package.json";
import { normalizeMinerUBoxes } from "./boxNormalizer";
import { generateLayoutPdf } from "./layoutPdfGenerator";
import {
  createMinerUClientForSettings,
  MinerUFileAccessError,
  MinerURequestError,
  MinerUTaskError,
  type MinerUClient,
} from "./mineruClient";
import { readFileBytes } from "./mineruClient/file";
import { toNativePath } from "./mineruClient/path";
import {
  clearAttachmentParseRunning,
  markAttachmentParseReady,
  markAttachmentParseRunning,
} from "./itemTreeColumn";
import { syncResultToAgentFolder } from "./agentSync";
import {
  taskStore,
  openTaskManagerWindow,
  type TaskChunkRecord,
  type TaskRecord,
  type TaskResumeRecord,
} from "./taskStore";
import { getPdfPageCount, splitPdf } from "./pdfSplitter";
import { createStorage, type StorageAdapter } from "./storage";
import { getString } from "../utils/locale";
import {
  getApiKey,
  getLocalApiTimeoutMinutes,
  getLocalApiBaseURL,
  getParseMode,
  getParseSource,
  getSaveImages,
  getParallelSplit,
  getAttachLayoutPdf,
  type ParseMode,
  type ParseSource,
} from "../utils/prefs";
import { getMinerUStorageRoot } from "./preferenceScript";
import {
  PROGRESS_WINDOW_ICON_URI,
  PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX,
  PROGRESS_WINDOW_DETAIL_LEFT_OFFSET_PX,
  ELEMENT_NODE_TYPE,
  PROGRESS_WINDOW_PRESENTATION_RETRY_DELAYS_MS,
  ProgressWindowText,
  ProgressWindowLineOption,
  normalizeProgressWindowText,
  createProgressWindowLineOptions,
  createProgressWindowDisplayText,
  createProgressWindowDetailLines,
  getProgressWindowItemParent,
  applyProgressWindowItemIcon,
  applyProgressWindowDescriptionLineLayout,
  scheduleProgressWindowPresentation,
  findNextProgressWindowDetailRow,
  styleProgressWindowDetailRow,
  createProgressWindowTexts,
  createParseTaskDetailText,
  getParseTaskDetailID,
  isParseTaskNotice,
  resolveParseNoticeModeLabel,
  resolveParseNoticeSourceLabel,
} from "./parseProgress";
import {
  createTaskResume,
  persistTaskResume,
  updateTaskDetail,
  getTaskResumeDirectory,
  ensureTaskResumeDirectory,
  resetTaskResumeDirectory,
  cleanupLegacyChunkCacheFiles,
  readChunkResult,
  writeChunkResult,
  serializeChunkValue,
  reviveChunkValue,
  cleanupTaskResume,
} from "./parseResume";
import {
  POLL_INTERVAL_MS,
  downloadTaskResultWithRetry,
  waitForTask,
  isTaskNotFoundError,
  isRetryableNetworkError,
  getReconnectDelayMs,
} from "./parseNetwork";

const LOCAL_CHUNK_PAGE_LIMIT = 200;
const DEFAULT_CHUNK_PAGE_LIMIT = 200;
const DEFAULT_ONLINE_POLL_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS_DEFAULT = 3;
const MAX_CONCURRENT_REQUESTS_CEILING = 10;
export type ReparseChoice = "use-existing" | "reparse";

export interface ParseManagerDependencies {
  getApiKey: () => string;
  getParseSource?: () => ParseSource;
  getParseMode?: () => ParseMode;
  getLocalApiBaseURL?: () => string;
  getLocalApiTimeoutMinutes?: () => number;
  getSaveImages?: () => boolean;
  getParallelSplit?: () => boolean;
  getAttachLayoutPdf?: () => boolean;
  generateLayoutPdf?: (
    pdfBytes: Uint8Array,
    boxes: NormalizedBox[],
  ) => Promise<Uint8Array>;
  readFileBytes?: (filePath: string) => Promise<Uint8Array>;
  attachLayoutPdfToItem?: (
    attachment: Zotero.Item,
    layoutPdfPath: string,
    title?: string,
  ) => Promise<Zotero.Item | null>;
  getMaxConcurrentRequests?: () => number;
  getPdfPageCount?: (filePath: string) => Promise<number>;
  splitPdf?: (
    inputPath: string,
    outputPath: string,
    startPage: number,
    endPage: number,
  ) => Promise<boolean>;
  storage?: StorageAdapter;
  createStorage?: () => StorageAdapter;
  client?: MinerUClient;
  createClient?: (settings: {
    apiKey: string;
    source: ParseSource;
    mode: ParseMode;
    localApiBaseURL: string;
    saveImages: boolean;
  }) => MinerUClient;
  showMessage: (id: FluentMessageId, args?: Record<string, string>) => void;
  getAttachmentTitle?: (attachment: Zotero.Item) => Promise<string>;
  openTaskManager?: () => void;
  confirmReparse: () => Promise<ReparseChoice>;
  isFileReadable: (filePath: string) => Promise<boolean>;
  delay: (ms: number) => Promise<void>;
  log: (...args: unknown[]) => void;
  onParseColumnRunning?: (
    attachment: AttachmentRef,
    mode: ParseMode,
  ) => Promise<void>;
  onParseColumnReady?: (
    attachment: AttachmentRef,
    mode: ParseMode,
  ) => Promise<void>;
  onParseColumnClearRunning?: (
    attachment: AttachmentRef,
    mode: ParseMode,
  ) => Promise<void>;
}

export interface ParseAttachmentOptions {
  force?: boolean;
  resume?: boolean;
}

interface ParseManager {
  getItemParseContext(item: Zotero.Item): Promise<ItemParseContext>;
  parseAttachment(
    attachment: Zotero.Item,
    options?: ParseAttachmentOptions,
  ): Promise<void>;
  parseAttachments(
    attachments: Zotero.Item[],
    options?: ParseAttachmentOptions,
  ): Promise<void>;
}

type ParsePhase = "submit" | "poll" | "download" | "write";

export type ItemParseContext =
  | { kind: "attachment"; attachment: Zotero.Item }
  | { kind: "regular"; item: Zotero.Item; attachments: Zotero.Item[] }
  | { kind: "unsupported"; item: Zotero.Item };

type PromptService = {
  BUTTON_TITLE_IS_STRING: number;
  BUTTON_POS_0: number;
  BUTTON_POS_1: number;
  BUTTON_POS_1_DEFAULT?: number;
  confirmEx: (
    parent: Window,
    title: string,
    text: string,
    buttonFlags: number,
    button0Title: string,
    button1Title: string,
    button2Title: string | null,
    checkMsg: string | null,
    checkState: object,
  ) => number;
};

export async function parseAttachment(
  attachment: Zotero.Item,
  options?: ParseAttachmentOptions,
): Promise<void> {
  await createParseManager(createDefaultDependencies()).parseAttachment(
    attachment,
    options,
  );
}

export async function parseAttachments(
  attachments: Zotero.Item[],
  options?: ParseAttachmentOptions,
): Promise<void> {
  await createParseManager(createDefaultDependencies()).parseAttachments(
    attachments,
    options,
  );
}

export function createParseManager(
  dependencies: ParseManagerDependencies,
): ParseManager {
  return {
    async getItemParseContext(item) {
      return getItemParseContext(item);
    },
    async parseAttachment(attachment, options) {
      await parseAttachmentWithDependencies(attachment, options, dependencies);
    },
    async parseAttachments(attachments, options) {
      await parseAttachmentsWithDependencies(
        attachments,
        options,
        dependencies,
      );
    },
  };
}

async function parseAttachmentsWithDependencies(
  attachments: Zotero.Item[],
  options: ParseAttachmentOptions | undefined,
  dependencies: ParseManagerDependencies,
): Promise<void> {
  const pdfAttachments = attachments.filter((attachment) =>
    attachment.isPDFAttachment(),
  );
  if (pdfAttachments.length === 0) {
    dependencies.showMessage("parse-error-not-pdf");
    return;
  }

  const source = getCurrentParseSource(dependencies);
  const mode = getCurrentParseMode(dependencies);
  const apiKey = dependencies.getApiKey().trim();
  if (requiresApiKey(source, mode) && !apiKey) {
    dependencies.showMessage("parse-error-missing-api-key");
    return;
  }

  if (options?.force === true) {
    const attachmentsToParse = await getSubmittableAttachments(
      pdfAttachments,
      dependencies,
    );
    if (attachmentsToParse.length === 0) {
      return;
    }

    // Limit concurrent MinerU requests across attachments.
    const concurrency = getMaxConcurrentRequests(dependencies);
    let active = 0;
    const queue = [...attachmentsToParse];

    try {
      (dependencies.openTaskManager ?? openTaskManagerWindow)();
    } catch (e) {
      ztoolkit.log("Failed to open Task Manager window", e);
    }

    await new Promise<void>((resolve) => {
      const next = () => {
        if (queue.length === 0 && active === 0) {
          resolve();
          return;
        }
        while (active < concurrency && queue.length > 0) {
          const attachment = queue.shift()!;
          active++;
          parseAttachmentWithDependencies(
            attachment,
            options,
            dependencies,
          ).finally(() => {
            active--;
            next();
          });
        }
      };
      next();
    });
    return;
  }

  const readyAttachmentIDs = await getReadyAttachmentIDs(
    pdfAttachments,
    mode,
    dependencies,
  );
  let attachmentsToParse = pdfAttachments;
  if (readyAttachmentIDs.size > 0) {
    const choice = await dependencies.confirmReparse();
    if (choice === "use-existing") {
      dependencies.showMessage("parse-use-existing-result");
      attachmentsToParse = pdfAttachments.filter(
        (attachment) => !readyAttachmentIDs.has(attachment.id),
      );
    }
  }

  attachmentsToParse = await getSubmittableAttachments(
    attachmentsToParse,
    dependencies,
  );

  if (attachmentsToParse.length === 0) {
    return;
  }

  // Limit concurrent MinerU requests across attachments.
  const concurrency = getMaxConcurrentRequests(dependencies);
  let active = 0;
  const queue = [...attachmentsToParse];

  // Open the global Task Manager UI to view progress
  try {
    (dependencies.openTaskManager ?? openTaskManagerWindow)();
  } catch (e) {
    ztoolkit.log("Failed to open Task Manager window", e);
  }

  await new Promise<void>((resolve) => {
    const next = () => {
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const attachment = queue.shift()!;
        active++;
        parseAttachmentWithDependencies(
          attachment,
          { ...options, force: true },
          dependencies,
        ).finally(() => {
          active--;
          next();
        });
      }
    };
    next();
  });
}

async function getSubmittableAttachments(
  attachments: Zotero.Item[],
  dependencies: ParseManagerDependencies,
): Promise<Zotero.Item[]> {
  const checkedAttachments = await Promise.all(
    attachments.map(async (attachment) => {
      const rawFilePath = await getAttachmentFilePath(attachment, dependencies);
      if (!rawFilePath) {
        logFileAccessFailure(attachment, "<missing>", dependencies);
        dependencies.showMessage("parse-error-file-access");
        return null;
      }

      const filePath = toNativePath(rawFilePath);
      if (!(await dependencies.isFileReadable(filePath))) {
        logFileAccessFailure(attachment, filePath, dependencies);
        dependencies.showMessage("parse-error-file-access");
        return null;
      }

      // Check file size limit (200MB = 200 * 1024 * 1024 bytes)
      try {
        const stat = await IOUtils.stat(filePath);
        if ((stat.size ?? 0) > 200 * 1024 * 1024) {
          dependencies.log("File exceeds 200MB limit", filePath);
          // Show error and tag
          dependencies.showMessage("parse-error-empty-boxes"); // fallback message, ideally should have a dedicated one
          try {
            attachment.removeTag("MinerU: Processing ⏳");
            attachment.addTag("MinerU: Failed ❌", 1);
            await attachment.saveTx();
          } catch (e) {
            // Ignore tag update errors
          }
          return null;
        }
      } catch (e) {
        dependencies.log("Failed to check file size", filePath, e);
      }

      return attachment;
    }),
  );

  return checkedAttachments.filter(
    (attachment): attachment is Zotero.Item => attachment !== null,
  );
}

async function getReadyAttachmentIDs(
  attachments: Zotero.Item[],
  mode: ParseMode,
  dependencies: ParseManagerDependencies,
): Promise<Set<number>> {
  const storage = getStorage(dependencies);
  const refs = await Promise.all(
    attachments.map(async (attachment) => {
      const filePath = await getAttachmentFilePath(attachment, dependencies);
      return filePath
        ? { attachment, ref: await toAttachmentRef(attachment, filePath) }
        : null;
    }),
  );
  const readyPairs = await Promise.all(
    refs.map(async (entry) => {
      if (!entry) {
        return null;
      }
      return (await hasExistingResultForMode(entry.ref, mode, storage))
        ? entry.attachment.id
        : null;
    }),
  );
  return new Set(
    readyPairs.filter((id): id is number => typeof id === "number"),
  );
}

async function parseAttachmentWithDependencies(
  attachment: Zotero.Item,
  options: ParseAttachmentOptions | undefined,
  dependencies: ParseManagerDependencies,
): Promise<void> {
  if (!attachment.isPDFAttachment()) {
    dependencies.showMessage("parse-error-not-pdf");
    return;
  }

  const rawFilePath = await getAttachmentFilePath(attachment, dependencies);
  if (!rawFilePath) {
    logFileAccessFailure(attachment, "<missing>", dependencies);
    dependencies.showMessage("parse-error-file-access");
    return;
  }
  const filePath = toNativePath(rawFilePath);

  if (!(await dependencies.isFileReadable(filePath))) {
    logFileAccessFailure(attachment, filePath, dependencies);
    dependencies.showMessage("parse-error-file-access");
    return;
  }

  const source = getCurrentParseSource(dependencies);
  const mode = getCurrentParseMode(dependencies);
  const apiKey = dependencies.getApiKey().trim();
  const localApiBaseURL = dependencies.getLocalApiBaseURL?.() ?? "";
  if (requiresApiKey(source, mode) && !apiKey) {
    dependencies.showMessage("parse-error-missing-api-key");
    return;
  }

  const attachmentRef = await toAttachmentRef(attachment, filePath);
  const storage = getStorage(dependencies);
  const hasExistingResult = await hasExistingResultForMode(
    attachmentRef,
    mode,
    storage,
  );
  if (hasExistingResult && options?.force !== true) {
    const choice = await dependencies.confirmReparse();
    if (choice === "use-existing") {
      dependencies.showMessage("parse-use-existing-result");
      return;
    }
  }

  const client = getClient(
    {
      apiKey,
      source,
      mode,
      localApiBaseURL,
      saveImages: dependencies.getSaveImages?.() !== false,
    },
    dependencies,
  );
  let parseColumnRunning = false;
  let phase: ParsePhase = "submit";
  const attachmentTitle =
    (await resolveAttachmentTitle(attachment, dependencies)) || "PDF Document";
  await taskStore.waitUntilLoaded();
  const existingTask = taskStore.getTask(String(attachment.id));
  const canResume =
    options?.resume === true &&
    existingTask?.resume &&
    existingTask.resume.source === source &&
    existingTask.resume.mode === mode &&
    existingTask.resume.filePath === filePath &&
    existingTask.resume.pdfMtime === attachmentRef.mtime &&
    (source !== "local" ||
      existingTask.resume.localApiBaseURL === localApiBaseURL);
  const task: TaskRecord = canResume
    ? {
        ...existingTask!,
        status: "running",
        error: undefined,
        detail: "Resuming saved MinerU task...",
      }
    : {
        id: String(attachment.id),
        attachment: attachmentRef,
        title: attachmentTitle as string,
        status: "running",
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

  // Register in TaskStore before any remote request. Resume metadata is added
  // after page counting and then persisted before the first chunk submission.
  await taskStore.upsertTask(task);

  try {
    await updateParseColumnStatus(dependencies, "running", attachmentRef, mode);
    parseColumnRunning = true;
    phase = "submit";

    const pageCount = dependencies.getPdfPageCount
      ? await dependencies.getPdfPageCount(filePath)
      : await getPdfPageCount(filePath);
    const CHUNK_SIZE = getChunkPageLimit(source);
    const split = dependencies.splitPdf ?? splitPdf;
    const chunks = Math.max(1, Math.ceil(pageCount / CHUNK_SIZE));
    const resume = createTaskResume(
      task.resume,
      source,
      mode,
      localApiBaseURL,
      filePath,
      attachmentRef.mtime,
      pageCount,
      CHUNK_SIZE,
      chunks,
    );
    task.resume = resume;
    await taskStore.upsertTask({
      ...task,
      progress: 0,
      error: undefined,
      detail:
        chunks > 1
          ? `[Auto-Split] Prepared ${chunks} parts (maximum ${CHUNK_SIZE} pages each)`
          : `Uploading full document (${pageCount} pages)...`,
    });
    const results: any[] = new Array(chunks);
    const taskIDs: string[] = new Array(chunks);
    const resumeDirectory = getTaskResumeDirectory(attachment.id);
    if (!canResume) {
      await resetTaskResumeDirectory(resumeDirectory);
      await cleanupLegacyChunkCacheFiles(attachment.id);
    }
    await ensureTaskResumeDirectory(resumeDirectory);

    if (pageCount > CHUNK_SIZE) {
      const tmpDir = resumeDirectory;
      const isParallel = dependencies.getParallelSplit
        ? dependencies.getParallelSplit()
        : getParallelSplit();

      const chunkTasks = Array.from({ length: chunks }, (_, i) => async () => {
        const chunk = resume.chunks[i];
        const startPage = chunk.startPage;
        const endPage = chunk.endPage;
        const targetPath = toNativePath(
          `${tmpDir}/mineru-part-${attachment.id}-${i}.pdf`,
        );
        const cachePath =
          chunk.resultPath ??
          toNativePath(
            `${tmpDir}/mineru-part-${attachment.id}-${i}-result.json`,
          );
        chunk.resultPath = cachePath;

        const cached = await readChunkResult(cachePath);
        if (cached) {
          results[i] = cached;
          taskIDs[i] = chunk.taskID ?? "";
          chunk.status = "succeeded";
          await persistTaskResume(task, resume);
          return;
        }

        if (!isParallel) {
          await updateTaskDetail(
            String(attachment.id),
            `[Auto-Split] Processing part ${i + 1}/${chunks} (Pages ${startPage}-${endPage})`,
          );
        }

        const submitChunk = async (): Promise<void> => {
          const success = await split(filePath, targetPath, startPage, endPage);
          if (!success) {
            throw new MinerUTaskError(
              `Failed to split PDF chunk ${i + 1}/${chunks}. pdftk may not be installed.`,
            );
          }

          const submitResult = await client.submitPdf(targetPath);
          chunk.taskID = submitResult.taskID;
          chunk.status = "submitted";
          taskIDs[i] = chunk.taskID;
          await persistTaskResume(task, resume);
        };

        // If the previous Zotero run already submitted this chunk, keep the
        // original task ID and reconnect instead of uploading the chunk again.
        if (!chunk.taskID) {
          await submitChunk();
        } else {
          taskIDs[i] = chunk.taskID;
        }

        const pollChunk = async (): Promise<void> => {
          const taskID = chunk.taskID;
          if (!taskID) {
            throw new MinerUTaskError("Missing MinerU task ID for chunk");
          }
          phase = "poll";
          await waitForTask(
            client,
            taskID,
            dependencies.delay,
            getPollTimeoutMs(source, dependencies),
            () => taskStore.getTask(String(attachment.id))?.status === "failed",
            source,
            dependencies.log,
            async (attempt, waitMs) =>
              updateTaskDetail(
                String(attachment.id),
                getSafeMessageText("parse-task-reconnect", {
                  attempt: String(attempt),
                  seconds: String(Math.ceil(waitMs / 1000)),
                }),
              ),
          );
        };

        try {
          await pollChunk();
        } catch (error) {
          if (!isTaskNotFoundError(error, source)) {
            throw error;
          }
          // The remote service lost this task (usually after a restart). Only
          // this unfinished chunk is resubmitted; completed chunks stay cached.
          chunk.taskID = undefined;
          chunk.status = "pending";
          await persistTaskResume(task, resume);
          await submitChunk();
          await pollChunk();
        }

        const downloadChunk = async (): Promise<any> => {
          const taskID = chunk.taskID;
          if (!taskID) {
            throw new MinerUTaskError("Missing MinerU task ID for chunk");
          }
          phase = "download";
          return downloadTaskResultWithRetry(
            client,
            taskID,
            dependencies.delay,
            getPollTimeoutMs(source, dependencies),
            source,
            dependencies.log,
            async (attempt, waitMs) =>
              updateTaskDetail(
                String(attachment.id),
                getSafeMessageText("parse-task-download-reconnect", {
                  attempt: String(attempt),
                  seconds: String(Math.ceil(waitMs / 1000)),
                }),
              ),
          );
        };

        let res: any;
        try {
          res = await downloadChunk();
        } catch (error) {
          if (!isTaskNotFoundError(error, source)) {
            throw error;
          }
          chunk.taskID = undefined;
          chunk.status = "pending";
          await persistTaskResume(task, resume);
          await submitChunk();
          await pollChunk();
          res = await downloadChunk();
        }
        (res as any)._chunkPageCount = endPage - startPage + 1;

        // The cache is written before the chunk is marked succeeded. If the
        // process fails later, this chunk can be skipped safely on resume.
        await writeChunkResult(cachePath, res);
        results[i] = res;
        chunk.status = "succeeded";
        await persistTaskResume(task, resume);
        try {
          await IOUtils.remove(targetPath);
        } catch {
          // The PDF part is disposable; keep the result cache on failure.
        }
      });

      if (isParallel) {
        await updateTaskDetail(
          String(attachment.id),
          `[Auto-Split] Processing ${chunks} parts in parallel...`,
        );
        const queue = [...chunkTasks];
        let active = 0;
        const chunkConcurrency = getMaxConcurrentRequests(dependencies);
        await new Promise<void>((resolve, reject) => {
          let hasError = false;
          const next = () => {
            if (hasError) return;
            if (taskStore.getTask(String(attachment.id))?.status === "failed") {
              hasError = true;
              reject(new Error("The operation was canceled."));
              return;
            }
            if (queue.length === 0 && active === 0) {
              resolve();
              return;
            }
            while (active < chunkConcurrency && queue.length > 0) {
              const task = queue.shift()!;
              active++;
              task()
                .then(() => {
                  active--;
                  next();
                })
                .catch((err) => {
                  hasError = true;
                  reject(err);
                });
            }
          };
          next();
        });
      } else {
        for (const task of chunkTasks) {
          await task();
        }
      }

      // Keep chunk result caches until the final merged result has been
      // written. A later Resume can therefore skip every completed chunk.
      await updateTaskDetail(
        String(attachment.id),
        `[Auto-Split] Finished processing ${chunks} parts. Merging...`,
      );
    } else {
      const chunk = resume.chunks[0];
      const cachePath =
        chunk.resultPath ??
        toNativePath(
          `${getTaskResumeDirectory(attachment.id)}/mineru-part-${attachment.id}-0-result.json`,
        );
      chunk.resultPath = cachePath;
      const cached = await readChunkResult(cachePath);
      if (cached) {
        results[0] = cached;
        taskIDs[0] = chunk.taskID ?? "";
        chunk.status = "succeeded";
        await persistTaskResume(task, resume);
      } else {
        await updateTaskDetail(
          String(attachment.id),
          `Uploading full document (${pageCount} pages)...`,
        );
        const submitSingle = async (): Promise<void> => {
          const submitResult = await client.submitPdf(filePath);
          chunk.taskID = submitResult.taskID;
          chunk.status = "submitted";
          taskIDs[0] = chunk.taskID;
          await persistTaskResume(task, resume);
        };
        if (!chunk.taskID) {
          await submitSingle();
        } else {
          taskIDs[0] = chunk.taskID;
        }

        const pollSingle = async (): Promise<void> => {
          const taskID = chunk.taskID;
          if (!taskID) {
            throw new MinerUTaskError("Missing MinerU task ID");
          }
          phase = "poll";
          await waitForTask(
            client,
            taskID,
            dependencies.delay,
            getPollTimeoutMs(source, dependencies),
            () => taskStore.getTask(String(attachment.id))?.status === "failed",
            source,
            dependencies.log,
            async (attempt, waitMs) =>
              updateTaskDetail(
                String(attachment.id),
                getSafeMessageText("parse-task-reconnect", {
                  attempt: String(attempt),
                  seconds: String(Math.ceil(waitMs / 1000)),
                }),
              ),
          );
        };
        try {
          await pollSingle();
        } catch (error) {
          if (!isTaskNotFoundError(error, source)) {
            throw error;
          }
          chunk.taskID = undefined;
          chunk.status = "pending";
          await persistTaskResume(task, resume);
          await submitSingle();
          await pollSingle();
        }
        await updateTaskDetail(String(attachment.id), "Downloading result...");
        const downloadSingle = async (): Promise<any> => {
          const taskID = chunk.taskID;
          if (!taskID) {
            throw new MinerUTaskError("Missing MinerU task ID");
          }
          phase = "download";
          return downloadTaskResultWithRetry(
            client,
            taskID,
            dependencies.delay,
            getPollTimeoutMs(source, dependencies),
            source,
            dependencies.log,
            async (attempt, waitMs) =>
              updateTaskDetail(
                String(attachment.id),
                getSafeMessageText("parse-task-download-reconnect", {
                  attempt: String(attempt),
                  seconds: String(Math.ceil(waitMs / 1000)),
                }),
              ),
          );
        };
        let result: any;
        try {
          result = await downloadSingle();
        } catch (error) {
          if (!isTaskNotFoundError(error, source)) {
            throw error;
          }
          chunk.taskID = undefined;
          chunk.status = "pending";
          await persistTaskResume(task, resume);
          await submitSingle();
          await pollSingle();
          result = await downloadSingle();
        }
        (result as any)._chunkPageCount = pageCount;
        await writeChunkResult(cachePath, result);
        results[0] = result;
        chunk.status = "succeeded";
        await persistTaskResume(task, resume);
      }
    }

    let mergedResult: any;
    await taskStore.upsertTask({
      ...taskStore.getTask(String(attachment.id))!,
      detail: undefined,
    });
    if (mode === "lite") {
      mergedResult = {
        kind: "lite",
        markdown: results.map((r) => r.markdown).join("\n\n---\n\n"),
      };
    } else if (results.length === 1) {
      const single = results[0];
      mergedResult = {
        kind: "precise",
        rawResult: single.rawResult,
        markdown: single.markdown,
        images: single.images || [],
        layoutPdf: single.layoutPdf,
        _mergedBoxes: normalizeMinerUBoxes(single.rawResult),
      };
    } else {
      let mergedMarkdown = "";
      const mergedImages: any[] = [];
      const rawResultsArr: any[] = [];
      const mergedBoxes: any[] = [];
      let pageOffset = 0;

      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        rawResultsArr.push(res.rawResult);

        let md = res.markdown;
        const images = res.images || [];
        for (const img of images) {
          const oldPath = img.path;
          const newPath = `part${i}_${oldPath.replace("images/", "")}`;
          img.path = `images/${newPath}`;
          md = md.split(oldPath).join(img.path);
        }
        mergedImages.push(...images);
        mergedMarkdown += md + (i < results.length - 1 ? "\n\n---\n\n" : "");

        const boxes = normalizeMinerUBoxes(res.rawResult);
        for (const box of boxes) {
          box.page += pageOffset;
        }
        mergedBoxes.push(...boxes);

        pageOffset += res._chunkPageCount || 200;
      }

      mergedResult = {
        kind: "precise",
        rawResult: rawResultsArr,
        markdown: mergedMarkdown,
        images: mergedImages,
        _mergedBoxes: mergedBoxes,
      };
    }

    const result = mergedResult;
    const taskID = taskIDs.join(",");

    if (result.kind === "lite") {
      phase = "write";
      if (!result.markdown.trim()) {
        if (parseColumnRunning) {
          await updateParseColumnStatus(
            dependencies,
            "clear-running",
            attachmentRef,
            mode,
          );
          parseColumnRunning = false;
        }
        dependencies.showMessage("parse-error-empty-lite-markdown");
        await taskStore.updateTaskStatus(
          String(attachment.id),
          "failed",
          "parse-error-empty-lite-markdown",
        );
        return;
      }
      await storage.writeLiteResult({
        attachment: attachmentRef,
        mineruTaskID: taskID,
        source,
        markdown: result.markdown,
      });
      await cleanupTaskResume(String(attachment.id), resume);
      await updateParseColumnStatus(
        dependencies,
        "ready",
        attachmentRef,
        "lite",
      );
      parseColumnRunning = false;

      // Update Tags
      try {
        attachment.removeTag("MinerU: Processing ⏳");
        attachment.removeTag("MinerU: Failed ❌");
        attachment.removeTag("MinerU: Precise ✅");
        attachment.addTag("MinerU: Lite ✅", 1);
        await attachment.saveTx();
      } catch (e) {
        dependencies.log("Failed to update Zotero tags", e);
      }

      // Sync to Agent folder
      await syncResultToAgentFolder(
        attachment,
        storage.getAttachmentDir(attachmentRef),
      );

      await taskStore.updateTaskStatus(String(attachment.id), "succeeded");

      return;
    }
    const boxes = result._mergedBoxes || normalizeMinerUBoxes(result.rawResult);

    if (boxes.length === 0) {
      phase = "write";
      await storage.writeFailedResult({
        attachment: attachmentRef,
        mineruTaskID: taskID,
        rawResult: result.rawResult,
        markdown: result.markdown,
        error: getSafeMessageText("parse-error-empty-boxes"),
      });
      if (parseColumnRunning) {
        await updateParseColumnStatus(
          dependencies,
          "clear-running",
          attachmentRef,
          mode,
        );
        parseColumnRunning = false;
      }
      try {
        attachment.removeTag("MinerU: Processing ⏳");
        attachment.removeTag("MinerU: Precise ✅");
        attachment.removeTag("MinerU: Lite ✅");
        attachment.addTag("MinerU: Failed ❌", 1);
        await attachment.saveTx();
      } catch (e) {
        // Ignore tag update errors
      }
      dependencies.showMessage("parse-error-empty-boxes");
      await taskStore.updateTaskStatus(String(attachment.id), "failed");
      return;
    }

    phase = "write";
    await storage.writeResult({
      attachment: attachmentRef,
      mineruTaskID: taskID,
      rawResult: result.rawResult,
      markdown: result.markdown,
      boxes,
      images:
        dependencies.getSaveImages?.() !== false ? result.images : undefined,
    });
    await cleanupTaskResume(String(attachment.id), resume);

    // Generate and attach layout PDF if enabled
    const shouldAttachLayoutPdf = dependencies.getAttachLayoutPdf
      ? dependencies.getAttachLayoutPdf()
      : getAttachLayoutPdf();
    if (shouldAttachLayoutPdf) {
      try {
        let layoutPdfBytes =
          result.kind === "precise" ? result.layoutPdf : undefined;
        if (!layoutPdfBytes) {
          const readBinary = dependencies.readFileBytes ?? readFileBytes;
          const generatePdf =
            dependencies.generateLayoutPdf ?? generateLayoutPdf;
          const pdfBytes = await readBinary(filePath);
          layoutPdfBytes = await generatePdf(pdfBytes, boxes);
        }
        const layoutPdfPath = await storage.writeLayoutPdf(
          attachmentRef,
          layoutPdfBytes,
        );
        const attachToItem =
          dependencies.attachLayoutPdfToItem ?? defaultAttachLayoutPdfToItem;
        const defaultTitle = `${attachmentTitle || "Document"} (MinerU Layout)`;
        await attachToItem(attachment, layoutPdfPath, defaultTitle);
      } catch (err) {
        dependencies.log("Failed to generate or attach layout PDF", err);
        const errDetail =
          err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
        if (typeof Zotero !== "undefined") {
          Zotero.debug(
            `[MinerU] Failed to generate or attach layout PDF: ${errDetail}`,
          );
        }
        console.error("[MinerU] Failed to generate or attach layout PDF", err);
      }
    }

    await updateParseColumnStatus(
      dependencies,
      "ready",
      attachmentRef,
      "precise",
    );
    parseColumnRunning = false;

    // Update Tags
    try {
      attachment.removeTag("MinerU: Processing ⏳");
      attachment.removeTag("MinerU: Failed ❌");
      attachment.removeTag("MinerU: Lite ✅");
      attachment.addTag("MinerU: Precise ✅", 1);
      await attachment.saveTx();
    } catch (e) {
      dependencies.log("Failed to update Zotero tags", e);
    }

    // Sync to Agent folder
    await syncResultToAgentFolder(
      attachment,
      storage.getAttachmentDir(attachmentRef),
    );

    await taskStore.updateTaskStatus(String(attachment.id), "succeeded");
  } catch (error) {
    if (parseColumnRunning) {
      await updateParseColumnStatus(
        dependencies,
        "clear-running",
        attachmentRef,
        mode,
      );
      parseColumnRunning = false;
    }
    if (error instanceof MinerUFileAccessError) {
      logFileAccessFailure(attachment, filePath, dependencies, error);
      dependencies.showMessage("parse-error-file-access");
      return;
    }

    dependencies.log("MinerU parse failed", attachment.id, error);
    try {
      attachment.removeTag("MinerU: Processing ⏳");
      attachment.removeTag("MinerU: Precise ✅");
      attachment.removeTag("MinerU: Lite ✅");
      attachment.addTag("MinerU: Failed ❌", 1);
      await attachment.saveTx();
    } catch (e) {
      // Ignore tag update errors
    }

    const failure = getParseFailureMessage(
      error,
      phase,
      mode === "precise" && hasExistingResult,
    );
    dependencies.showMessage(failure.id, failure.args);

    await taskStore.updateTaskStatus(
      String(attachment.id),
      "failed",
      failure.args?.error || String(error),
    );
  }
}

/**
 * Best-effort 解析附件的展示标题。
 *
 * 优先使用依赖注入的实现（便于单元测试），其次回退到 Zotero 父条目标题，
 * 最后尝试附件自身的标题字段。任何一步失败都不应中断解析流程。
 */
async function resolveAttachmentTitle(
  attachment: Zotero.Item,
  dependencies: ParseManagerDependencies,
): Promise<string> {
  const injected = await dependencies.getAttachmentTitle?.(attachment);
  if (injected) {
    return injected;
  }

  try {
    const parentTitle = (
      await Zotero.Items.getAsync(attachment.id)
    )?.parentItem?.getField?.("title");
    if (parentTitle) {
      return String(parentTitle);
    }
  } catch {
    // Zotero 条目查询失败时回退到附件自身标题。
  }

  try {
    const title = attachment.getField?.("title");
    if (title) {
      return String(title);
    }
  } catch {
    // 附件缺少标题信息时使用占位标题。
  }

  return "";
}

/**
 * Best-effort 同步解析列状态，避免辅助 UI 失败影响核心解析流程。
 */
async function updateParseColumnStatus(
  dependencies: ParseManagerDependencies,
  action: "running" | "ready" | "clear-running",
  attachment: AttachmentRef,
  mode: ParseMode,
): Promise<void> {
  try {
    if (action === "running") {
      try {
        const item = await Zotero.Items.getAsync(attachment.id);
        if (item) {
          item.removeTag("MinerU: Failed ❌");
          item.addTag("MinerU: Processing ⏳", 1);
          await item.saveTx();
        }
      } catch (e) {
        // Ignore tag update errors
      }
      await dependencies.onParseColumnRunning?.(attachment, mode);
      return;
    }
    if (action === "ready") {
      await dependencies.onParseColumnReady?.(attachment, mode);
      return;
    }
    await dependencies.onParseColumnClearRunning?.(attachment, mode);
  } catch (error) {
    dependencies.log("failed to update MinerU parse column", {
      action,
      attachmentID: attachment.id,
      attachmentKey: attachment.key,
      libraryID: attachment.libraryID,
      mode,
      error,
    });
  }
}

async function getItemParseContext(
  item: Zotero.Item,
): Promise<ItemParseContext> {
  if (item.isAttachment()) {
    return item.isPDFAttachment()
      ? { kind: "attachment", attachment: item }
      : { kind: "unsupported", item };
  }

  if (!item.isRegularItem()) {
    return { kind: "unsupported", item };
  }

  const attachments = await item.getBestAttachments();
  const pdfAttachments = attachments.filter((attachment) =>
    attachment.isPDFAttachment(),
  );
  return pdfAttachments.length > 0
    ? { kind: "regular", item, attachments: pdfAttachments }
    : { kind: "unsupported", item };
}

async function toAttachmentRef(
  attachment: Zotero.Item,
  filePath: string,
): Promise<AttachmentRef> {
  return {
    id: attachment.id,
    key: attachment.key,
    libraryID: attachment.libraryID,
    fileName: attachment.attachmentFilename || basename(filePath),
    filePath,
    mtime: (await attachment.attachmentModificationTime) ?? 0,
  };
}

/**
 * Resolve the MinerU request concurrency cap from
 * MINERU_API_MAX_CONCURRENT_REQUESTS, falling back to the given default.
 */
function resolveEnvConcurrentRequestLimit(defaultLimit: number): number {
  try {
    const env = (
      globalThis as { Services?: { env?: { get(name: string): string } } }
    ).Services?.env;
    const raw = env?.get("MINERU_API_MAX_CONCURRENT_REQUESTS");
    if (!raw) {
      return defaultLimit;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      return defaultLimit;
    }
    return Math.min(MAX_CONCURRENT_REQUESTS_CEILING, Math.max(1, parsed));
  } catch {
    return defaultLimit;
  }
}

function getMaxConcurrentRequests(
  dependencies: ParseManagerDependencies,
): number {
  if (dependencies.getMaxConcurrentRequests) {
    return dependencies.getMaxConcurrentRequests();
  }
  return resolveEnvConcurrentRequestLimit(MAX_CONCURRENT_REQUESTS_DEFAULT);
}

async function confirmReparse(): Promise<ReparseChoice> {
  const win = Zotero.getMainWindow();
  const prompt = getPromptService(win);
  if (prompt) {
    const flags = getReparsePromptButtonFlags(prompt);
    const button = prompt.confirmEx(
      win,
      getString("parse-confirm-title"),
      getString("parse-confirm-reparse"),
      flags,
      getString("parse-confirm-overwrite"),
      getString("parse-confirm-use-existing"),
      null,
      null,
      {},
    );
    return resolveReparseChoiceFromPromptButton(button);
  }

  return win.confirm(getString("parse-confirm-reparse"))
    ? "reparse"
    : "use-existing";
}

function getReparsePromptButtonFlags(prompt: PromptService): number {
  return (
    prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_0 +
    prompt.BUTTON_TITLE_IS_STRING * prompt.BUTTON_POS_1 +
    (prompt.BUTTON_POS_1_DEFAULT ?? 0)
  );
}

export function resolveReparseChoiceFromPromptButton(
  button: number,
): ReparseChoice {
  return button === 0 ? "reparse" : "use-existing";
}

function showMessage(id: FluentMessageId, args?: Record<string, string>): void {
  const lines = createProgressWindowTexts(id, args, getMessageText);
  const text = lines.map((l) => l.text).join("\n");
  try {
    const mainWin = Zotero.getMainWindow();
    if (mainWin) {
      mainWin.alert(text);
    }
  } catch (e) {
    ztoolkit.log("Failed to show alert", e);
  }
}

const recentlyCreatedLayoutAttachmentIDs = new Set<number>();

export function isMinerUGeneratedAttachment(item: Zotero.Item): boolean {
  if (!item) {
    return false;
  }
  if (
    typeof item.id === "number" &&
    recentlyCreatedLayoutAttachmentIDs.has(item.id)
  ) {
    return true;
  }
  if (typeof item.isAttachment === "function" && !item.isAttachment()) {
    return false;
  }
  try {
    const title = (item.getField?.("title") as string) || "";
    if (title.includes("(MinerU Layout)") || title.includes("(MinerU Span)")) {
      return true;
    }
    const filename = item.attachmentFilename || "";
    if (
      filename.toLowerCase() === "layout.pdf" ||
      filename.toLowerCase().endsWith("_layout.pdf")
    ) {
      return true;
    }
    const tags = item.getTags?.() || [];
    if (
      tags.some(
        (t: any) =>
          t.tag === "MinerU: Layout" ||
          t.tag === "MinerU: Span" ||
          t.tag === "MinerU",
      )
    ) {
      return true;
    }
  } catch {
    // Ignore error
  }
  return false;
}

export async function defaultAttachLayoutPdfToItem(
  attachment: Zotero.Item,
  layoutPdfPath: string,
  title?: string,
): Promise<Zotero.Item | null> {
  try {
    const parentItemID =
      attachment.parentItemID ||
      (typeof attachment.parentItem === "object"
        ? attachment.parentItem?.id
        : undefined);
    const parentItem =
      (typeof attachment.parentItem === "object" && attachment.parentItem) ||
      (parentItemID
        ? await Zotero.Items.getAsync(parentItemID as number)
        : undefined);
    const libraryID = attachment.libraryID;
    const defaultTitle =
      title ||
      `${
        (parentItem?.getField?.("title") as string) ||
        (attachment.getField?.("title") as string) ||
        "Document"
      } (MinerU Layout)`;

    if (parentItem) {
      try {
        const attIDs = (
          typeof parentItem.getAttachments === "function"
            ? await parentItem.getAttachments()
            : []
        ) as number[];
        for (const attID of attIDs) {
          const att = await Zotero.Items.getAsync(attID);
          if (
            att &&
            att.id !== attachment.id &&
            att.isAttachment?.() &&
            (att.getField?.("title") === defaultTitle ||
              att.getTags?.().some((t: any) => t.tag === "MinerU: Layout"))
          ) {
            try {
              await att.eraseTx();
            } catch {
              // Ignore erase failure
            }
          }
        }
      } catch {
        // Ignore attachment query failure
      }
    }

    const newAtt = await Zotero.Attachments.importFromFile({
      file: layoutPdfPath,
      parentItemID: parentItem ? parentItem.id : undefined,
      libraryID,
      title: defaultTitle,
      contentType: "application/pdf",
    });
    if (newAtt) {
      if (typeof newAtt.id === "number") {
        recentlyCreatedLayoutAttachmentIDs.add(newAtt.id);
      }
      try {
        newAtt.addTag("MinerU: Layout", 1);
        await newAtt.saveTx();
      } catch {
        // Ignore tag error
      }
    }
    return newAtt;
  } catch (e) {
    ztoolkit.log("Failed to attach layout PDF to Zotero item", e);
    const errText = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    if (typeof Zotero !== "undefined") {
      Zotero.debug(
        `[MinerU] Failed to attach layout PDF to Zotero item: ${errText}`,
      );
    }
    console.error("[MinerU] Failed to attach layout PDF to Zotero item", e);
    return null;
  }
}

function createDefaultDependencies(): ParseManagerDependencies {
  return {
    getApiKey,
    getParseSource,
    getParseMode,
    getLocalApiBaseURL,
    getLocalApiTimeoutMinutes,
    getSaveImages,
    getAttachLayoutPdf,
    generateLayoutPdf,
    readFileBytes,
    attachLayoutPdfToItem: defaultAttachLayoutPdfToItem,
    getMaxConcurrentRequests: () =>
      resolveEnvConcurrentRequestLimit(MAX_CONCURRENT_REQUESTS_DEFAULT),
    createStorage: () => createStorage(getMinerUStorageRoot()),
    createClient: (settings) => createMinerUClientForSettings(settings),
    showMessage,
    confirmReparse,
    isFileReadable,
    delay: (ms) => Zotero.Promise.delay(ms),
    log: (...args) => ztoolkit.log(...args),
    onParseColumnRunning: markAttachmentParseRunning,
    onParseColumnReady: markAttachmentParseReady,
    onParseColumnClearRunning: clearAttachmentParseRunning,
  };
}

function getStorage(dependencies: ParseManagerDependencies): StorageAdapter {
  if (dependencies.storage) {
    return dependencies.storage;
  }
  if (dependencies.createStorage) {
    return dependencies.createStorage();
  }
  throw new Error("Parse manager storage dependency is missing");
}

function getClient(
  settings: {
    apiKey: string;
    source: ParseSource;
    mode: ParseMode;
    localApiBaseURL: string;
    saveImages: boolean;
  },
  dependencies: ParseManagerDependencies,
): MinerUClient {
  if (dependencies.client) {
    return dependencies.client;
  }
  if (dependencies.createClient) {
    return dependencies.createClient(settings);
  }
  throw new Error("Parse manager client dependency is missing");
}

function getCurrentParseSource(
  dependencies: ParseManagerDependencies,
): ParseSource {
  return dependencies.getParseSource?.() ?? "online";
}

function getCurrentParseMode(
  dependencies: ParseManagerDependencies,
): ParseMode {
  return dependencies.getParseMode?.() ?? "precise";
}

function getChunkPageLimit(source: ParseSource): number {
  // The remote Local MinerU API rejects requests above 200 pages. Keep the
  // same conservative boundary for the other clients until their limits are
  // handled independently.
  return source === "local" ? LOCAL_CHUNK_PAGE_LIMIT : DEFAULT_CHUNK_PAGE_LIMIT;
}

function getPollTimeoutMs(
  source: ParseSource,
  dependencies: ParseManagerDependencies,
): number {
  if (source !== "local") {
    return DEFAULT_ONLINE_POLL_TIMEOUT_MS;
  }
  return (dependencies.getLocalApiTimeoutMinutes?.() ?? 30) * 60 * 1000;
}

function requiresApiKey(source: ParseSource, mode: ParseMode): boolean {
  return source === "online" && mode === "precise";
}

async function hasExistingResultForMode(
  attachment: AttachmentRef,
  mode: ParseMode,
  storage: StorageAdapter,
): Promise<boolean> {
  return mode === "lite"
    ? await storage.hasLiteResult(attachment)
    : await storage.hasReadyResult(attachment);
}

async function getAttachmentFilePath(
  attachment: Zotero.Item,
  dependencies: ParseManagerDependencies,
): Promise<string | null> {
  try {
    return (await attachment.getFilePathAsync()) || null;
  } catch (error) {
    logFileAccessFailure(attachment, "<unavailable>", dependencies, error);
    return null;
  }
}

function logFileAccessFailure(
  attachment: Zotero.Item,
  filePath: string,
  dependencies: ParseManagerDependencies,
  error?: unknown,
): void {
  dependencies.log("MinerU PDF file access failed", {
    attachmentID: attachment.id,
    filePath,
    error: error instanceof Error ? error.message : error,
  });
}

async function isFileReadable(filePath: string): Promise<boolean> {
  try {
    if (typeof IOUtils !== "undefined") {
      return IOUtils.exists(toNativePath(filePath));
    }
    if (typeof OS !== "undefined") {
      return Boolean(await OS.File.exists(toNativePath(filePath)));
    }
  } catch {
    return false;
  }
  return true;
}

function getParseFailureMessage(
  error: unknown,
  phase: ParsePhase,
  hasReadyResult: boolean,
): { id: FluentMessageId; args?: Record<string, string> } {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof MinerURequestError &&
    ["local-poll", "local-download"].includes(error.stage) &&
    error.status === 404
  ) {
    return { id: "parse-error-local-task-lost", args: { message } };
  }
  if (error instanceof MinerURequestError && error.stage.startsWith("local-")) {
    return { id: "parse-error-local-api-unavailable", args: { message } };
  }
  if (
    error instanceof MinerURequestError &&
    ["submit", "upload", "agent-submit", "agent-upload"].includes(error.stage)
  ) {
    return { id: "parse-error-upload", args: { message } };
  }
  if (phase === "download") {
    return { id: "parse-error-download", args: { message } };
  }
  if (phase === "poll" || error instanceof MinerUTaskError) {
    return { id: "parse-error-mineru", args: { message } };
  }
  if (phase === "write" && hasReadyResult) {
    return { id: "parse-error-overwrite", args: { message } };
  }
  return { id: "parse-error-generic", args: { message } };
}

function getMessageText(
  id: FluentMessageId,
  args?: Record<string, string>,
): string {
  return args ? getString(id, { args }) : getString(id);
}

function getSafeMessageText(
  id: FluentMessageId,
  args?: Record<string, string>,
): string {
  try {
    return getMessageText(id, args);
  } catch {
    return id;
  }
}

function getPromptService(win: Window): PromptService | null {
  const runtime = globalThis as typeof globalThis & {
    Services?: { prompt?: unknown };
  };
  const winWithServices = win as Window & {
    Services?: { prompt?: unknown };
  };
  const prompt = runtime.Services?.prompt ?? winWithServices.Services?.prompt;
  if (
    !prompt ||
    typeof (prompt as { confirmEx?: unknown }).confirmEx !== "function"
  ) {
    return null;
  }
  return prompt as PromptService;
}

function basename(path: string): string {
  return (
    path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "file.pdf"
  );
}

export {
  PROGRESS_WINDOW_ICON_URI,
  PROGRESS_WINDOW_LABEL_LINE_HEIGHT_PX,
  PROGRESS_WINDOW_DETAIL_LEFT_OFFSET_PX,
  ELEMENT_NODE_TYPE,
  PROGRESS_WINDOW_PRESENTATION_RETRY_DELAYS_MS,
  type ProgressWindowText,
  type ProgressWindowLineOption,
  normalizeProgressWindowText,
  createProgressWindowLineOptions,
  createProgressWindowDisplayText,
  createProgressWindowDetailLines,
  getProgressWindowItemParent,
  applyProgressWindowItemIcon,
  applyProgressWindowDescriptionLineLayout,
  scheduleProgressWindowPresentation,
  findNextProgressWindowDetailRow,
  styleProgressWindowDetailRow,
  createProgressWindowTexts,
  createParseTaskDetailText,
  getParseTaskDetailID,
  isParseTaskNotice,
  resolveParseNoticeModeLabel,
  resolveParseNoticeSourceLabel,
} from "./parseProgress";
export {
  createTaskResume,
  persistTaskResume,
  updateTaskDetail,
  getTaskResumeDirectory,
  ensureTaskResumeDirectory,
  resetTaskResumeDirectory,
  cleanupLegacyChunkCacheFiles,
  readChunkResult,
  writeChunkResult,
  serializeChunkValue,
  reviveChunkValue,
  cleanupTaskResume,
} from "./parseResume";
export {
  POLL_INTERVAL_MS,
  downloadTaskResultWithRetry,
  waitForTask,
  isTaskNotFoundError,
  isRetryableNetworkError,
  getReconnectDelayMs,
} from "./parseNetwork";
