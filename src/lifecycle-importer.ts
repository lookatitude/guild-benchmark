// benchmark/src/lifecycle-importer.ts — SC-F full-lifecycle import.
//
// Locked by `.guild/initiatives/active/learn-knowledge-convergence/artifacts/
// benchmark-import-contract.md §2a + §3`. Imports a Guild run of ANY type
// (learn/ideate/plan/qa/ops/build/status/...) from its ON-DISK artifacts into a
// `LifecycleRunRecord` for the benchmark/dashboard. NO plugin module is imported
// at runtime (non-negotiable #9) — the importer reads:
//
//   <sourceRunDir>/run.yaml                         guild.run.v1   (start manifest)
//   <sourceRunDir>/provenance.json                  guild.provenance.v1 (close — OPTIONAL)
//   <sourceRunDir>/logs/v1.4-events.jsonl           trace events + lifecycle markers
//   <sourceRunDir>/learn/harvest-candidates.json    guild.harvest_candidates.v1 (OPTIONAL)
//   <sourceRunDir>/learn/skipped-files.json         guild.skipped_files.v1 (OPTIONAL)
//   <sourceRunDir>/verify.md                         verify verdict (OPTIONAL)
//   <indexesDir>/knowledge-links.json               guild.knowledge_links.v1 (derived; OPTIONAL)
//
// The import is ADDITIVE to artifact-importer.ts — it reuses its on-disk copy
// pattern by also copying the source run tree under `artifacts/.guild/runs/`
// (same shape as importAuditRun) so existing run-detail/event readers still see
// the captured artifacts. The existing importAuditRun / importFixture functions
// are NOT modified.

import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { listArchives, readAllEvents, readArchive } from "./log-jsonl.js";
import { liveLogPath } from "./log-jsonl.js";
import type { JsonlEvent } from "./run-events-schema.js";
import {
  extractLifecycleMetrics,
  type GuildProvenanceV1Loose,
  type GuildRunV1Loose,
  type HarvestCandidatesV1Loose,
  type KnowledgeLinksDocLoose,
  type SkippedFilesV1Loose,
} from "./lifecycle-metrics.js";
import {
  renderTimeline,
  type LifecycleTraceMarker,
} from "./lifecycle-timeline.js";
import type {
  KnowledgeLinksSummary,
  LifecycleRunRecord,
  RunTypeKind,
} from "./types.js";

const SAFE_IMPORT_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ImportLifecycleRunOpts {
  // Absolute path to the source `.guild/runs/<run-id>/` directory.
  sourceRunDir: string;
  // The benchmark runsDir to copy artifacts into (mirrors importAuditRun).
  runsDir: string;
  // Override the imported run-id.
  runId?: string;
  // Optional override for the `.guild/indexes/` directory that holds the
  // derived `knowledge-links.json`. Defaults to the sibling `indexes/` of the
  // source run's `.guild/` root (i.e. <...>/.guild/indexes/).
  indexesDir?: string;
}

export interface ImportLifecycleRunResult {
  record: LifecycleRunRecord;
  runDir: string; // the benchmark-side imported run dir
  sourceRunId: string;
}

// command -> RunTypeKind (contract §3).
const COMMAND_TO_RUN_TYPE: Record<string, RunTypeKind> = {
  "/guild:learn": "learn",
  "/guild:ideate": "ideate",
  "/guild:plan": "plan",
  "/guild:build": "build",
  "/guild:qa": "qa",
  "/guild:ops": "ops",
  "/guild:status": "status",
  "/guild:wiki": "wiki",
  "/guild:initiative": "initiative",
  "/guild:fix": "fix",
  "/guild:evolve": "evolve",
  "/guild:rollback": "rollback",
  "/guild:audit": "audit",
  "/guild:stats": "stats",
  // The smart dispatcher: fallback to "build" when phases_log is absent.
  // Use classifyRunTypeFromRun() to derive from actual phases when available.
  "/guild:guild": "build",
};

// Smart-dispatcher commands whose run_type should be derived from phases_log
// rather than fixed by the command string (contract §3, updated).
const SMART_DISPATCHER_COMMANDS = new Set(["/guild:guild"]);

// Map a phases_log phase name to the RunTypeKind it implies. Phase names from
// the real lkc run: detect, ideate, plan, build-wave-N, verify, qa, ops, etc.
// Returns undefined for phases that don't imply a run type (e.g. "detect").
function phaseToRunType(phase: string): RunTypeKind | undefined {
  if (phase.startsWith("build-wave") || phase === "verify") return "build";
  if (phase === "plan") return "plan";
  if (phase === "ideate") return "ideate";
  if (phase === "learn") return "learn";
  if (phase === "qa") return "qa";
  if (phase === "ops") return "ops";
  if (phase === "status") return "status";
  if (phase === "wiki") return "wiki";
  if (phase === "initiative") return "initiative";
  if (phase === "fix") return "fix";
  if (phase === "evolve") return "evolve";
  if (phase === "rollback") return "rollback";
  if (phase === "audit") return "audit";
  if (phase === "stats") return "stats";
  // "detect" and other orchestrator-only phases don't map to a run type.
  return undefined;
}

// Derive the RunTypeKind from the run's actual phases_log for smart-dispatcher
// commands. Walks phases in order; the last recognized phase wins (chronological
// order means last = deepest reached). Falls back to "build" when the log is
// absent, empty, or contains only unrecognized phases (e.g. just ["detect"]).
function deriveRunTypeFromPhasesLog(
  phasesLog: Array<{ phase?: string }> | undefined,
): RunTypeKind {
  if (!phasesLog || phasesLog.length === 0) return "build";
  let derived: RunTypeKind = "build";
  let found = false;
  for (const entry of phasesLog) {
    const kind = entry.phase ? phaseToRunType(entry.phase) : undefined;
    if (kind !== undefined) {
      derived = kind;
      found = true;
    }
  }
  return found ? derived : "build";
}

export function classifyRunType(command: string | undefined): RunTypeKind {
  if (!command) return "unknown";
  return COMMAND_TO_RUN_TYPE[command] ?? "unknown";
}

/**
 * Like classifyRunType but, for smart-dispatcher commands (e.g. /guild:guild),
 * derives the RunTypeKind from the run's actual phases_log rather than using
 * the hardcoded fallback. Non-dispatcher commands ignore phasesLog entirely.
 *
 * Keeps classifyRunType signature stable — call this from importLifecycleRun
 * and anywhere you have the phases_log available.
 */
export function classifyRunTypeFromRun(
  command: string | undefined,
  phasesLog?: Array<{ phase?: string }>,
): RunTypeKind {
  if (!command) return "unknown";
  const direct = COMMAND_TO_RUN_TYPE[command];
  if (direct === undefined) return "unknown";
  if (SMART_DISPATCHER_COMMANDS.has(command)) {
    return deriveRunTypeFromPhasesLog(phasesLog);
  }
  return direct;
}

function isSafeImportRunId(runId: string): boolean {
  return SAFE_IMPORT_RUN_ID_RE.test(runId) && runId !== "." && runId !== "..";
}

async function readJsonLoose<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readYamlLoose<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = parseYaml(await readFile(path, "utf8"));
    return (parsed ?? null) as T | null;
  } catch {
    return null;
  }
}

// Read the raw run_started / run_closed lifecycle markers off the v1.4 jsonl.
// These are appended raw by the plugin's run-trace hook and are NOT members of
// the 12-type closed union, so readAllEvents (which validates strictly) skips
// them. We do a loose line-scan for them here. Deterministic; no wall-clock.
//
// FIX 1: scan the SAME sources as readAllEvents — archives (N-ascending) then
// the live log — so that run_closed markers written before a rotation are not
// dropped on long runs. Archives are immutable post-rotation; we read them
// without a lock (mirrors readAllEvents's reader path).
async function readLifecycleMarkers(runDir: string): Promise<LifecycleTraceMarker[]> {
  const out: LifecycleTraceMarker[] = [];

  // Helper: scan one block of text for lifecycle marker lines.
  function scanText(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const obj = parsed as LifecycleTraceMarker;
      const name = obj.event_name ?? obj.event;
      if (name === "run_started" || name === "run_closed") {
        out.push(obj);
      }
    }
  }

  // Archives first (N-ascending), matching readAllEvents source-priority order.
  for (const archivePath of listArchives(runDir)) {
    try {
      const text = await readArchive(archivePath);
      scanText(text);
    } catch {
      // Treat unreadable archive as absent (mirrors readAllEvents behaviour).
      continue;
    }
  }

  // Live log last (if it exists).
  const live = liveLogPath(runDir);
  if (existsSync(live)) {
    try {
      const text = await readFile(live, "utf8");
      scanText(text);
    } catch {
      // Treat unreadable live log as absent.
    }
  }

  return out;
}

// Extract the verify.md frontmatter `verdict:` line (loose; no YAML lib needed).
async function readVerifyVerdict(runDir: string): Promise<string | null> {
  const path = join(runDir, "verify.md");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/^verdict:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// E1 knowledge-links read surface (contract §6). We read the on-disk
// knowledge-links.json and apply equivalent inline traversal (NO plugin import).
function summariseKnowledgeLinks(
  kl: KnowledgeLinksDocLoose | null,
  runId: string,
): KnowledgeLinksSummary | undefined {
  if (!kl || !Array.isArray(kl.links)) return undefined;
  const runNode = `run:${runId}`;
  const skills = new Set<string>();
  const agents = new Set<string>();
  const lessons = new Set<string>();
  const decisions = new Set<string>();
  let runEdgeCount = 0;

  // Build undirected adjacency for a shallow traversal from the run node.
  const adj = new Map<string, Set<string>>();
  const addAdj = (a: string, b: string): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };

  for (const l of kl.links) {
    const from = typeof l.from === "string" ? l.from : "";
    const to = typeof l.to === "string" ? l.to : "";
    if (!from || !to) continue;
    addAdj(from, to);
    addAdj(to, from);
    if (from === runNode || to === runNode) {
      runEdgeCount += 1;
      const other = from === runNode ? to : from;
      if (other.startsWith("skill:")) skills.add(other);
      else if (other.startsWith("agent:")) agents.add(other);
      else if (other.startsWith("reflection:") || other.startsWith("evolution:")) lessons.add(other);
      else if (other.startsWith("decision:")) decisions.add(other);
    }
  }

  // Decisions can be 1 hop further (task -> decision via constrains); collect
  // any decision node within 2 hops of the run node.
  const visited = new Set<string>([runNode]);
  let frontier = [...(adj.get(runNode) ?? [])];
  for (let hop = 0; hop < 2 && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      if (visited.has(node)) continue;
      visited.add(node);
      if (node.startsWith("decision:")) decisions.add(node);
      for (const nb of adj.get(node) ?? []) {
        if (!visited.has(nb)) next.push(nb);
      }
    }
    frontier = next;
  }

  return {
    skills: [...skills].sort(),
    agents: [...agents].sort(),
    lessons: [...lessons].sort(),
    constraining_decisions: [...decisions].sort(),
    run_edge_count: runEdgeCount,
  };
}

/**
 * Import a Guild lifecycle run (any run type) from on-disk artifacts.
 *
 * Reads run.yaml + provenance.json (optional) + v1.4-events.jsonl + optional
 * learn artifacts + optional knowledge-links.json. Produces a LifecycleRunRecord
 * with the entry-to-close timeline and the §488-505 metric set. Copies the
 * source run tree under the benchmark run dir's artifacts/.guild/runs/ (same as
 * importAuditRun) so existing run-detail readers see captured artifacts.
 *
 * Graceful fallback: if run.yaml is absent, throws (this is the lifecycle path;
 * callers that only have run.json should use importAuditRun). If provenance.json
 * is absent (run still open), `partial: true` and `closed_at: null`.
 */
export async function importLifecycleRun(
  opts: ImportLifecycleRunOpts,
): Promise<ImportLifecycleRunResult> {
  const sourceRunDir = resolve(opts.sourceRunDir);
  if (!existsSync(sourceRunDir)) {
    throw new Error(`source run directory not found: ${sourceRunDir}`);
  }
  const sourceRunId = basename(sourceRunDir);
  if (!isSafeImportRunId(sourceRunId)) {
    throw new Error("source run id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  if (
    basename(dirname(sourceRunDir)) !== "runs" ||
    basename(dirname(dirname(sourceRunDir))) !== ".guild"
  ) {
    throw new Error("run_dir must point to a .guild/runs/<run-id> directory");
  }

  const runYamlPath = join(sourceRunDir, "run.yaml");
  if (!existsSync(runYamlPath)) {
    throw new Error(
      `run.yaml not found at ${runYamlPath} — lifecycle import requires guild.run.v1 ` +
        `(use importAuditRun for runs that only have logs)`,
    );
  }
  const runYaml = await readYamlLoose<GuildRunV1Loose>(runYamlPath);
  if (!runYaml) {
    throw new Error(`run.yaml at ${runYamlPath} is not parseable YAML`);
  }

  const runId = opts.runId ?? sourceRunId;
  if (!isSafeImportRunId(runId)) {
    throw new Error("run_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }

  // ---- Read the on-disk artifacts (all optional except run.yaml) --------
  const provenance = await readJsonLoose<GuildProvenanceV1Loose>(
    join(sourceRunDir, "provenance.json"),
  );
  const harvestCandidates = await readJsonLoose<HarvestCandidatesV1Loose>(
    join(sourceRunDir, "learn", "harvest-candidates.json"),
  );
  const skippedFiles = await readJsonLoose<SkippedFilesV1Loose>(
    join(sourceRunDir, "learn", "skipped-files.json"),
  );
  const verifyVerdict = await readVerifyVerdict(sourceRunDir);

  // Trace events (validated v1.4 closed union — unknown lines skipped) and the
  // raw lifecycle markers (run_started / run_closed).
  const traceEvents: JsonlEvent[] = await readAllEvents(sourceRunDir);
  const lifecycleMarkers = await readLifecycleMarkers(sourceRunDir);

  // Derived knowledge-links index (NN#8 rebuildable; absence is not an error).
  const guildRoot = dirname(dirname(sourceRunDir)); // <...>/.guild
  const indexesDir = opts.indexesDir ?? join(guildRoot, "indexes");
  const knowledgeLinks = await readJsonLoose<KnowledgeLinksDocLoose>(
    join(indexesDir, "knowledge-links.json"),
  );

  // ---- Derive the record ------------------------------------------------
  const command = runYaml.command ?? "";
  const phasesLog = Array.isArray(runYaml.phases_log) ? runYaml.phases_log : [];
  const runType = classifyRunTypeFromRun(command, phasesLog);
  const runClass = (runYaml.run_class ?? provenance?.run_class ?? "full") as
    | "full"
    | "lightweight";
  const status = provenance?.status ?? runYaml.status ?? "open";

  const timeline = renderTimeline({
    phasesLog,
    traceEvents,
    lifecycleMarkers,
  });

  const metrics = extractLifecycleMetrics({
    runYaml,
    provenance,
    traceEvents,
    lifecycleMarkers,
    harvestCandidates,
    skippedFiles,
    knowledgeLinks,
    runId: sourceRunId,
    verifyVerdict,
  });

  const knowledge_links = summariseKnowledgeLinks(knowledgeLinks, sourceRunId);

  const missing: string[] = [];
  if (!provenance) missing.push("provenance.json");
  if (traceEvents.length === 0 && lifecycleMarkers.length === 0) {
    missing.push("logs/v1.4-events.jsonl");
  }

  const record: LifecycleRunRecord = {
    run_id: runId,
    command,
    run_class: runClass,
    run_type: runType,
    benchmark_eligible: metrics.benchmark_fixture_eligible ?? false,
    ...(runYaml.target_kind ? { target_kind: runYaml.target_kind } : {}),
    started_at: runYaml.started_at ?? "",
    closed_at: provenance?.closed_at ?? null,
    status,
    phases_log: phasesLog,
    timeline,
    metrics,
    ...(knowledge_links ? { knowledge_links } : {}),
    partial: !provenance,
    missing_artifacts: missing,
  };

  // ---- Copy artifacts (mirror importAuditRun on-disk capture) -----------
  const runDir = resolve(opts.runsDir, runId);
  // FIX 3: refuse collision — mirrors importAuditRun's existing-run-dir check.
  // A pre-existing runDir means a previous import (or a live run) already
  // claimed this id. Reusing it would leave old run.json/score.json in place
  // while overwriting lifecycle-record.json, producing a mixed-artifact state
  // that makes GET /api/runs/:id return stale data.
  if (existsSync(runDir)) {
    throw new Error(`run already exists: ${runId}`);
  }
  await mkdir(runDir, { recursive: true });
  const capturedRunDir = join(runDir, "artifacts", ".guild", "runs", sourceRunId);
  if (!existsSync(capturedRunDir)) {
    await mkdir(dirname(capturedRunDir), { recursive: true });
    await cp(sourceRunDir, capturedRunDir, { recursive: true });
  }
  // Write the lifecycle record alongside (the benchmark-side analysis artifact).
  await writeFile(
    join(runDir, "lifecycle-record.json"),
    JSON.stringify(record, null, 2) + "\n",
  );

  return { record, runDir, sourceRunId };
}

// Re-export for callers/tests that want to enumerate the importable run types.
export { COMMAND_TO_RUN_TYPE };

// Tiny helper used by tests + the server: list candidate .guild/runs/<id> dirs
// under a .guild/runs directory. On-disk read only.
export async function listLifecycleRunDirs(runsRoot: string): Promise<string[]> {
  if (!existsSync(runsRoot)) return [];
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (existsSync(join(runsRoot, e.name, "run.yaml"))) {
      out.push(join(runsRoot, e.name));
    }
  }
  return out.sort();
}
