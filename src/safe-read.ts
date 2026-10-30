// safe-read.ts — bounded, no-follow read of one regular file.
//
// Opens once (O_NOFOLLOW so a final symlink is refused, O_NONBLOCK so a FIFO
// cannot hang the open), fstats the handle, confirms the lexical path still
// realpaths to the same inode inside `containRoot`, and reads from the handle
// with a byte cap. Any refusal returns undefined; callers treat it as absent.

import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export interface BoundedRead {
  text: string;
  mtime: Date;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** `containRoot` must already be a realpath. */
export async function readContainedRegularFile(
  file: string,
  maxBytes: number,
  containRoot: string,
): Promise<BoundedRead | undefined> {
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > maxBytes) return undefined;
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
