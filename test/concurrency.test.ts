import { assert } from "chai";
import { runWithConcurrency } from "../src/utils/concurrency";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function assertRejects(
  callback: () => Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let error: unknown;
  try {
    await callback();
  } catch (caught) {
    error = caught;
  }
  assert.instanceOf(error, Error);
  assert.include((error as Error).message, expectedMessage);
}

describe("concurrency", function () {
  it("resolves immediately when there are no tasks", async function () {
    await runWithConcurrency([], 3);
  });

  it("limits active tasks to the requested concurrency", async function () {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const deferreds: Array<() => void> = [];
    const tasks = [0, 1, 2, 3, 4].map((index) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start-${index}`);
      await new Promise<void>((resolve) => deferreds.push(resolve));
      events.push(`end-${index}`);
      active -= 1;
    });

    const run = runWithConcurrency(tasks, 2);
    await flush();

    assert.equal(maxActive, 2);
    assert.deepEqual(events, ["start-0", "start-1"]);

    deferreds.shift()?.();
    await flush();
    assert.deepEqual(events, ["start-0", "start-1", "end-0", "start-2"]);
    assert.equal(maxActive, 2);

    while (deferreds.length > 0) {
      deferreds.shift()?.();
      await flush();
    }
    await run;

    assert.equal(active, 0);
    assert.equal(events.filter((event) => event.startsWith("end-")).length, 5);
  });

  it("rejects when a task fails", async function () {
    await assertRejects(
      () =>
        runWithConcurrency(
          [
            async () => {
              throw new Error("boom");
            },
          ],
          1,
        ),
      "boom",
    );
  });

  it("rejects with a cancellation error when cancelled", async function () {
    await assertRejects(
      () => runWithConcurrency([async () => {}], 1, () => true),
      "The operation was canceled.",
    );
  });
});
