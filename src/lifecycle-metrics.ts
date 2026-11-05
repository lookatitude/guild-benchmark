// benchmark/src/lifecycle-metrics.ts — SC-F §488-505 metric extraction.
//
// Locked by `.guild/initiatives/active/learn-knowledge-convergence/artifacts/
// benchmark-import-contract.md §5`. Every metric is extracted from ALREADY-READ
// on-disk artifacts (run.yaml / provenance.json / v1.4-events.jsonl /
// harvest-candidates.json / skipped-files.json / knowledge-links.json). NO
// plugin module is imported (non-negotiable #9). A metric whose source artifact
// is absent is `undefined`, never an error.

import type { JsonlEvent } from "./run-events-schema.js";
import type {
  LifecycleMetrics,
  LifecyclePhaseLogEntry,
} from "./types.js";
import {
  deriveReplayCompleteness,
  renderTimeline,
  type LifecycleTraceMarker,
} from "./lifecycle-timeline.js";

// ---- Loosely-typed on-disk shapes --------------------------------------
// These mirror the plugin's emitted artifact FORMATS by structure (the
// on-disk artifact is the contract, not a shared import).

export interface GuildRunV1Loose {
  schema_version?: string;
  run_id?: string;
  command?: string;
  target_kind?: string;
  run_class?: string;
  status?: string;
  started_at?: string;
  scan_policy?: string;
  initiative_attachment?: string | null;
  gates?: Record<string, unknown>;
  phases_log?: LifecyclePhaseLogEntry[];
  [key: string]: unknown;
}

export interface GuildProvenanceV1Loose {
  schema_version?: string;
  run_id?: string;
  command?: string;
  status?: string;
  run_class?: string;
  closed_at?: string;
  final_learning_checkpoint?: string | null;
  gates?: Record<string, unknown>;
  coverage?: {
    scanned_count?: number;
    skipped_count?: number;
    skipped_files_ref?: string;
  };
  touched?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HarvestCandidatesV1Loose {
  schema_version?: string;
  wiki_candidates?: unknown[];
  decision_candidates?: unknown[];
  reflection_candidates?: Array<{ promotion_gate?: string; [k: string]: unknown }>;
  evolution_candidates?: unknown[];
  open_questions?: unknown[];
  learning_checkpoint_verdicts?: string[];
  [key: string]: unknown;
}

export interface SkippedFilesV1Loose {
  schema_version?: string;
  skipped_count?: number;
  skipped?: Array<{ reason?: string; [k: string]: unknown }>;
  [key: string]: unknown;
}

export interface KnowledgeLinksDocLoose {
  schema_version?: string;
  links?: Array<{ from?: string; to?: string; type?: string; [k: string]: unknown }>;
  [key: string]: unknown;
}

export interface ExtractMetricsOpts {
  runYaml: GuildRunV1Loose;
  provenance?: GuildProvenanceV1Loose | null;
  traceEvents: JsonlEvent[];
  lifecycleMarkers?: LifecycleTraceMarker[];
  harvestCandidates?: HarvestCandidatesV1Loose | null;
  skippedFiles?: SkippedFilesV1Loose | null;
  knowledgeLinks?: KnowledgeLinksDocLoose | null;
  // The run-id under analysis, used to filter knowledge-links run edges. The
  // builder normalises run nodes to `run:<run-id>`.
  runId: string;
  // The verify.md frontmatter `verdict`, when present, for verification_outcomes.
  verifyVerdict?: string | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T/;

function parseMs(at: string | undefined): number | null {
  if (!at || !ISO_RE.test(at)) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

// §488-505 "time to project understanding": elapsed from the detect phase to
// the first learn-phase completion. Both come from the deterministic
// phases_log `at` fields (no wall-clock).
function timeToUnderstanding(phasesLog: LifecyclePhaseLogEntry[]): number | undefined {
  const detect = phasesLog.find((p) => p.phase === "detect");
  // First entry whose phase is learn (or a learn sub-phase).
  const learn = phasesLog.find((p) => p.phase === "learn" || p.phase.startsWith("learn"));
  if (!detect || !learn) return undefined;
  const start = parseMs(detect.at);
  const end = parseMs(learn.at);
  if (start === null || end === null || end < start) return undefined;
  return end - start;
}

// Per-phase durations from phase_end trace events (authoritative duration_ms).
function phaseDurations(traceEvents: JsonlEvent[]): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const e of traceEvents) {
    if (e.event === "phase_end") {
      out[e.phase] = (out[e.phase] ?? 0) + e.duration_ms;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Human questions: gate_decision events sourced from a real user (not the
// auto-approve mode) signal an operator interaction point.
function humanQuestionsAsked(traceEvents: JsonlEvent[]): number | undefined {
  let n = 0;
  let sawGate = false;
  for (const e of traceEvents) {
    if (e.event === "gate_decision") {
      sawGate = true;
      if (e.source === "user") n += 1;
    }
  }
  return sawGate ? n : undefined;
}

// Context budget pressure: count of escalation events (cap_hit / restart_cap_hit
// signal budget/loop pressure). Absent when no escalation events present.
function contextBudgetPressure(traceEvents: JsonlEvent[]): number | undefined {
  let n = 0;
  let sawAny = false;
  for (const e of traceEvents) {
    if (e.event === "escalation") {
      sawAny = true;
      n += 1;
    }
  }
  return sawAny ? n : undefined;
}

// Review rounds: codex_review_round events, or specialist dispatches whose
// specialist name contains "review".
function reviewRounds(traceEvents: JsonlEvent[]): number | undefined {
  let n = 0;
  let sawAny = false;
  for (const e of traceEvents) {
    if (e.event === "codex_review_round") {
      sawAny = true;
      n += 1;
    } else if (e.event === "specialist_dispatch" && /review/i.test(e.specialist)) {
      sawAny = true;
      n += 1;
    }
  }
  return sawAny ? n : undefined;
}

function gateCount(runYaml: GuildRunV1Loose, prov?: GuildProvenanceV1Loose | null): number | undefined {
  const fromProv = prov?.gates && typeof prov.gates === "object" ? Object.keys(prov.gates).length : 0;
  const fromRun = runYaml.gates && typeof runYaml.gates === "object" ? Object.keys(runYaml.gates).length : 0;
  const n = Math.max(fromProv, fromRun);
  // Both may legitimately be empty maps ({}). Only return undefined when neither
  // field is present at all.
  if (prov?.gates === undefined && runYaml.gates === undefined) return undefined;
  return n;
}

function skippedFileCategories(
  sf: SkippedFilesV1Loose | null | undefined,
): Record<string, number> | undefined {
  if (!sf || !Array.isArray(sf.skipped)) return undefined;
  const out: Record<string, number> = {};
  for (const entry of sf.skipped) {
    const reason = typeof entry.reason === "string" ? entry.reason : "unknown";
    out[reason] = (out[reason] ?? 0) + 1;
  }
  return out;
}

function knowledgeCandidates(
  hc: HarvestCandidatesV1Loose | null | undefined,
): { total?: number; decisions?: number } {
  if (!hc) return {};
  const len = (a: unknown): number => (Array.isArray(a) ? a.length : 0);
  const total =
    len(hc.wiki_candidates) +
    len(hc.decision_candidates) +
    len(hc.reflection_candidates) +
    len(hc.evolution_candidates);
  return { total, decisions: len(hc.decision_candidates) };
}

// reflection promotion rate: fraction of reflection candidates whose
// promotion_gate verdict indicates a "promote"/"accept" disposition. When no
// reflection candidates exist, undefined.
function reflectionPromotionRate(
  hc: HarvestCandidatesV1Loose | null | undefined,
): number | undefined {
  if (!hc || !Array.isArray(hc.reflection_candidates) || hc.reflection_candidates.length === 0) {
    return undefined;
  }
  const total = hc.reflection_candidates.length;
  const promoted = hc.reflection_candidates.filter((c) => {
    const g = typeof c.promotion_gate === "string" ? c.promotion_gate.toLowerCase() : "";
    return g.includes("promote") || g.includes("accept") || g === "approved";
  }).length;
  return promoted / total;
}

function knowledgeGraphCounts(
  kl: KnowledgeLinksDocLoose | null | undefined,
): { nodes?: number; edges?: number } {
  if (!kl || !Array.isArray(kl.links)) return {};
  const nodes = new Set<string>();
  for (const l of kl.links) {
    if (typeof l.from === "string") nodes.add(l.from);
    if (typeof l.to === "string") nodes.add(l.to);
  }
  return { nodes: nodes.size, edges: kl.links.length };
}

function verificationOutcomes(
  verdict: string | null | undefined,
): Record<string, "pass" | "fail" | "skip"> | undefined {
  if (!verdict) return undefined;
  const v = verdict.toLowerCase();
  if (v.startsWith("pass")) return { verify: "pass" };
  if (v.startsWith("fail")) return { verify: "fail" };
  return { verify: "skip" };
}

/**
 * Extract the §488-505 metric set. Pure + deterministic. Each metric defaults
 * to `undefined` when its source artifact is absent.
 */
export function extractLifecycleMetrics(opts: ExtractMetricsOpts): LifecycleMetrics {
  const phasesLog = Array.isArray(opts.runYaml.phases_log) ? opts.runYaml.phases_log : [];
  const kc = knowledgeCandidates(opts.harvestCandidates);
  const graph = knowledgeGraphCounts(opts.knowledgeLinks);

  const coverageScanned = opts.provenance?.coverage?.scanned_count;
  const coverageSkipped =
    opts.provenance?.coverage?.skipped_count ?? opts.skippedFiles?.skipped_count;

  const completeness = deriveReplayCompleteness({
    phasesLog,
    traceEvents: opts.traceEvents,
    ...(opts.lifecycleMarkers ? { lifecycleMarkers: opts.lifecycleMarkers } : {}),
  });

  const runClass = (opts.runYaml.run_class ?? opts.provenance?.run_class ?? "full") as
    | "full"
    | "lightweight";
  const closed =
    (opts.provenance?.status ?? opts.runYaml.status) === "closed";
  const runType = opts.runYaml.command ?? "";
  const benchmarkEligible =
    runClass === "full" &&
    closed &&
    runType !== "/guild:status" &&
    runType !== "/guild:stats";

  const checkpointVerdicts = Array.isArray(opts.harvestCandidates?.learning_checkpoint_verdicts)
    ? opts.harvestCandidates!.learning_checkpoint_verdicts
    : undefined;

  const metrics: LifecycleMetrics = {
    replay_completeness: completeness,
    benchmark_fixture_eligible: benchmarkEligible,
  };

  const ttu = timeToUnderstanding(phasesLog);
  if (ttu !== undefined) metrics.time_to_project_understanding_ms = ttu;
  if (coverageScanned !== undefined) metrics.file_coverage_count = coverageScanned;
  if (coverageSkipped !== undefined) metrics.skipped_file_count = coverageSkipped;
  const sfCats = skippedFileCategories(opts.skippedFiles);
  if (sfCats !== undefined) metrics.skipped_file_categories = sfCats;
  if (kc.total !== undefined) metrics.knowledge_candidates_produced = kc.total;
  if (kc.decisions !== undefined) metrics.decision_candidates_produced = kc.decisions;
  if (graph.nodes !== undefined) metrics.graph_node_count = graph.nodes;
  if (graph.edges !== undefined) metrics.graph_edge_count = graph.edges;
  const pd = phaseDurations(opts.traceEvents);
  if (pd !== undefined) metrics.phase_durations_ms = pd;
  const gc = gateCount(opts.runYaml, opts.provenance);
  if (gc !== undefined) metrics.gate_count = gc;
  const hq = humanQuestionsAsked(opts.traceEvents);
  if (hq !== undefined) metrics.human_questions_asked = hq;
  const cbp = contextBudgetPressure(opts.traceEvents);
  if (cbp !== undefined) metrics.context_budget_pressure = cbp;
  const rr = reviewRounds(opts.traceEvents);
  if (rr !== undefined) metrics.review_rounds = rr;
  const vo = verificationOutcomes(opts.verifyVerdict);
  if (vo !== undefined) metrics.verification_outcomes = vo;
  if (checkpointVerdicts !== undefined) metrics.learning_checkpoint_verdicts = checkpointVerdicts;
  const rpr = reflectionPromotionRate(opts.harvestCandidates);
  if (rpr !== undefined) metrics.reflection_promotion_rate = rpr;

  // renderTimeline is the same merge the importer uses; touch it here so the
  // metric module and importer agree on the timeline source (no divergence).
  void renderTimeline;

  return metrics;
}

// C9 (T04): the one formula engine for metric series and drilldown. Views and
// reports compute C9 metrics through it, never through a second formula.
export { ATOMIC_METRICS, type AtomicMetric } from "./c9/metric-catalog.js";
export { computeMetricSeries, validateMetricSeriesV2, validateMetricDrilldownV2 } from "./c9/metric-series.js";
