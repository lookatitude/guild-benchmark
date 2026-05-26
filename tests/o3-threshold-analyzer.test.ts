// benchmark/tests/o3-threshold-analyzer.test.ts
//
// VC-OBS-3 pins: "no shortOutputThreshold block for a bucket with <30 samples;
// once ≥30, the analyzer writes it to settings.json" — here expressed as the
// proposal output (the analyzer proposes, never auto-writes).
//
// Tests prove:
//   1. ≥30 samples → correct p10 threshold emitted for the bucket.
//   2. <30 samples → bucket omitted from proposal (skippedBuckets only).
//   3. v2 `tier` field used for bucket key when present.
//   4. v2 `tokens.output` used in preference to flat `tokens_out`.
//   5. p10 statistic: spot-checks on known arrays.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendEvent,
  initStableLockfile,
  liveLogPath,
} from "../src/log-jsonl.js";
import {
  analyzeRuns,
  MIN_SAMPLES,
  p10,
  type ThresholdProposal,
} from "../src/o3-threshold-analyzer.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeRunDir(tmpRoot: string, runId: string): string {
  const runDir = join(tmpRoot, "runs", runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  initStableLockfile(runDir);
  return runDir;
}

/** Append a raw JSONL line (bypasses TypeScript type — used for v2 extra fields). */
function appendRawEvent(runDir: string, obj: Record<string, unknown>): void {
  writeFileSync(liveLogPath(runDir), JSON.stringify(obj) + "\n", { flag: "a" });
}

// ──────────────────────────────────────────────────────────────────────────────
// p10 statistic
// ──────────────────────────────────────────────────────────────────────────────

describe("p10 statistic (D-OBS-3 threshold formula)", () => {
  it("returns 0 for empty array", () => {
    expect(p10([])).toBe(0);
  });

  it("returns the only element for a single-element array", () => {
    expect(p10([42])).toBe(42);
  });

  it("floor(0.1 * (n-1)) on 10-element array [1..10]", () => {
    // idx = floor(0.1 * 9) = 0 → values[0] = 1
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(p10(values)).toBe(1);
  });

  it("floor(0.1 * (n-1)) on 100-element array [1..100]", () => {
    // idx = floor(0.1 * 99) = 9 → values[9] = 10
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p10(values)).toBe(10);
  });

  it("floor(0.1 * (n-1)) on 30-element array [1..30]", () => {
    // idx = floor(0.1 * 29) = 2 → values[2] = 3
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(p10(values)).toBe(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// VC-OBS-3: ≥30 samples → threshold emitted; <30 → omitted
// ──────────────────────────────────────────────────────────────────────────────

describe("analyzeRuns — O-3 threshold derivation (VC-OBS-3)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "guild-o3-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("≥30 samples → correct p10 threshold emitted in proposal (v1.4 tokens_out)", async () => {
    const RUN_ID = "run-o3-enough";
    const runDir = makeRunDir(tmpRoot, RUN_ID);

    // phase_start context
    appendEvent(runDir, {
      ts: "2026-05-27T00:00:00.000Z",
      event: "phase_start",
      run_id: RUN_ID,
      phase: "execute",
    });

    // specialist_dispatch context
    appendEvent(runDir, {
      ts: "2026-05-27T00:00:01.000Z",
      event: "specialist_dispatch",
      run_id: RUN_ID,
      lane_id: "lane-1",
      specialist: "backend",
      task_id: "task-1",
      prompt_excerpt: "implement the API",
    });

    // 30 tool_call events with tokens_out (v1.4 flat field)
    // tokens_out: 100, 200, ..., 3000
    for (let i = 1; i <= 30; i++) {
      const ts = `2026-05-27T00:01:${String(i).padStart(2, "0")}.000Z`;
      // Use appendRawEvent so tokens_out survives without TypeScript stripping
      appendRawEvent(runDir, {
        ts,
        event: "tool_call",
        run_id: RUN_ID,
        lane_id: "lane-1",
        tool: "Bash",
        command_redacted: `cmd ${i}`,
        status: "ok",
        latency_ms: 100,
        result_excerpt_redacted: "",
        tokens_out: i * 100,
      });
    }

    const proposal: ThresholdProposal = await analyzeRuns({ runDirs: [runDir] });

    // Exactly one qualifying bucket
    expect(proposal.buckets).toHaveLength(1);
    const bucket = proposal.buckets[0]!;
    expect(bucket.taskType).toBe("execute:backend");
    expect(bucket.tier).toBe("unknown"); // no v2 tier field
    expect(bucket.samples).toBe(30);
    // sorted tokens_out: 100, 200, 300, ..., 3000
    // p10 idx = floor(0.1 * 29) = 2 → values[2] = 300
    expect(bucket.p10).toBe(300);

    // Proposed fragment
    expect(proposal.thresholds["execute:backend"]?.["unknown"]).toBe(300);

    // No skipped buckets
    expect(proposal.skippedBuckets).toHaveLength(0);
  });

  it("<30 samples → bucket omitted from proposal (VC-OBS-3 gate)", async () => {
    const RUN_ID = "run-o3-few";
    const runDir = makeRunDir(tmpRoot, RUN_ID);

    appendEvent(runDir, {
      ts: "2026-05-27T00:00:00.000Z",
      event: "phase_start",
      run_id: RUN_ID,
      phase: "execute",
    });

    appendEvent(runDir, {
      ts: "2026-05-27T00:00:01.000Z",
      event: "specialist_dispatch",
      run_id: RUN_ID,
      lane_id: "lane-1",
      specialist: "frontend",
      task_id: "task-2",
      prompt_excerpt: "build the UI",
    });

    // Only 15 samples — below MIN_SAMPLES (30)
    for (let i = 1; i <= 15; i++) {
      const ts = `2026-05-27T00:01:${String(i).padStart(2, "0")}.000Z`;
      appendRawEvent(runDir, {
        ts,
        event: "tool_call",
        run_id: RUN_ID,
        lane_id: "lane-1",
        tool: "Bash",
        command_redacted: `cmd ${i}`,
        status: "ok",
        latency_ms: 100,
        result_excerpt_redacted: "",
        tokens_out: i * 50,
      });
    }

    const proposal = await analyzeRuns({ runDirs: [runDir] });

    // No qualifying buckets → empty proposal
    expect(proposal.buckets).toHaveLength(0);
    expect(proposal.thresholds).toEqual({});

    // Under-sampled bucket is reported in skippedBuckets
    expect(proposal.skippedBuckets).toHaveLength(1);
    const skipped = proposal.skippedBuckets[0]!;
    expect(skipped.taskType).toBe("execute:frontend");
    expect(skipped.tier).toBe("unknown");
    expect(skipped.samples).toBe(15);
  });

  it("v2 `tier` field used as bucket dimension when present", async () => {
    const RUN_ID = "run-o3-tiered";
    const runDir = makeRunDir(tmpRoot, RUN_ID);

    appendEvent(runDir, {
      ts: "2026-05-27T00:00:00.000Z",
      event: "phase_start",
      run_id: RUN_ID,
      phase: "plan",
    });

    appendEvent(runDir, {
      ts: "2026-05-27T00:00:01.000Z",
      event: "specialist_dispatch",
      run_id: RUN_ID,
      lane_id: "lane-1",
      specialist: "architect",
      task_id: "task-3",
      prompt_excerpt: "plan the work",
    });

    // 30 events with v2 `tier: "powerful"` field
    const base = new Date("2026-05-27T00:01:00.000Z");
    for (let i = 1; i <= 30; i++) {
      const ts = new Date(base.getTime() + i * 1000).toISOString();
      appendRawEvent(runDir, {
        ts,
        event: "tool_call",
        run_id: RUN_ID,
        lane_id: "lane-1",
        tool: "Agent",
        command_redacted: `dispatch ${i}`,
        status: "ok",
        latency_ms: 500,
        result_excerpt_redacted: "",
        tier: "powerful",
        tokens_out: i * 100,
      });
    }

    const proposal = await analyzeRuns({ runDirs: [runDir] });

    expect(proposal.buckets).toHaveLength(1);
    const bucket = proposal.buckets[0]!;
    expect(bucket.taskType).toBe("plan:architect");
    expect(bucket.tier).toBe("powerful");
    expect(bucket.samples).toBe(30);
    // sorted tokens_out: 100, 200, ..., 3000 → p10 idx=2 → 300
    expect(bucket.p10).toBe(300);
    expect(proposal.thresholds["plan:architect"]?.["powerful"]).toBe(300);
  });

  it("v2 `tokens.output` preferred over flat `tokens_out`", async () => {
    const RUN_ID = "run-o3-v2-tokens";
    const runDir = makeRunDir(tmpRoot, RUN_ID);

    appendEvent(runDir, {
      ts: "2026-05-27T00:00:00.000Z",
      event: "phase_start",
      run_id: RUN_ID,
      phase: "execute",
    });

    appendEvent(runDir, {
      ts: "2026-05-27T00:00:01.000Z",
      event: "specialist_dispatch",
      run_id: RUN_ID,
      lane_id: "lane-1",
      specialist: "qa",
      task_id: "task-4",
      prompt_excerpt: "run tests",
    });

    // 30 events with v2 `tokens.output` (should be preferred over tokens_out)
    const base = new Date("2026-05-27T00:01:00.000Z");
    for (let i = 1; i <= 30; i++) {
      const ts = new Date(base.getTime() + i * 1000).toISOString();
      appendRawEvent(runDir, {
        ts,
        event: "tool_call",
        run_id: RUN_ID,
        lane_id: "lane-1",
        tool: "Bash",
        command_redacted: `test ${i}`,
        status: "ok",
        latency_ms: 200,
        result_excerpt_redacted: "",
        // v2 nested tokens — should be used (D-OBS-1)
        tokens: { input: 500, output: i * 200, cached: 100, cost_usd: 0.001 },
        // flat tokens_out is also present (lower value) — must NOT be used
        tokens_out: i * 50,
        tier: "mid",
      });
    }

    const proposal = await analyzeRuns({ runDirs: [runDir] });

    expect(proposal.buckets).toHaveLength(1);
    const bucket = proposal.buckets[0]!;
    expect(bucket.taskType).toBe("execute:qa");
    expect(bucket.tier).toBe("mid");
    // sorted tokens.output: 200, 400, ..., 6000 → p10 idx=2 → 600
    expect(bucket.p10).toBe(600);
    // NOT based on tokens_out (which would give idx=2 → 150)
    expect(bucket.p10).not.toBe(150);
  });

  it("multiple run dirs are aggregated before gating", async () => {
    // Split 30 samples across 2 run dirs: 15 each.
    // Each alone is <30, but combined ≥30 → threshold emitted.
    const runDirs: string[] = [];

    for (let r = 0; r < 2; r++) {
      const RUN_ID = `run-o3-multi-${r}`;
      const runDir = makeRunDir(tmpRoot, RUN_ID);
      runDirs.push(runDir);

      appendEvent(runDir, {
        ts: "2026-05-27T00:00:00.000Z",
        event: "phase_start",
        run_id: RUN_ID,
        phase: "build",
      });

      appendEvent(runDir, {
        ts: "2026-05-27T00:00:01.000Z",
        event: "specialist_dispatch",
        run_id: RUN_ID,
        lane_id: "lane-1",
        specialist: "devops",
        task_id: `task-r${r}`,
        prompt_excerpt: "deploy",
      });

      for (let i = 1; i <= 15; i++) {
        const ts = new Date(
          new Date("2026-05-27T00:01:00.000Z").getTime() + i * 1000,
        ).toISOString();
        appendRawEvent(runDir, {
          ts,
          event: "tool_call",
          run_id: RUN_ID,
          lane_id: "lane-1",
          tool: "Bash",
          command_redacted: `deploy ${i}`,
          status: "ok",
          latency_ms: 100,
          result_excerpt_redacted: "",
          tokens_out: (r * 15 + i) * 100,
        });
      }
    }

    const proposal = await analyzeRuns({ runDirs });

    // Combined 30 samples → one qualifying bucket
    expect(proposal.buckets).toHaveLength(1);
    expect(proposal.buckets[0]!.taskType).toBe("build:devops");
    expect(proposal.buckets[0]!.samples).toBe(30);
    expect(proposal.skippedBuckets).toHaveLength(0);
  });

  it("MIN_SAMPLES is 30 (VC-OBS-3 gate constant)", () => {
    expect(MIN_SAMPLES).toBe(30);
  });
});
