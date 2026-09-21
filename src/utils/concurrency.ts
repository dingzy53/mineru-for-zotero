/**
 * Run async tasks with a bounded number of concurrent workers.
 *
 * Tasks are started in order. The promise rejects as soon as any task fails
 * (in-flight tasks keep running but their results are ignored) and rejects with
 * `The operation was canceled.` when `isCancelled` reports true.
 */
export async function runWithConcurrency(
  tasks: ReadonlyArray<() => Promise<void>>,
  concurrency: number,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const queue = [...tasks];
  let active = 0;

  await new Promise<void>((resolve, reject) => {
    let hasError = false;
    const next = () => {
      if (hasError) return;
      if (isCancelled()) {
        hasError = true;
        reject(new Error("The operation was canceled."));
        return;
      }
      if (queue.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const task = queue.shift()!;
        active++;
        task()
          .then(() => {
            active--;
            next();
          })
          .catch((error) => {
            hasError = true;
            reject(error);
          });
      }
    };
    next();
  });
}
