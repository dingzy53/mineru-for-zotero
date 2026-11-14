import { joinNativePath } from "./mineruClient/path";

/**
 * Directory holding the per-chunk resume cache of an attachment.
 *
 * It lives in the Zotero data directory (not the Mozilla profile directory) so
 * it migrates together with the library. Kept in its own module so both the
 * task store and the resume layer can use it without an import cycle.
 */
export function getTaskResumeDirectory(
  attachmentID: number,
  dataDirectory: string = Zotero.DataDirectory.dir,
): string {
  return joinNativePath(dataDirectory, "mineru-resume", String(attachmentID));
}

/**
 * Remove every cached chunk of an attachment. Best effort: the directory may
 * not exist, and a cleanup failure must never break the caller.
 */
export async function removeTaskResumeDirectory(
  attachmentID: number,
): Promise<void> {
  if (typeof IOUtils === "undefined" || !Number.isFinite(attachmentID)) {
    return;
  }
  try {
    await IOUtils.remove(getTaskResumeDirectory(attachmentID), {
      recursive: true,
    });
  } catch {
    // The directory may be absent or already removed.
  }
}

/**
 * Remove resume directories that are empty and belong to no task.
 *
 * `cleanupTaskResume()` and `clearHistory()` only reach tasks that still have
 * a record, so a directory whose task is gone would otherwise stay forever.
 * A directory that still holds files is never touched: it may be the only
 * copy of chunks the user paid for. It is logged and listed in `kept`.
 */
export async function removeOrphanResumeDirectories(input: {
  /** Whether a task record exists for this id (the attachment id). */
  hasTask(taskID: string): boolean;
  dataDirectory?: string;
  log?(message: string): void;
}): Promise<{ removed: string[]; kept: string[] }> {
  const result = { removed: [] as string[], kept: [] as string[] };
  if (typeof IOUtils === "undefined") {
    return result;
  }
  const root = joinNativePath(
    input.dataDirectory ?? Zotero.DataDirectory.dir,
    "mineru-resume",
  );

  let directories: string[];
  try {
    directories = await IOUtils.getChildren(root);
  } catch {
    // No parse has needed resume data yet.
    return result;
  }

  for (const directory of directories.sort()) {
    const name = directory.split(/[\\/]/).pop() ?? "";
    try {
      if (
        input.hasTask(name) ||
        (await IOUtils.stat(directory)).type !== "directory"
      ) {
        continue;
      }
      if ((await IOUtils.getChildren(directory)).length > 0) {
        result.kept.push(name);
        input.log?.(`MinerU resume data without a task was kept: ${directory}`);
        continue;
      }
      // Not recursive: a file written since the check makes this fail.
      await IOUtils.remove(directory);
      result.removed.push(name);
    } catch (error) {
      input.log?.(`MinerU resume cleanup skipped ${directory}: ${error}`);
    }
  }
  return result;
}
