import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyRunType,
  classifyRunTypeFromRun,
  importLifecycleRun,
  listLifecycleRunDirs,
} from "../src/lifecycle-importer.js";
import { renderTimeline } from "../src/lifecycle-timeline.js";
import { extractLifecycleMetrics } from "../src/lifecycle-metrics.js";
import type { LifecycleRunRecord } from "../src/types.js";

const FIXTURES = resolve(__dirname, "fixtures", "lifecycle");

// The importer validates that sourceRunDir is a `.guild/runs/<id>` directory.
// Each fixture tree already has that shape; we copy the fixture's `.guild` into
// a temp root so imports run against a real on-disk `.guild/runs/<id>`.
async function stageFixture(workDir: string, fixtureName: string): Promise<string> {
  const dest = join(workDir, fixtureName);
  await mkdir(dest, { recursive: true });
  await cp(join(FIXTURES, fixtureName, ".guild"), join(dest, ".guild"), {
    recursive: true,
  });
  return dest; // the staged project root containing `.guild/`
}

describe("lifecycle-importer / classifyRunType", () => {
  it("maps every §435 command to its run type", () => {
    expect(classifyRunType("/guild:learn")).toBe("learn");
    expect(classifyRunType("/guild:ideate")).toBe("ideate");
    expect(classifyRunType("/guild:plan")).toBe("plan");
    expect(classifyRunType("/guild:build")).toBe("build");
    expect(classifyRunType("/guild:qa")).toBe("qa");
    expect(classifyRunType("/guild:ops")).toBe("ops");
    expect(classifyRunType("/guild:status")).toBe("status");
    expect(classifyRunType("/guild:guild")).toBe("build");
  });

  it("returns unknown for unrecognised commands", () => {
    expect(classifyRunType("/guild:nope")).toBe("unknown");
    expect(classifyRunType(undefined)).toBe("unknown");
  });
});

describe("lifecycle-importer / classifyRunTypeFromRun (smart-dispatcher phase derivation)", () => {
  // Non-dispatcher commands: phases_log is ignored; authoritative COMMAND_TO_RUN_TYPE wins.
  it("non-dispatcher commands use the direct command mapping regardless of phases_log", () => {
    const buildPhases = [{ phase: "build-wave-1" }, { phase: "build-wave-2" }];
    expect(classifyRunTypeFromRun("/guild:learn", buildPhases)).toBe("learn");
    expect(classifyRunTypeFromRun("/guild:plan", buildPhases)).toBe("plan");
    expect(classifyRunTypeFromRun("/guild:qa", [])).toBe("qa");
    expect(classifyRunTypeFromRun("/guild:ideate", undefined)).toBe("ideate");
  });

  // /guild:guild with phases_log topping out at ideate => ideate (not build).
  it("/guild:guild with phases_log topped at ideate classifies as ideate", () => {
    const ideateOnlyPhases = [
      { phase: "detect" },
      { phase: "ideate" },
    ];
    expect(classifyRunTypeFromRun("/guild:guild", ideateOnlyPhases)).toBe("ideate");
  });

  // /guild:guild with phases_log topped at plan => plan.
  it("/guild:guild with phases_log topped at plan classifies as plan", () => {
    const planPhases = [
      { phase: "detect" },
      { phase: "ideate" },
      { phase: "plan" },
    ];
    expect(classifyRunTypeFromRun("/guild:guild", planPhases)).toBe("plan");
  });

  // /guild:guild with build-wave-* phases => build.
  it("/guild:guild with build-wave phases (the real lkc run shape) classifies as build", () => {
    const lkcPhases = [
      { phase: "detect" },
      { phase: "ideate" },
      { phase: "plan" },
      { phase: "build-wave-1" },
      { phase: "build-wave-2" },
    ];
    expect(classifyRunTypeFromRun("/guild:guild", lkcPhases)).toBe("build");
  });

  // /guild:guild with verify phase (deepest reached) => build (verify is a build sub-phase).
  it("/guild:guild with a verify phase classifies as build", () => {
    const verifyPhases = [
      { phase: "detect" },
      { phase: "plan" },
      { phase: "build-wave-1" },
      { phase: "verify" },
    ];
    expect(classifyRunTypeFromRun("/guild:guild", verifyPhases)).toBe("build");
  });

  // /guild:guild with no phases_log (absent or empty) falls back to "build".
  it("/guild:guild with no phases_log falls back to build", () => {
    expect(classifyRunTypeFromRun("/guild:guild", undefined)).toBe("build");
    expect(classifyRunTypeFromRun("/guild:guild", [])).toBe("build");
  });

  // /guild:guild with ops phases => ops.
  it("/guild:guild with ops phase classifies as ops", () => {
    expect(classifyRunTypeFromRun("/guild:guild", [{ phase: "ops" }])).toBe("ops");
  });

  // /guild:guild with qa phase => qa.
  it("/guild:guild with qa phase classifies as qa", () => {
    expect(classifyRunTypeFromRun("/guild:guild", [{ phase: "qa" }])).toBe("qa");
  });

  // Unknown dispatcher — unrecognised command still returns unknown regardless of phases.
  it("unrecognised command returns unknown even with phases_log", () => {
    expect(classifyRunTypeFromRun(undefined, [{ phase: "build-wave-1" }])).toBe("unknown");
    expect(classifyRunTypeFromRun("/guild:nope", [{ phase: "plan" }])).toBe("unknown");
  });
});

describe("lifecycle-importer / importLifecycleRun", () => {
  let workDir: string;
  let runsDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "lifecycle-import-"));
    runsDir = join(workDir, "benchmark-runs");
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("imports a full-class learn run end-to-end with all artifacts", async () => {
    const root = await stageFixture(workDir, "learn-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-learn-001");
    const { record, runDir, sourceRunId } = await importLifecycleRun({
      sourceRunDir,
      runsDir,
    });

    expect(sourceRunId).toBe("run-learn-001");
    expect(record.run_type).toBe("learn");
    expect(record.run_class).toBe("full");
    expect(record.benchmark_eligible).toBe(true);
    expect(record.partial).toBe(false);
    expect(record.status).toBe("closed");
    expect(record.closed_at).toBe("2026-05-29T08:10:00Z");

    // Captured artifacts on disk (mirrors importAuditRun).
    expect(
      existsSync(join(runDir, "artifacts", ".guild", "runs", "run-learn-001", "run.yaml")),
    ).toBe(true);
    expect(existsSync(join(runDir, "lifecycle-record.json"))).toBe(true);
  });

  it("renders the entry-to-close timeline from phases_log + trace + markers", async () => {
    const root = await stageFixture(workDir, "learn-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-learn-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });

    // Timeline merges phases_log (detect, learn) + phase_start/end + gate +
    // run_started/run_closed, sorted by `at`.
    const kinds = record.timeline.map((t) => t.kind);
    expect(kinds).toContain("run_started");
    expect(kinds).toContain("run_closed");
    expect(kinds).toContain("phase");
    expect(kinds).toContain("gate");
    // First entry is the earliest timestamp (run_started or detect @ 08:00:00).
    expect(record.timeline[0].at).toBe("2026-05-29T08:00:00Z");
    // Last entry is the run_closed marker @ 08:10:00.
    expect(record.timeline[record.timeline.length - 1].kind).toBe("run_closed");
  });

  it("extracts the §488-505 metric set from on-disk artifacts", async () => {
    const root = await stageFixture(workDir, "learn-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-learn-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    const m = record.metrics;

    // time to project understanding: detect 08:00:00 -> learn 08:05:00 = 5min.
    expect(m.time_to_project_understanding_ms).toBe(5 * 60 * 1000);
    // coverage from provenance.coverage.
    expect(m.file_coverage_count).toBe(42);
    expect(m.skipped_file_count).toBe(3);
    // skipped-file categories grouped by reason.
    expect(m.skipped_file_categories).toEqual({
      "lockfile-oversized": 1,
      "vendored-dependency": 1,
      "generated-output": 1,
    });
    // knowledge candidates: 1 wiki + 1 decision + 2 reflection + 0 evolution = 4.
    expect(m.knowledge_candidates_produced).toBe(4);
    expect(m.decision_candidates_produced).toBe(1);
    // graph counts from knowledge-links.json (6 edges; node set).
    expect(m.graph_edge_count).toBe(6);
    expect(m.graph_node_count).toBeGreaterThan(0);
    // phase durations from phase_end.
    expect(m.phase_durations_ms).toEqual({ learn: 299000 });
    // gate count from gates map (G-spec).
    expect(m.gate_count).toBe(1);
    // human questions: one user-sourced gate_decision.
    expect(m.human_questions_asked).toBe(1);
    // learning checkpoint verdicts from harvest.
    expect(m.learning_checkpoint_verdicts).toEqual(["signal-detected", "routed-to-harvest"]);
    // reflection promotion rate: 1 of 2 (one "promote", one "defer").
    expect(m.reflection_promotion_rate).toBeCloseTo(0.5);
    // replay completeness: full (phases + run_closed marker).
    expect(m.replay_completeness).toBe("full");
    expect(m.benchmark_fixture_eligible).toBe(true);
  });

  it("summarises the E1 knowledge-links read surface for the run", async () => {
    const root = await stageFixture(workDir, "learn-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-learn-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    expect(record.knowledge_links).toBeDefined();
    expect(record.knowledge_links!.skills).toContain("skill:guild-learn");
    expect(record.knowledge_links!.agents).toContain("agent:learn-agent");
    expect(record.knowledge_links!.lessons).toContain("reflection:lesson-detection");
    expect(record.knowledge_links!.constraining_decisions).toContain("decision:cheap-map-first");
    expect(record.knowledge_links!.run_edge_count).toBeGreaterThan(0);
  });

  it("imports a lightweight status run (NOT benchmark-eligible)", async () => {
    const root = await stageFixture(workDir, "status-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-status-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    expect(record.run_type).toBe("status");
    expect(record.run_class).toBe("lightweight");
    // Lightweight + status command => not eligible.
    expect(record.benchmark_eligible).toBe(false);
    expect(record.partial).toBe(false);
    // No learn artifacts => candidate metrics undefined.
    expect(record.metrics.knowledge_candidates_produced).toBeUndefined();
    expect(record.metrics.skipped_file_count).toBeUndefined();
  });

  it("imports an ideate run with no learn/ dir and no logs", async () => {
    const root = await stageFixture(workDir, "ideate-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-ideate-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    expect(record.run_type).toBe("ideate");
    expect(record.run_class).toBe("full");
    // closed => eligible even without learn artifacts.
    expect(record.benchmark_eligible).toBe(true);
    // No logs/v1.4-events.jsonl => listed as missing, but import still succeeds.
    expect(record.missing_artifacts).toContain("logs/v1.4-events.jsonl");
    // Timeline still rendered from phases_log alone.
    expect(record.timeline.length).toBeGreaterThan(0);
    expect(record.timeline.every((t) => t.kind === "phase")).toBe(true);
    // No close marker but provenance closed => completeness is partial (no marker).
    expect(record.metrics.replay_completeness).toBe("partial");
  });

  it("imports an OPEN plan run with no provenance.json (partial=true)", async () => {
    const root = await stageFixture(workDir, "plan-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-plan-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    expect(record.run_type).toBe("plan");
    expect(record.partial).toBe(true);
    expect(record.missing_artifacts).toContain("provenance.json");
    expect(record.closed_at).toBeNull();
    expect(record.status).toBe("open");
    // Open run is NOT benchmark-eligible (not closed).
    expect(record.benchmark_eligible).toBe(false);
    // Trace events still produce a timeline + phase durations.
    expect(record.metrics.phase_durations_ms).toEqual({ plan: 179000 });
  });

  it("/guild:guild run whose phases_log tops at ideate imports as run_type=ideate", async () => {
    // This is the phase-derivation integration test: the smart-dispatcher entry
    // must use actual phases, not the hardcoded "build" fallback.
    const root = await stageFixture(workDir, "guild-ideate-run");
    const sourceRunDir = join(root, ".guild", "runs", "run-guild-ideate-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    expect(record.command).toBe("/guild:guild");
    expect(record.run_type).toBe("ideate");
  });

  it("throws when run.yaml is absent (use importAuditRun instead)", async () => {
    const dir = join(workDir, "no-yaml", ".guild", "runs", "run-x");
    await mkdir(dir, { recursive: true });
    await expect(
      importLifecycleRun({ sourceRunDir: dir, runsDir }),
    ).rejects.toThrow(/run\.yaml not found/);
  });

  it("rejects paths that are not .guild/runs/<run-id> directories", async () => {
    const dir = join(workDir, "wrong", "place");
    await mkdir(dir, { recursive: true });
    await expect(
      importLifecycleRun({ sourceRunDir: dir, runsDir }),
    ).rejects.toThrow(/\.guild\/runs\/<run-id>/);
  });

  it("NN#8: deleting knowledge-links.json does not break import", async () => {
    const root = await stageFixture(workDir, "learn-run");
    await rm(join(root, ".guild", "indexes", "knowledge-links.json"), { force: true });
    const sourceRunDir = join(root, ".guild", "runs", "run-learn-001");
    const { record } = await importLifecycleRun({ sourceRunDir, runsDir });
    // Import succeeds; graph metrics + knowledge_links summary become undefined.
    expect(record.metrics.graph_edge_count).toBeUndefined();
    expect(record.metrics.graph_node_count).toBeUndefined();
    expect(record.knowledge_links).toBeUndefined();
    // Other metrics still extracted.
    expect(record.metrics.knowledge_candidates_produced).toBe(4);
  });

  it("NN#9: imports only on-disk artifacts (no plugin module imported)", () => {
    // The lifecycle-importer source must not import anything under plugin/.
    const src = readFileSync(resolve(__dirname, "..", "src", "lifecycle-importer.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*\/plugin\//);
    expect(src).not.toMatch(/require\(\s*["'][^"']*\/plugin\//);
    // Same for the metric + timeline modules.
    const metricsSrc = readFileSync(resolve(__dirname, "..", "src", "lifecycle-metrics.ts"), "utf8");
    const timelineSrc = readFileSync(resolve(__dirname, "..", "src", "lifecycle-timeline.ts"), "utf8");
    expect(metricsSrc).not.toMatch(/\/plugin\//);
    expect(timelineSrc).not.toMatch(/\/plugin\//);
  });

  it("listLifecycleRunDirs finds run dirs with run.yaml", async () => {
    const root = await stageFixture(workDir, "learn-run");
    const dirs = await listLifecycleRunDirs(join(root, ".guild", "runs"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0].endsWith("run-learn-001")).toBe(true);
  });
});

describe("lifecycle-timeline / renderTimeline (unit)", () => {
  it("sorts merged streams by `at` and sinks empty-at entries to the end", () => {
    const out = renderTimeline({
      phasesLog: [
        { phase: "later", at: "2026-05-29T08:05:00Z" },
        { phase: "no-timestamp" }, // empty at -> sinks to end
        { phase: "earlier", at: "2026-05-29T08:00:00Z" },
      ],
      traceEvents: [],
      lifecycleMarkers: [
        { event_name: "run_closed", at: "2026-05-29T08:10:00Z", run_id: "r" },
      ],
    });
    expect(out.map((e) => e.label)).toEqual([
      "earlier",
      "later",
      "run_closed",
      "no-timestamp",
    ]);
  });
});

describe("lifecycle-metrics / extractLifecycleMetrics (unit)", () => {
  it("returns undefined metrics when sources are absent", () => {
    const m = extractLifecycleMetrics({
      runYaml: { command: "/guild:qa", run_class: "full", status: "closed" },
      provenance: null,
      traceEvents: [],
      runId: "run-qa-001",
    });
    expect(m.knowledge_candidates_produced).toBeUndefined();
    expect(m.graph_edge_count).toBeUndefined();
    expect(m.gate_count).toBeUndefined();
    // qa run, full + closed => eligible.
    expect(m.benchmark_fixture_eligible).toBe(true);
    expect(m.replay_completeness).toBe("none");
  });

  it("derives a typed LifecycleRunRecord shape for qa runs", () => {
    // Compile-time assertion that qa is a valid run type in the record.
    const record: Partial<LifecycleRunRecord> = { run_type: "qa" };
    expect(record.run_type).toBe("qa");
  });
});
