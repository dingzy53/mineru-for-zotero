import { assert } from "chai";
import { removeOrphanResumeDirectories } from "../src/modules/taskResumeDirectory";

describe("removeOrphanResumeDirectories", function () {
  let dataDirectory: string;
  let resumeRoot: string;

  beforeEach(async function () {
    dataDirectory = PathUtils.join(
      PathUtils.tempDir,
      `mineru-data-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    resumeRoot = PathUtils.join(dataDirectory, "mineru-resume");
    await IOUtils.makeDirectory(resumeRoot, { createAncestors: true });
  });

  afterEach(async function () {
    await IOUtils.remove(dataDirectory, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  it("removes only empty directories that belong to no task", async function () {
    for (const name of ["186", "230", "342", "400"]) {
      await IOUtils.makeDirectory(PathUtils.join(resumeRoot, name));
    }
    // 230 has a task record; 342 still holds a paid-for chunk.
    await IOUtils.writeUTF8(
      PathUtils.join(resumeRoot, "342", "part-0-result.json"),
      "{}",
    );
    await IOUtils.writeUTF8(PathUtils.join(resumeRoot, "stray.txt"), "x");
    const logged: string[] = [];

    const result = await removeOrphanResumeDirectories({
      hasTask: (taskID) => taskID === "230",
      dataDirectory,
      log: (message) => logged.push(message),
    });

    assert.deepEqual(result, { removed: ["186", "400"], kept: ["342"] });
    assert.isFalse(await IOUtils.exists(PathUtils.join(resumeRoot, "186")));
    assert.isFalse(await IOUtils.exists(PathUtils.join(resumeRoot, "400")));
    assert.isTrue(await IOUtils.exists(PathUtils.join(resumeRoot, "230")));
    assert.isTrue(
      await IOUtils.exists(
        PathUtils.join(resumeRoot, "342", "part-0-result.json"),
      ),
    );
    assert.isTrue(
      await IOUtils.exists(PathUtils.join(resumeRoot, "stray.txt")),
    );
    assert.lengthOf(logged, 1);
    assert.include(logged[0], "342");
  });

  it("does nothing when there is no resume folder", async function () {
    await IOUtils.remove(resumeRoot, { recursive: true });

    const result = await removeOrphanResumeDirectories({
      hasTask: () => false,
      dataDirectory,
    });

    assert.deepEqual(result, { removed: [], kept: [] });
  });
});
