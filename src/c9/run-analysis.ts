/**
 * benchmark/src/c9 (port of plugin src/domains/telemetry/run-analysis-v2.ts @8a02ef60) — T03 versioned run analysis over the
 * T02 ledger: `guild.run_analysis.v2` and `guild.run_comparison.v2`.
 *
 * Every analysis carries its full version set (schema, analyzer+detector,
 * normalizer, formula, observed usage semantics, pricing version+source hash,
 * aggregation). The cache key hashes that set with the run identity and the
 * digest of the retained input manifest, so a change in any dimension misses.
 * A cached analysis is served only when its pointer, body hash, schema, version
 * set and key all agree with what is asked for; v1 artifacts, partial writes and
 * corrupt or forged bodies are never served as current.
 *
 * Storage follows the A02 storage contract: v2 lives at
 * `analysis/runs/<run>/versions/<analysis_id>/analysis.json` behind a
 * `current.v2.json` pointer. The legacy v1 `analysis.json` and the run's
 * retained history are never written.
 *
 * Backfill uses only retained v3 trace evidence. v1.4 logs carry no accounting
 * identity and are recorded as `unsupported`, not normalized. Unobserved
 * lifecycle, outcome and acceptance stay `unknown`; a missing trace is
 * `unavailable` with no counters, never zero.
 *
 * Nested metric series are verified with the T04 C9 rules and must share the
 * enclosing analysis or comparison inputs (only formula and the M29 scalar differ).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { readRetained } from "./contained-read.js";
import { RUN_LEDGER_VERSIONS, normalizeRunLedger, type PriceTable, type RunLedger } from "./run-ledger.js";
import { TRACE_V3_CHECKS, TRACE_ID_RE, compareTraceInstants, isRfc3339, usageRules, type TraceEvidence, type TraceUsage, type TraceShapeCheck } from "./trace-analysis.js";
import { readTrace } from "./trace-read.js";
import { nestedSeriesErrors } from "./metric-series.js";

export const RUN_ANALYSIS_V2_SCHEMA = "guild.run_analysis.v2" as const;
export const RUN_COMPARISON_V2_SCHEMA = "guild.run_comparison.v2" as const;
export const RUN_ANALYSIS_POINTER_SCHEMA = "guild.run_analysis_pointer.v2" as const;
const QUERY_SCHEMA = "guild.stack.metric-series.v2";
export const RUN_ANALYSIS_V2_VERSIONS = Object.freeze({
  analyzer: "t03.analyzer.1+C-DETECTORS/v1",
  aggregation: "t03.aggregation.1",
});
/** v1 `usage.tokens.total` = input + output + cached; cached is counted twice relative to v2. */
export const LEGACY_V1_USAGE_SEMANTICS = "legacy_v1.input_output_cached_sum" as const;
const LEGACY_V1_VERSION = "legacy_v1";

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface VersionSet { schema: string; analyzer: string; normalizer: string; formula: string; usage_semantics: string; pricing: string; aggregation: string }
export const VERSION_DIMENSIONS = Object.freeze(["schema", "analyzer", "normalizer", "formula", "usage_semantics", "pricing", "aggregation"] as const);
export interface RunEntity { source_id: string; kind: "run"; id: string; revision: string }
export interface QueryIdentity {
  schema_version: string; versions: VersionSet;
  snapshot: { input_manifest_digest: string; source_ids: string[]; source_generations: { source_id: string; generation: string }[]; as_of: string };
  grain: string; filters: { dimension: string; values: string[] }[];
  window: { from: string; to: string; basis: "activity_completed" | "accepted_outcome_cohort" | "as_of_snapshot"; timezone: string };
  cohort_hash: string; underlying_scalar: { metric_id: string; formula_version: string } | null;
}
export interface StateAxes {
  lifecycle: "created" | "active" | "suspended" | "closed" | "unknown";
  outcome: "pending" | "succeeded" | "failed" | "cancelled" | "partial" | "unknown";
  acceptance: "pending" | "verified" | "rejected" | "not_required" | "unknown";
  observability: "complete" | "partial" | "unavailable";
}
export interface AnalysisLoss { code: string; count: number | null; reason: string }
export interface RunAnalysisV2 {
  schema_version: typeof RUN_ANALYSIS_V2_SCHEMA; run: RunEntity; analysis_id: string; query: QueryIdentity;
  input_evidence: TraceEvidence[]; usage: TraceUsage[]; state: StateAxes; metrics: unknown[];
  unallocated_request_ids: string[]; losses: AnalysisLoss[];
}
export interface RunComparisonV2 {
  schema_version: typeof RUN_COMPARISON_V2_SCHEMA; comparison_id: string; query: QueryIdentity; runs: RunEntity[];
  analysis_refs: TraceEvidence[]; input_versions: VersionSet[]; cohort_conditions_hash: string;
  compatibility: "compatible" | "refused"; refusal_reasons: string[]; metrics: unknown[];
}
export type Verdict = { ok: true } | { ok: false; errors: string[] };

// ── Hashing ──────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sha = (s: string | Buffer) => `sha256:${crypto.createHash("sha256").update(s).digest("hex")}`;
const bodyBytes = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

/** Digest of the retained inputs: path, hash and availability of each, order-independent. */
export function inputManifestDigest(evidence: readonly TraceEvidence[]): string {
  return sha(canonical([...evidence].map((e) => ({ source_id: e.source_id, path: e.path, sha256: e.sha256, availability: e.availability }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))));
}

/** Cache key over the run identity, every version dimension and the input manifest digest. */
export function analysisCacheKey(versions: VersionSet, manifestDigest: string, subject: { source_id: string; run_id: string }): string {
  const v: Record<string, string> = {};
  for (const d of VERSION_DIMENSIONS) v[d] = versions[d];
  return sha(canonical({ schema: RUN_ANALYSIS_V2_SCHEMA, subject: { source_id: subject.source_id, run_id: subject.run_id }, versions: v, input_manifest_digest: manifestDigest }));
}
const analysisIdOf = (key: string) => `analysis-v2.${key.slice("sha256:".length, "sha256:".length + 32)}`;

/** Dimensions in which two version sets differ, in contract order. */
export function versionDifferences(a: VersionSet, b: VersionSet): string[] {
  return VERSION_DIMENSIONS.filter((d) => a[d] !== b[d]);
}

// ── Versions ─────────────────────────────────────────────────────────────────

/** Observed usage semantics of the normalized leaves; mixed semantics are named, never merged. */
function observedSemantics(semantics: readonly string[]): string {
  const set = [...new Set(semantics)].sort();
  if (set.length === 0) return RUN_LEDGER_VERSIONS.usage_semantics;
  return set.length === 1 ? set[0]! : `mixed:${set.join("+")}`;
}

export function analysisVersions(ledger: RunLedger, semantics: readonly string[], pricing: PriceTable | null, override: Partial<VersionSet> = {}): VersionSet {
  return {
    schema: RUN_ANALYSIS_V2_SCHEMA,
    analyzer: RUN_ANALYSIS_V2_VERSIONS.analyzer,
    normalizer: ledger.versions.normalizer,
    formula: [ledger.versions.usage_formula, ledger.versions.cost_formula, ledger.versions.time_formula].join("|"),
    usage_semantics: observedSemantics(semantics),
    // The table content is hashed, so a rate edit under an unchanged version or source hash still misses.
    pricing: pricing ? `${pricing.version}@${sha(canonical(pricing))}` : "unpriced",
    aggregation: RUN_ANALYSIS_V2_VERSIONS.aggregation,
    ...override,
  };
}

// ── Retained inputs ──────────────────────────────────────────────────────────

const RETAINED_INPUTS: { rel: string; schema: string; normalized: boolean }[] = [
  { rel: "trace.jsonl", schema: "guild.trace.analysis.v3", normalized: true },
  { rel: "trace-capture-manifest.json", schema: "guild.trace.capture_manifest.v1", normalized: true },
  { rel: "logs/v1.4-events.jsonl", schema: "guild.trace.v1.4", normalized: false },
];
const EMPTY_HASH = sha("");

function retainedEvidence(root: string, sourceId: string, runId: string, asOf: string): { evidence: TraceEvidence[]; traceUsable: boolean } {
  const evidence: TraceEvidence[] = [];
  let traceUsable = false;
  for (const input of RETAINED_INPUTS) {
    const rel = `runs/${runId}/${input.rel}`;
    const r = readRetained(root, rel);
    if (r.state === "absent" && !input.normalized) continue;
    if (r.state === "absent" && input.rel !== "trace.jsonl") continue;
    const base = { source_id: sourceId, path: rel, schema_version: input.schema, observed_at: asOf };
    if (r.state === "present") {
      const supported = input.normalized;
      evidence.push({ ...base, sha256: sha(r.bytes), availability: supported ? "available" : "unsupported",
        reason: supported ? null : "v1.4 events carry no accounting identity; retained but not normalized" });
      if (input.rel === "trace.jsonl") traceUsable = true;
    } else {
      evidence.push({ ...base, sha256: EMPTY_HASH, availability: "missing", reason: r.state === "refused" ? "input refused: not a contained regular file within the read bound" : "trace not retained for this run" });
    }
  }
  return { evidence, traceUsable };
}

/** Payload sidecars and tombstones readTrace resolved: their presence and bytes decide coverage, so they are inputs too. */
function payloadEvidence(root: string, sourceId: string, events: readonly { payload_ref: TraceEvidence | null }[], asOf: string): TraceEvidence[] {
  const out = new Map<string, TraceEvidence>();
  for (const e of events) {
    const ref = e.payload_ref;
    if (!ref || out.has(ref.path)) continue;
    const tomb = ref.path.replace(/\.json$/, ".expired.json");
    for (const [rel, schema] of [[ref.path, "guild.trace.sidecar.v1"], [tomb, "guild.trace.sidecar_tombstone.v1"]] as const) {
      if (rel === ref.path || !out.has(rel)) {
        const r = readRetained(root, rel);
        if (r.state === "absent" && rel === tomb) continue;
        out.set(rel, { source_id: sourceId, path: rel, schema_version: schema, observed_at: asOf,
          sha256: r.state === "present" ? sha(r.bytes) : EMPTY_HASH, availability: r.state === "present" ? "available" : "missing",
          reason: r.state === "present" ? null : r.state === "refused" ? "input refused: not a contained regular file within the read bound" : "sidecar not retained" });
      }
    }
  }
  return [...out.values()];
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface BuildRunAnalysisV2Input {
  source_id: string; run_id: string; as_of: string;
  ledger: RunLedger; input_evidence: TraceEvidence[]; trace_usable: boolean;
  pricing: PriceTable | null; versions?: Partial<VersionSet>;
  /** Usage semantics of every billed observation, native sessions included (they are not ledger leaves). */
  observed_semantics?: readonly string[];
  /** Native session identities seen in the trace; the ledger keeps only their aggregate estimate. */
  native_sessions?: number;
}

/** A snapshot read covers all retained history up to as_of: [epoch, as_of). */
const SNAPSHOT_FROM = "1970-01-01T00:00:00Z";
const LIMITS = { usage: 1000, unallocated: 1000, losses: 100, evidence: 1000 } as const;

/** Pure projection of a T02 ledger into `guild.run_analysis.v2`. */
export function buildRunAnalysisV2(i: BuildRunAnalysisV2Input): RunAnalysisV2 {
  const seen = new Set<string>();
  const usage: TraceUsage[] = [];
  for (const leaf of i.ledger.leaves) {
    const u = leaf.normalized_usage;
    if (!i.trace_usable || u.inclusion === "parent_inclusive" || seen.has(u.accounting_identity)) continue;
    seen.add(u.accounting_identity);
    usage.push(u);
  }
  const semantics = [...usage.map((u) => u.usage_semantics), ...(i.trace_usable ? i.observed_semantics ?? [] : [])];
  const versions = analysisVersions(i.ledger, semantics, i.pricing, i.versions);
  const digest = inputManifestDigest(i.input_evidence);
  const key = analysisCacheKey(versions, digest, { source_id: i.source_id, run_id: i.run_id });
  const head: AnalysisLoss[] = [];
  if (!i.trace_usable) head.push({ code: "trace_unavailable", count: null, reason: "no retained v3 trace; usage, cost and time are unknown" });
  const natives = i.trace_usable ? i.native_sessions ?? 0 : 0;
  if (natives > 0) head.push({ code: "native_session_not_projected", count: natives, reason: "native session spend is kept only as the ledger native estimate; its session records are not projected" });
  const unallocated = (i.trace_usable ? i.ledger.allocation.unallocated_request_ids : []).filter((x) => TRACE_ID_RE.test(x));
  const omitted = Math.max(0, usage.length - LIMITS.usage) + Math.max(0, unallocated.length - LIMITS.unallocated) + Math.max(0, i.input_evidence.length - LIMITS.evidence);
  if (omitted > 0) head.push({ code: "projection_truncated", count: omitted, reason: `usage, unallocated ids or input evidence exceed the contract bound; ${omitted} omitted (the manifest digest still covers all inputs)` });
  const tail = [...i.ledger.losses, ...i.ledger.time.losses].map((l) => ({ code: l.code, count: l.count, reason: l.reason }));
  const room = LIMITS.losses - head.length;
  const losses = tail.length > room ? [...head, ...tail.slice(0, room - 1), { code: "losses_truncated", count: tail.length - room + 1, reason: "more ledger losses than the contract bound" }] : [...head, ...tail];
  let observability: StateAxes["observability"] = i.trace_usable ? i.ledger.coverage.requests.state : "unavailable";
  if (observability === "complete" && (natives > 0 || omitted > 0)) observability = "partial";
  return {
    schema_version: RUN_ANALYSIS_V2_SCHEMA,
    run: { source_id: i.source_id, kind: "run", id: i.run_id, revision: digest },
    analysis_id: analysisIdOf(key),
    query: {
      schema_version: QUERY_SCHEMA, versions,
      snapshot: { input_manifest_digest: digest, source_ids: [i.source_id], source_generations: [{ source_id: i.source_id, generation: digest }], as_of: i.as_of },
      grain: "run", filters: [{ dimension: "run", values: [i.run_id] }],
      window: { from: SNAPSHOT_FROM, to: i.as_of, basis: "as_of_snapshot", timezone: "UTC" },
      cohort_hash: sha(canonical({ source_id: i.source_id, run_id: i.run_id })), underlying_scalar: null,
    },
    input_evidence: i.input_evidence.slice(0, LIMITS.evidence),
    usage: usage.slice(0, LIMITS.usage),
    state: { lifecycle: "unknown", outcome: "unknown", acceptance: "unknown", observability },
    metrics: [],
    unallocated_request_ids: unallocated.slice(0, LIMITS.unallocated),
    losses,
  };
}

// ── Validation (schema mirror + verify_contracts.py rules) ───────────────────

const C = TRACE_V3_CHECKS;
const versionSet = C.object(Object.fromEntries(VERSION_DIMENSIONS.map((d) => [d, C.str])) as Record<string, TraceShapeCheck>);
const entity = C.object({ source_id: C.id, kind: C.str, id: C.id, revision: C.hash });
const uniq = (item: TraceShapeCheck, max: number, min = 0): TraceShapeCheck => (v, at, e) => {
  C.array(item, max)(v, at, e);
  if (!Array.isArray(v)) return;
  if (v.length < min) e.push(`${at}: fewer than ${min} items`);
  if (new Set(v.map(canonical)).size !== v.length) e.push(`${at}: items not unique`);
};
const atLeast = (item: TraceShapeCheck, max: number, min: number): TraceShapeCheck => (v, at, e) => {
  C.array(item, max)(v, at, e);
  if (Array.isArray(v) && v.length < min) e.push(`${at}: fewer than ${min} items`);
};
const FILTER_DIMENSIONS = ["initiative", "run", "execution", "phase", "goal", "task", "attempt", "agent", "host", "requested_model", "observed_model", "workflow_revision", "config", "case", "scorer", "pair", "applied_revision", "knowledge_channel", "generation"];
const KINDS = ["initiative", "run", "execution", "host_session", "goal", "logical_task", "task_attempt", "agent_instance", "request", "operation", "decision", "workflow", "component", "invocation", "obligation", "memory", "knowledge", "candidate", "agent", "skill", "tool", "team", "loop", "config", "evaluation", "report", "benchmark_case", "transfer", "query"];
const query = C.object({
  schema_version: C.str, versions: versionSet,
  snapshot: C.object({
    input_manifest_digest: C.hash, source_ids: uniq(C.id, 100, 1),
    source_generations: atLeast(C.object({ source_id: C.id, generation: C.hash }), 100, 1), as_of: C.time,
  }),
  grain: C.oneOf(...KINDS),
  filters: C.array(C.object({ dimension: C.oneOf(...FILTER_DIMENSIONS), values: uniq(C.str, 100, 1) }), 50),
  window: C.object({ from: C.time, to: C.time, basis: C.oneOf("activity_completed", "accepted_outcome_cohort", "as_of_snapshot"), timezone: C.str }),
  cohort_hash: C.hash,
  underlying_scalar: C.nullable(C.object({ metric_id: C.id, formula_version: C.str })),
});
const stateAxes = C.object({
  lifecycle: C.oneOf("created", "active", "suspended", "closed", "unknown"),
  outcome: C.oneOf("pending", "succeeded", "failed", "cancelled", "partial", "unknown"),
  acceptance: C.oneOf("pending", "verified", "rejected", "not_required", "unknown"),
  observability: C.oneOf("complete", "partial", "unavailable"),
});
const anyArray = (max: number): TraceShapeCheck => (v, at, e) => { if (!Array.isArray(v)) e.push(`${at}: not an array`); else if (v.length > max) e.push(`${at}: more than ${max} items`); };
const analysisShape = C.object({
  schema_version: C.konst(RUN_ANALYSIS_V2_SCHEMA), run: entity, analysis_id: C.id, query,
  input_evidence: C.array(C.evidence, 1000), usage: C.array(C.usage, 1000), state: stateAxes, metrics: anyArray(104),
  unallocated_request_ids: uniq(C.id, 1000),
  losses: C.array(C.object({ code: C.id, count: C.nullable(C.int0), reason: C.str }), 100),
});
const comparisonShape = C.object({
  schema_version: C.konst(RUN_COMPARISON_V2_SCHEMA), comparison_id: C.id, query,
  runs: atLeast(entity, 100, 2), analysis_refs: atLeast(C.evidence, 100, 2), input_versions: atLeast(versionSet, 100, 2),
  cohort_conditions_hash: C.hash, compatibility: C.oneOf("compatible", "refused"), refusal_reasons: C.array(C.str, 100),
  metrics: anyArray(104),
});

function verdict(errors: string[]): Verdict { return errors.length === 0 ? { ok: true } : { ok: false, errors }; }

export function validateRunAnalysisV2(value: unknown): Verdict {
  const errors: string[] = [];
  analysisShape(value, "$", errors);
  if (errors.length) return verdict(errors);
  const v = value as RunAnalysisV2;
  const require = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
  errors.push(...nestedSeriesErrors(v.query, v.metrics, "analysis"));
  const ids = new Set<string>();
  for (const u of v.usage) {
    usageRules(u, require);
    require(!ids.has(u.accounting_identity), "duplicate accounting identity; normalized ledger keeps only current observation");
    ids.add(u.accounting_identity);
    require(u.inclusion !== "parent_inclusive", "normalized usage cannot bill parent-inclusive counters");
  }
  const sessions = new Set(v.usage.filter((u) => u.granularity === "native_session").map((u) => u.accounting_identity));
  require(!v.usage.some((u) => u.granularity === "leaf_request" && u.parent_accounting_identity !== null && sessions.has(u.parent_accounting_identity)), "normalized ledger cannot overlap session and leaf scopes");
  queryRules(v.query, require);
  if (v.state.outcome === "succeeded") require(v.state.acceptance === "verified", "success requires verified acceptance");
  if (v.state.lifecycle === "closed") require(v.state.outcome !== "pending" && v.state.outcome !== "unknown", "closed cannot have pending/unknown outcome");
  const sources = v.query.snapshot.source_ids;
  require(v.run.kind === "run" && sources.includes(v.run.source_id), "analysis source/run mismatch");
  require(v.input_evidence.every((x) => sources.includes(x.source_id)), "analysis input evidence outside query snapshot sources");
  return verdict(errors);
}

function queryRules(q: QueryIdentity, require: (ok: boolean, msg: string) => void): void {
  require(snapshotGenerationsOwned(q), "snapshot source/generation identity mismatch");
  require(compareTraceInstants(q.window.from, q.window.to) < 0, "window must be nonempty half-open [from,to)");
}

function snapshotGenerationsOwned(q: QueryIdentity): boolean {
  const gens = q.snapshot.source_generations.map((g) => g.source_id);
  return gens.every((s) => q.snapshot.source_ids.includes(s)) && q.snapshot.source_ids.every((s) => gens.includes(s)) && new Set(gens).size === gens.length;
}

export function validateRunComparisonV2(value: unknown): Verdict {
  const errors: string[] = [];
  comparisonShape(value, "$", errors);
  if (errors.length) return verdict(errors);
  const v = value as RunComparisonV2;
  const require = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
  errors.push(...nestedSeriesErrors(v.query, v.metrics, "comparison"));
  const keys = v.runs.map((x) => `${x.source_id}\u0000${x.id}`);
  require(new Set(keys).size === keys.length, "duplicate compared run");
  require(v.runs.length === v.analysis_refs.length && v.runs.length === v.input_versions.length, "comparison input cardinality mismatch");
  queryRules(v.query, require);
  const sources = v.query.snapshot.source_ids;
  require([...v.runs, ...v.analysis_refs].every((x) => sources.includes(x.source_id)), "comparison run or analysis ref outside query snapshot sources");
  if (v.compatibility === "compatible") {
    require(v.analysis_refs.every((e) => e.schema_version === RUN_ANALYSIS_V2_SCHEMA) && v.input_versions.every((x) => canonical(x) === canonical(v.query.versions)),
      "incompatible analysis schema/normalizer/semantics/pricing versions cannot be ranked");
  }
  require((v.compatibility === "compatible") === (v.refusal_reasons.length === 0), "comparison refusal state mismatch");
  return verdict(errors);
}

const runDir = (runId: string) => `analysis/runs/${runId}`;
const bodyRel = (runId: string, analysisId: string) => `${runDir(runId)}/versions/${analysisId}/analysis.json`;

// ── Read ───────────────────────────────────────────────────

export interface RunInputs { evidence: TraceEvidence[]; traceUsable: boolean; trace: ReturnType<typeof readTrace> | null }

/**
 * Read one run's retained inputs bound to their manifest digest: hash, read,
 * hash again, and keep the read only when nothing changed in between. Writes nothing.
 */
export function readRunInputs(root: string, sourceId: string, runId: string, asOf: string): RunInputs {
  let snapshot: RunInputs | null = null;
  for (let attempt = 0; attempt < 3 && snapshot === null; attempt++) {
    // A probe read discovers the sidecar dependencies so they are hashed before the projection read too.
    const before = retainedEvidence(root, sourceId, runId, asOf);
    const probe = before.traceUsable ? readTrace(root, runId) : null;
    const evidence = [...before.evidence, ...payloadEvidence(root, sourceId, probe?.events ?? [], asOf)];
    const read = before.traceUsable ? readTrace(root, runId) : null;
    const after = retainedEvidence(root, sourceId, runId, asOf);
    const again = [...after.evidence, ...payloadEvidence(root, sourceId, read?.events ?? [], asOf)];
    if (inputManifestDigest(evidence) === inputManifestDigest(again)) snapshot = { evidence, traceUsable: before.traceUsable, trace: read };
  }
  if (snapshot === null) throw new Error(`run ${runId} inputs kept changing during analysis; retry later`);
  return snapshot;
}

// ── Legacy v1 ────────────────────────────────────────────────────────────────

export interface LegacyV1UsageProjection {
  schema_version: "guild.run_analysis.v1"; usage_semantics: typeof LEGACY_V1_USAGE_SEMANTICS; label: string;
  input: number; output: number; cached: number; total: number; comparable_with_v2: false;
}

/** v1 token totals as recorded, labelled with their legacy meaning. Never renormalized. */
export function legacyV1UsageProjection(v1: unknown): LegacyV1UsageProjection {
  const tokens = isObj(v1) && isObj(v1["usage"]) && isObj((v1["usage"] as Record<string, unknown>)["tokens"]) ? (v1["usage"] as Record<string, Record<string, unknown>>)["tokens"]! : null;
  if (!isObj(v1) || v1["schema_version"] !== "guild.run_analysis.v1" || !tokens) throw new Error("not a guild.run_analysis.v1 artifact");
  const n = (k: string) => { const x = tokens[k]; if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new Error(`v1 tokens.${k} is not a count`); return x; };
  return {
    schema_version: "guild.run_analysis.v1", usage_semantics: LEGACY_V1_USAGE_SEMANTICS,
    label: "legacy v1 total = input + output + cached; cached tokens are counted twice relative to v2",
    input: n("input"), output: n("output"), cached: n("cached"), total: n("total"), comparable_with_v2: false,
  };
}

// ── Comparison ───────────────────────────────────────────────────────────────

export type ComparisonInput = { analysis: RunAnalysisV2 } | { legacy: unknown; source_id: string };
const legacyVersions = (): VersionSet => ({
  schema: "guild.run_analysis.v1", analyzer: LEGACY_V1_VERSION, normalizer: LEGACY_V1_VERSION, formula: LEGACY_V1_VERSION,
  usage_semantics: LEGACY_V1_USAGE_SEMANTICS, pricing: LEGACY_V1_VERSION, aggregation: LEGACY_V1_VERSION,
});

/**
 * Compare runs only on identical version sets. Any v1 input or any differing
 * dimension refuses the comparison with a reason per run; nothing is ranked.
 */
export function compareRunsV2(inputs: readonly ComparisonInput[], opts: { as_of: string; versions?: VersionSet }): RunComparisonV2 {
  if (inputs.length < 2 || inputs.length > 100) throw new Error("comparison needs 2 to 100 runs");
  if (!isRfc3339(opts.as_of)) throw new Error("as_of must be an RFC 3339 instant");
  const runs: RunEntity[] = [];
  const refs: TraceEvidence[] = [];
  const versions: VersionSet[] = [];
  const late: string[] = [];
  for (const input of inputs) {
    if ("analysis" in input) {
      const a = input.analysis;
      const ok = validateRunAnalysisV2(a);
      if (!ok.ok) throw new Error(`invalid run analysis ${a?.analysis_id}: ${ok.errors.join("; ")}`);
      runs.push(a.run);
      refs.push({ source_id: a.run.source_id, path: bodyRel(a.run.id, a.analysis_id), sha256: sha(bodyBytes(a)), schema_version: RUN_ANALYSIS_V2_SCHEMA, observed_at: opts.as_of, availability: "available", reason: null });
      versions.push(a.query.versions);
      if (compareTraceInstants(a.query.snapshot.as_of, opts.as_of) > 0) late.push(`${a.run.id}: analysis snapshot ${a.query.snapshot.as_of} is later than the comparison as_of`);
    } else {
      const v1 = input.legacy as Record<string, unknown>;
      legacyV1UsageProjection(v1);
      const runId = v1["run_id"];
      const sourceHash = v1["source_hash"];
      if (typeof runId !== "string" || !TRACE_ID_RE.test(runId) || typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("v1 analysis lacks a usable run id or source hash");
      runs.push({ source_id: input.source_id, kind: "run", id: runId, revision: `sha256:${sourceHash}` });
      refs.push({ source_id: input.source_id, path: `${runDir(runId)}/analysis.json`, sha256: sha(bodyBytes(v1)), schema_version: "guild.run_analysis.v1", observed_at: opts.as_of, availability: "available", reason: null });
      versions.push(legacyVersions());
    }
  }
  const keys = runs.map((r) => `${r.source_id}\u0000${r.id}`);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate compared run");
  const pinned = opts.versions ?? versions.find((v) => v.schema === RUN_ANALYSIS_V2_SCHEMA) ?? versions[0]!;
  const reasons: string[] = [...late];
  inputs.forEach((input, i) => {
    if (!("analysis" in input)) reasons.push(`${runs[i]!.id}: legacy v1 analysis (${LEGACY_V1_USAGE_SEMANTICS}) cannot be ranked with v2`);
    else {
      const dims = versionDifferences(versions[i]!, pinned);
      if (dims.length) reasons.push(`${runs[i]!.id}: version mismatch in ${dims.join(", ")}`);
    }
  });
  const sources = [...new Set(runs.map((r) => r.source_id))].sort();
  const digest = sha(canonical(refs.map((r) => ({ path: r.path, sha256: r.sha256, source_id: r.source_id }))));
  const cohort = sha(canonical(keys.slice().sort()));
  const query: QueryIdentity = {
    schema_version: QUERY_SCHEMA, versions: pinned,
    snapshot: {
      input_manifest_digest: digest, source_ids: sources,
      source_generations: sources.map((s) => ({ source_id: s, generation: sha(canonical(refs.filter((r) => r.source_id === s).map((r) => r.sha256))) })),
      as_of: opts.as_of,
    },
    grain: "run", filters: [{ dimension: "run", values: [...new Set(runs.map((r) => r.id))] }],
    window: { from: SNAPSHOT_FROM, to: opts.as_of, basis: "as_of_snapshot", timezone: "UTC" },
    cohort_hash: cohort, underlying_scalar: null,
  };
  return {
    schema_version: RUN_COMPARISON_V2_SCHEMA,
    comparison_id: `comparison-v2.${digest.slice(7, 39)}`,
    query, runs, analysis_refs: refs, input_versions: versions, cohort_conditions_hash: cohort,
    compatibility: reasons.length ? "refused" : "compatible", refusal_reasons: reasons.slice(0, 100), metrics: [],
  };
}
