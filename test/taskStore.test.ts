import { assert } from "chai";
import {
  getTaskStoreFilePath,
  taskStore,
  type TaskRecord,
} from "../src/modules/taskStore";

describe("taskStore", function () {
  afterEach(async function () {
    await taskStore.clearHistory();
  });

  it("keeps notifying and saving when a listener throws", async function () {
    await taskStore.waitUntilLoaded();
    const notified: string[] = [];
    const unsubscribeBroken = taskStore.subscribe(() => {
      throw new Error("listener of a closed window");
    });
    const unsubscribeLive = taskStore.subscribe(() => {
      notified.push("live");
    });

    try {
      await taskStore.upsertTask(taskRecord("7301"));
      await taskStore.updateTaskStatus("7301", "failed", "network error");
      await taskStore.waitForPersistence();
    } finally {
      unsubscribeBroken();
      unsubscribeLive();
    }

    assert.equal(taskStore.getTask("7301")?.status, "failed");
    assert.lengthOf(notified, 2);
    const saved = JSON.parse(
      await IOUtils.readUTF8(getTaskStoreFilePath()),
    ) as TaskRecord[];
    assert.equal(saved.find((task) => task.id === "7301")?.status, "failed");
  });

  it("stops notifying a listener after it unsubscribes", async function () {
    await taskStore.waitUntilLoaded();
    let calls = 0;
    const unsubscribe = taskStore.subscribe(() => {
      calls += 1;
    });

    await taskStore.upsertTask(taskRecord("7302"));
    unsubscribe();
    await taskStore.updateTaskStatus("7302", "succeeded");

    assert.equal(calls, 1);
  });

  it("clears stale detail on terminal status and lists running tasks first", async function () {
    await taskStore.waitUntilLoaded();
    await taskStore.upsertTask({
      ...taskRecord("7303"),
      detail: "MinerU connection interrupted; reconnecting (attempt 2, in 6s)",
      createdAt: 1000,
    });
    await taskStore.updateTaskStatus("7303", "failed", "server stopped");
    assert.isUndefined(taskStore.getTask("7303")?.detail);
    assert.equal(taskStore.getTask("7303")?.error, "server stopped");

    await taskStore.upsertTask({
      ...taskRecord("7304"),
      status: "running",
      createdAt: 500,
    });
    await taskStore.upsertTask({
      ...taskRecord("7305"),
      status: "succeeded",
      createdAt: 2000,
    });
    const ids = taskStore.getTasks().map((t) => t.id);
    assert.equal(ids[0], "7304");
  });
});

function taskRecord(id: string): TaskRecord {
  return {
    id,
    attachment: {
      id: Number(id),
      key: `TASK${id}`,
      libraryID: 1,
      fileName: "a.pdf",
      filePath: "/tmp/a.pdf",
      mtime: 1,
    },
    title: "Task store test",
    status: "running",
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
