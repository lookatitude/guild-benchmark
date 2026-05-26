// benchmark/src/codex-review-trail.ts
//
// Local mirror of the Codex review-trail completeness validator.
// No cross-repo imports — pure Node.js builtins only.
//
// Walks a directory of `.md` files and asserts every file's YAML
// frontmatter has `final_status:` set to one of the contract-allowed values:
//
//   - satisfied
//   - skipped-codex-unavailable
//
// Library API:
//   import { verifyCodexReviewTrail } from "./codex-review-trail.js";
//   const result = verifyCodexReviewTrail(dir);
//
// CLI entry:
//   node --import tsx/esm src/codex-review-trail.ts <codex-review-dir>
//
// Exit codes (CLI):
//   0 — every file valid
//   1 — at least one file invalid
//   2 — usage error / missing directory

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Allowed final_status values per the Codex adversarial review standard. */
export const ALLOWED_FINAL_STATUS = [
  "satisfied",
  "skipped-codex-unavailable",
] as const;

export type AllowedFinalStatus = (typeof ALLOWED_FINAL_STATUS)[number];

export interface FileResult {
  path: string;
  ok: boolean;
  finalStatus: string | null;
  reason: string | null;
}

export interface VerifyResult {
  ok: boolean;
  totalFiles: number;
  validFiles: number;
  invalidFiles: number;
  perFile: FileResult[];
}

/**
 * Extract the YAML frontmatter block from a markdown string.
 * Returns `null` when no frontmatter delimiter is found.
 */
export function extractFrontmatter(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length === 0) return null;
  if (lines[0]?.trim() !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      return lines.slice(1, i).join("\n");
    }
  }
  return null;
}

/**
 * Read the `final_status:` value from a frontmatter block.
 * Returns `null` when the key is absent.
 */
export function readFinalStatus(frontmatter: string): string | null {
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^\s*final_status:\s*['"]?([^'"]+?)['"]?\s*$/);
    if (m) return m[1] ?? null;
  }
  return null;
}

/**
 * Validate a single file synchronously.
 */
export function verifyOneFile(filePath: string): FileResult {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return {
      path: filePath,
      ok: false,
      finalStatus: null,
      reason: `could not read file`,
    };
  }
  const fm = extractFrontmatter(text);
  if (!fm) {
    return {
      path: filePath,
      ok: false,
      finalStatus: null,
      reason: `no YAML frontmatter found`,
    };
  }
  const status = readFinalStatus(fm);
  if (!status) {
    return {
      path: filePath,
      ok: false,
      finalStatus: null,
      reason: `final_status key missing from frontmatter`,
    };
  }
  if (!(ALLOWED_FINAL_STATUS as readonly string[]).includes(status)) {
    return {
      path: filePath,
      ok: false,
      finalStatus: status,
      reason: `final_status "${status}" not in allowed set ${JSON.stringify(ALLOWED_FINAL_STATUS)}`,
    };
  }
  return { path: filePath, ok: true, finalStatus: status, reason: null };
}

/**
 * Walk a directory and verify every `.md` file.
 */
export function verifyCodexReviewTrail(dir: string): VerifyResult {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      ok: false,
      totalFiles: 0,
      validFiles: 0,
      invalidFiles: 1,
      perFile: [
        {
          path: dir,
          ok: false,
          finalStatus: null,
          reason: `directory does not exist`,
        },
      ],
    };
  }
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const perFile: FileResult[] = entries.map((f) => verifyOneFile(join(dir, f)));
  const validFiles = perFile.filter((r) => r.ok).length;
  return {
    ok: validFiles === perFile.length,
    totalFiles: perFile.length,
    validFiles,
    invalidFiles: perFile.length - validFiles,
    perFile,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// CLI entrypoint
// ──────────────────────────────────────────────────────────────────────────

function isMainModule(): boolean {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  return /codex-review-trail\.[tj]s$/.test(arg1);
}

function cliMain(argv: string[]): number {
  const dir = argv[2];
  if (!dir) {
    process.stderr.write("usage: codex-review-trail <codex-review-dir>\n");
    return 2;
  }
  if (!existsSync(dir)) {
    process.stderr.write(`directory does not exist: ${dir}\n`);
    return 2;
  }
  if (!statSync(dir).isDirectory()) {
    process.stderr.write(`not a directory: ${dir}\n`);
    return 2;
  }
  const result = verifyCodexReviewTrail(dir);
  if (result.ok) {
    process.stdout.write(
      `verify-codex-review-trail: OK — ${result.validFiles}/${result.totalFiles}\n`,
    );
    return 0;
  }
  process.stderr.write(`verify-codex-review-trail: FAIL\n`);
  for (const f of result.perFile) {
    if (!f.ok) {
      process.stderr.write(`  ${f.path}: ${f.reason}\n`);
    }
  }
  return 1;
}

if (isMainModule()) {
  process.exit(cliMain(process.argv));
}
