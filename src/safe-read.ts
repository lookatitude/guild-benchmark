// safe-read.ts — bounded, no-follow read of one regular file.
//
// Opens once (O_NOFOLLOW so a final symlink is refused, O_NONBLOCK so a FIFO
// cannot hang the open), fstats the handle, confirms the opened fd itself is
// inside `containRoot` (Linux: /proc/self/fd), confirms the lexical path still
// realpaths to the same inode inside `containRoot`, and reads from the handle
// with a byte cap. Any refusal returns undefined; callers treat it as absent.

import { constants as fsConstants, existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

export interface BoundedRead {
  text: string;
  mtime: Date;
}

export interface SafeReadOptions {
  /** Test seam: open flags; `undefined` means the platform lacks the flag. */
  noFollow?: number | undefined;
  nonBlock?: number | undefined;
  /** Test seam: resolve the path an open fd refers to, or undefined when unknown. */
  fdPath?: (fd: number) => string | undefined;
}

/** Linux: the kernel's path for an open fd. Elsewhere undefined. */
export function procFdPath(fd: number): string | undefined {
  if (!existsSync("/proc/self/fd")) return undefined;
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

const DEFAULTS: SafeReadOptions & { fdPath: (fd: number) => string | undefined } = {
  noFollow: fsConstants.O_NOFOLLOW,
  nonBlock: fsConstants.O_NONBLOCK,
  fdPath: procFdPath,
};

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `containRoot` must already be a realpath. */
export async function readContainedRegularFile(
  file: string,
  maxBytes: number,
  containRoot: string,
  opts: SafeReadOptions = {},
): Promise<BoundedRead | undefined> {
  const { noFollow, nonBlock, fdPath } = { ...DEFAULTS, ...opts };
  // Without O_NOFOLLOW / O_NONBLOCK, refuse a symlinked or non-regular final
  // component explicitly before opening.
  if (noFollow === undefined || nonBlock === undefined) {
    try {
      if (!lstatSync(file).isFile()) return undefined;
    } catch {
      return undefined;
    }
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (noFollow ?? 0) | (nonBlock ?? 0));
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return undefined;
    // Where the platform can name the opened fd (Linux /proc), require it
    // contained: this closes an ancestor-directory symlink swap around open.
    // Elsewhere (darwin, no F_GETPATH in Node) only the realpath + inode checks
    // below run; the residual window needs same-user write access to .guild/
    // during a request.
    const opened = fdPath(handle.fd);
    if (opened !== undefined && !isInside(containRoot, opened)) return undefined;
    let real: string;
    try {
      real = realpathSync(file);
    } catch {
      return undefined;
    }
    if (!isInside(containRoot, real)) return undefined;
    const now = statSync(real);
    if (now.dev !== st.dev || now.ino !== st.ino) return undefined;
    // Read at most maxBytes + 1 so growth after fstat is detected and refused.
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return undefined;
    return { text: buf.subarray(0, total).toString("utf8"), mtime: st.mtime };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
