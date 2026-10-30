import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { procFdPath, readContainedRegularFile } from "../src/safe-read.js";

// safe-read.ts — fd-path containment (Linux /proc) and the no-O_NOFOLLOW path.

describe("readContainedRegularFile", () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = realpathSync(await mkdtemp(join(tmpdir(), "qa-safe-root-")));
    outside = realpathSync(await mkdtemp(join(tmpdir(), "qa-safe-out-")));
    await mkdir(join(root, "d"));
    await writeFile(join(root, "d", "ok.md"), "inside");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it.skipIf(!existsSync("/proc/self/fd"))("Linux: names the opened fd through /proc", async () => {
    const seen: (string | undefined)[] = [];
    const read = await readContainedRegularFile(join(root, "d", "ok.md"), 1024, root, {
      fdPath: (fd) => {
        const p = procFdPath(fd);
        seen.push(p);
        return p;
      },
    });
    expect(read?.text).toBe("inside");
    expect(seen).toEqual([join(root, "d", "ok.md")]);
  });

  it("refuses when the opened fd resolves outside the root (ancestor swap)", async () => {
    // Every lexical check passes; only the fd's own path is outside.
    const read = await readContainedRegularFile(join(root, "d", "ok.md"), 1024, root, {
      fdPath: () => join(outside, "secret.md"),
    });
    expect(read).toBeUndefined();
  });

  it("without O_NOFOLLOW, refuses a symlinked final component explicitly", async () => {
    await writeFile(join(root, "d", "target.md"), "target");
    await symlink(join(root, "d", "target.md"), join(root, "d", "link.md"));
    const opts = { noFollow: undefined, fdPath: () => undefined };
    expect(await readContainedRegularFile(join(root, "d", "link.md"), 1024, root, opts)).toBeUndefined();
    expect((await readContainedRegularFile(join(root, "d", "ok.md"), 1024, root, opts))?.text).toBe("inside");
  });

  it("without O_NONBLOCK, refuses a FIFO before opening it", async () => {
    execFileSync("mkfifo", [join(root, "d", "pipe")]);
    const read = await readContainedRegularFile(join(root, "d", "pipe"), 1024, root, {
      nonBlock: undefined,
    });
    expect(read).toBeUndefined();
  }, 5000);
});
