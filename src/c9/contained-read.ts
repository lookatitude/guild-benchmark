// c9/contained-read.ts — synchronous, read-only, contained file reads under a
// source's `.guild/` for the C9 project read service.
//
// Port of the plugin's `checkContained(root, rel, { policy: "physical",
// requireRegularFileLeaf: true })` read path (no write helpers, no plugin import):
// a `..` spelling, a path resolving outside the root, a dangling link, a symlinked
// segment strictly inside the root and a non-regular leaf are all refused. The
// file is opened with O_NOFOLLOW and fstat'd on the handle; reads are bounded.

import * as fs from "node:fs";
import * as path from "node:path";

/** A retained trace holds at most 100k events of at most 256 KiB each; a file past this is refused. */
export const RETAINED_READ_MAX_BYTES = 256 * 1024 * 1024;

export type Retained = { state: "absent" } | { state: "refused" } | { state: "present"; bytes: Buffer };

const escapes = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** The contained real path of `<root>/.guild/<guildRel>`, `"absent"`, or `"refused"`. */
function containedPath(root: string, guildRel: string): string | "absent" | "refused" {
  if (guildRel.split(/[\\/]/).includes("..")) return "refused";
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
  } catch {
    return "refused";
  }
  const abs = path.resolve(realRoot, ".guild", guildRel);
  // Every segment below the real root: a symlink resolving strictly inside the root is refused,
  // one resolving outside it is refused by the realpath check below.
  let walk = realRoot;
  for (const seg of path.relative(realRoot, abs).split(path.sep)) {
    if (seg === "" || seg === ".") continue;
    walk = path.join(walk, seg);
    const st = lstatOrNull(walk);
    if (st === null) return "absent";
    if (st.isSymbolicLink()) return "refused";
  }
  const leaf = lstatOrNull(abs);
  if (leaf === null) return "absent";
  if (!leaf.isFile()) return "refused";
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return "refused";
  }
  const rel = path.relative(realRoot, real);
  if (rel === "" || escapes(rel)) return "refused";
  return real;
}

/** Read one retained input (`.guild`-relative). Never follows a link, never writes. */
export function readRetained(root: string, guildRel: string, maxBytes = RETAINED_READ_MAX_BYTES): Retained {
  const p = containedPath(root, guildRel);
  if (p === "absent") return { state: "absent" };
  if (p === "refused") return { state: "refused" };
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "refused" };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > maxBytes) return { state: "refused" };
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let total = 0;
    for (;;) {
      if (total === buf.length) return { state: "refused" };
      const n = fs.readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    return { state: "present", bytes: buf.subarray(0, total) };
  } catch {
    return { state: "refused" };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Text of a retained input, or null when absent. A present input that cannot be
 * read (permissions, link, non-regular, over bound) throws by default, so its
 * run becomes a known run with unknown facts instead of reading as absent.
 */
export function readContainedText(root: string, guildRel: string, onRefused: "throw" | "null" = "throw"): string | null {
  const r = readRetained(root, guildRel);
  if (r.state === "refused" && onRefused === "throw") throw new Error(`input refused: ${guildRel} is not a readable contained regular file`);
  return r.state === "present" ? r.bytes.toString("utf8") : null;
}
