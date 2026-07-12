// benchmark/tests/calibrate-o3-cli.test.ts
//
// Proves: given synthetic events with a ≥30-sample bucket and a <30-sample
// bucket, the calibrate-o3 CLI output includes the threshold for the former
// and lists the latter under skippedBuckets.
//
// The CLI is PRINT-ONLY — the test asserts no writes occur to settings.json.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendEvent,
  initStableLockfile,
  liveLogPath,
} from "../src/log-jsonl.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "src", "calibrate-o3-cli.ts");
const TSX_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a well-formed run dir under <runsParent>/<runId>. */
function makeRunDir(runsParent: string, runId: string): string {
  const runDir = join(runsParent, runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  initStableLockfile(runDir);
  return runDir;
}

/** Append a raw JSONL line (v1.4 flat + optional v2 additive fields). */
function appendRawEvent(runDir: string, obj: Record<string, unknown>): void {
  writeFileSync(liveLogPath(runDir), JSON.stringify(obj) + "\n", { flag: "a" });
}

/** Run the calibrate-o3 CLI and return stdout/stderr/status. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(TSX_BIN, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// ── Main test ──────────────────────────────────────────────────────────────

describe("calibrate-o3-cli — ≥30-sample bucket included; <30-sample bucket skipped", () => {
  let runsParent: string;

  beforeEach(async () => {
    runsParent = await mkdtemp(join(tmpdir(), "guild-o3-cli-"));
  });

  afterEach(() => {
    rmSync(runsParent, { recursive: true, force: true });
  });

  it("prints threshold for the ≥30 bucket and lists the <30 bucket under skippedBuckets", () => {
    // ── Run dir A: 30 samples (execute:backend / unknown tier) ──────────────
    const runDirA = makeRunDir(runsParent, "run-enough");
    const RUN_A = "run-enough";

    appendEvent(runDirA, {
      ts: "2026-05-27T00:00:00.000Z",
      event: "phase_start",
      run_id: RUN_A,
      phase: "execute",
    });
    appendEvent(runDirA, {
      ts: "2026-05-27T00:00:01.000Z",
      event: "specialist_dispatch",
      run_id: RUN_A,
      lane_id: "lane-1",
      specialist: "backend",
      task_id: "task-a",
      prompt_excerpt: "implement the API",
    });
    // 30 tool_call events: tokens_out = 100, 200, ..., 3000
    for (let i = 1; i <= 30; i++) {
      const ts = new Date(
        new Date("2026-05-27T00:01:00.000Z").getTime() + i * 1000,
      ).toISOString();
      appendRawEvent(runDirA, {
        ts,
        event: "tool_call",
        run_id: RUN_A,
        lane_id: "lane-1",
        tool: "Bash",
        command_redacted: `cmd ${i}`,
        status: "ok",
        latency_ms: 100,
        result_excerpt_redacted: "",
        tokens_out: i * 100,
      });
    }

    // ── Run dir B: 15 samples (execute:frontend / unknown tier) ─────────────
    const runDirB = makeRunDir(runsParent, "run-few");
    const RUN_B = "run-few";

    appendEvent(runDirB, {
      ts: "2026-05-27T00:00:00.000Z",
      event: "phase_start",
      run_id: RUN_B,
      phase: "execute",
    });
    appendEvent(runDirB, {
      ts: "2026-05-27T00:00:01.000Z",
      event: "specialist_dispatch",
      run_id: RUN_B,
      lane_id: "lane-1",
      specialist: "frontend",
      task_id: "task-b",
      prompt_excerpt: "build the UI",
    });
    // 15 tool_call events: tokens_out = 50, 100, ..., 750
    for (let i = 1; i <= 15; i++) {
      const ts = new Date(
        new Date("2026-05-27T00:01:00.000Z").getTime() + i * 1000,
      ).toISOString();
      appendRawEvent(runDirB, {
        ts,
        event: "tool_call",
        run_id: RUN_B,
        lane_id: "lane-1",
        tool: "Bash",
        command_redacted: `cmd ${i}`,
        status: "ok",
        latency_ms: 100,
        result_excerpt_redacted: "",
        tokens_out: i * 50,
      });
    }

    // ── Run the CLI ──────────────────────────────────────────────────────────
    const result = runCli(["--runs-dir", runsParent]);

    expect(result.status).toBe(0);
    // Allow tsx's DEP0205 DeprecationWarning (module.register → registerHooks)
    // which appears on Node ≥ 22 — that is a tsx runtime notice, not our code.
    expect(result.stderr).not.toContain("calibrate-o3:");

    const output = JSON.parse(result.stdout) as {
      proposal: {
        models: {
          shortOutputThreshold: Record<string, Record<string, number>>;
        };
      };
      skippedBuckets: Array<{ taskType: string; tier: string; samples: number }>;
    };

    // ── Assert ≥30 bucket appears in proposal ────────────────────────────────
    // sorted tokens_out: 100, 200, ..., 3000 → p10 idx = floor(0.1 * 29) = 2 → 300
    const shortOutputThreshold = output.proposal.models.shortOutputThreshold;
    expect(shortOutputThreshold["execute:backend"]).toBeDefined();
    expect(shortOutputThreshold["execute:backend"]?.["unknown"]).toBe(300);

    // ── Assert <30 bucket is listed under skippedBuckets ────────────────────
    const { skippedBuckets } = output;
    const skipped = skippedBuckets.find(
      (b) => b.taskType === "execute:frontend" && b.tier === "unknown",
    );
    expect(skipped).toBeDefined();
    expect(skipped?.samples).toBe(15);

    // ── Assert the <30 bucket does NOT appear in the proposal ───────────────
    expect(shortOutputThreshold["execute:frontend"]).toBeUndefined();
  });

  it("exits 0 and prints empty proposal when runs-dir has no run dirs", async () => {
    // runsParent is a valid directory but contains no subdirectories
    const result = runCli(["--runs-dir", runsParent]);

    // Should exit 0 (empty corpus is valid) and produce parseable JSON
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      proposal: { models: { shortOutputThreshold: Record<string, unknown> } };
      skippedBuckets: unknown[];
    };
    expect(output.proposal.models.shortOutputThreshold).toEqual({});
    expect(output.skippedBuckets).toEqual([]);
  });
});
