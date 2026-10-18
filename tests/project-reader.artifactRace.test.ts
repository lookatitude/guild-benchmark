import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileDeep } from "./project.helpers.js";

// Swap a path component to an external symlink in the window between the
// containment check and the open (codex W3 round 2, finding 1).
const swap: { before?: () => Promise<void> } = {};
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const hook = swap.before;
      swap.before = undefined;
      if (hook) await hook();
      return real.open(...args);
    },
  };
});

const { readProjectRunArtifact, ProjectReadError } = await import("../src/project-reader.js");

describe("readProjectRunArtifact — check/open swap race", () => {
  let root: string;
  let outside: string;
  const RUN = "run-race";
  const runDir = () => join(root, ".guild", "runs", RUN);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "qa-race-root-"));
    outside = await mkdtemp(join(tmpdir(), "qa-race-out-"));
    await writeFileDeep(join(runDir(), "run.yaml"), `run_id: ${RUN}\n`);
    await writeFileDeep(join(runDir(), "logs", "a.txt"), "inside");
    await writeFileDeep(join(outside, "logs", "a.txt"), "TOP-SECRET");
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET");
  });

  afterEach(async () => {
    swap.before = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("reads the contained file when nothing is swapped", async () => {
    const file = await readProjectRunArtifact(root, RUN, ["logs", "a.txt"]);
    expect(file.body.toString()).toBe("inside");
  });

  it("refuses when the final file is swapped to an external symlink", async () => {
    swap.before = async () => {
      await rm(join(runDir(), "logs", "a.txt"));
      await symlink(join(outside, "secret.txt"), join(runDir(), "logs", "a.txt"));
    };
    await expect(readProjectRunArtifact(root, RUN, ["logs", "a.txt"])).rejects.toBeInstanceOf(
      ProjectReadError,
    );
  });

  it("refuses when an ancestor directory is swapped to an external symlink", async () => {
    swap.before = async () => {
      await rename(join(runDir(), "logs"), join(runDir(), "logs-moved"));
      await symlink(join(outside, "logs"), join(runDir(), "logs"));
    };
    await expect(readProjectRunArtifact(root, RUN, ["logs", "a.txt"])).rejects.toBeInstanceOf(
      ProjectReadError,
    );
  });
});
