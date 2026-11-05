// c9/source-identity.ts — the canonical C9 source id of a guild root, computed
// exactly as the plugin's StackScope/readRootIdentity do (no plugin import).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The source identity the plugin writes into trace lineage: `source:` + its guild
 * root id (sanitised basename of the real root + first 12 hex of sha256 of it).
 * Display names are not identities; an offline root falls back to its lexical path.
 */
export function canonicalSourceId(root: string): string {
  let abs: string;
  try {
    abs = path.resolve(fs.realpathSync(root));
  } catch {
    abs = path.resolve(root);
  }
  const digest = crypto.createHash("sha256").update(abs).digest("hex").slice(0, 12);
  const base = path.basename(abs).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return `source:${base}-${digest}`;
}
