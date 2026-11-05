// c9/evaluation.ts — B01 · P08/P10 evaluation lineage for the benchmark engine.
//
// C10 EvaluationManifest v2 validation, an idempotent evaluation import ledger
// (one identity and one billable request set per evaluation, however often it is
// imported or rerun), paired baseline/candidate analysis with declared
// conditions, sample size, uncertainty and quality floor, the applied-revision
// join, and the operational spend join with linked runs. Quality (scores) and
// operational efficiency (cost, latency, requests) stay separate objects: cost
// never turns a quality result into an improvement.

import {
  QUERY_IDENTITY_CHECK,
  canonicalJson,
  makeCoverage,
  queryRules,
  sha256,
  type Coverage,
  type EvaluationFact,
  type Evidence,
  type QueryIdentity,
  type RunFacts,
  type Verdict,
} from "./metric-series.js";
import { TRACE_ID_RE, TRACE_V3_CHECKS, type TraceShapeCheck } from "./trace-analysis.js";

export const EVALUATION_MANIFEST_V2_SCHEMA = "guild.stack.evaluation-manifest.v2" as const;
export const EVALUATION_TRIAL_SCHEMA = "guild.benchmark.evaluation-trial.v1" as const;
export const PAIRED_EVALUATION_SCHEMA = "guild.benchmark.paired-evaluation.v1" as const;
export const EVALUATION_SPEND_SCHEMA = "guild.benchmark.evaluation-spend.v1" as const;
export const PAIRED_FORMULA_VERSION = "b01.paired.t95.2" as const;
/** The KTD16 home of an evaluation's artifacts under a source's `.guild/`. */
export const evaluationHome = (evaluationId: string) => `artifacts/generated/benchmarks/${evaluationId}/`;
export const EVALUATION_LIMITS = Object.freeze({ trials: 20000, usage_per_trial: 1000, listed: 100 });

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface Entity { source_id: string; kind: string; id: string; revision: string }
export interface EvaluationCase { case_id: string; case_version: string; scorer_version: string; input_hash: string; difficulty: string | null }
export interface EvaluationManifestV2 {
  schema_version: typeof EVALUATION_MANIFEST_V2_SCHEMA;
  evaluation: Entity;
  cases: EvaluationCase[];
  pairing: { baseline_revision: string; candidate_revision: string; pair_ids: string[]; seed_policy: string; repetition_count: number; quality_floor: number | null };
  configuration_hash: string; requested_model: string;
  observed_identity: { provider: string | null; model: string | null; status: "observed" | "unavailable"; reason: string | null };
  applied_revision: string | null;
  linked_runs: Entity[]; accounting_identities: string[];
  query: QueryIdentity;
  budget: { mode: "strict_verified" | "native_spend_threshold"; threshold_usd: number; duration_limit_ms: number; overshoot_possible: boolean; qualification: Evidence; policy_hash: string };
  coverage: Coverage; artifacts: Evidence[]; receipt: Evidence;
}

export type Arm = "baseline" | "candidate";
export type TrialStatus = "completed" | "cancelled" | "timeout" | "error";
/** One billable request a trial made; its identity is billed once per evaluation, however often it is imported. */
export interface TrialUsage { accounting_identity: string; cost_usd: number | null; cost_basis: "measured" | "derived_estimate" | "unavailable"; tokens: number | null }
/** One attempt at one (pair, arm, repetition) slot, with the conditions it actually ran under. */
export interface TrialRecord {
  schema_version: typeof EVALUATION_TRIAL_SCHEMA;
  evaluation: { source_id: string; id: string };
  attempt_id: string; rerun_of: string | null;
  pair_id: string; case_id: string; arm: Arm; repetition: number; seed: string;
  revision: string; case_version: string; scorer_version: string; input_hash: string;
  requested_model: string; configuration_hash: string; observed_model: string | null;
  status: TrialStatus; score: number | null; latency_ms: number | null;
  usage: TrialUsage[];
  /** The operational run (job) the attempt executed in; it must be one of the manifest's linked runs. */
  run: { source_id: string; id: string } | null;
  evidence: Evidence;
}

export type EvaluationRefusalCode = "invalid_manifest" | "invalid_trial" | "revision_conflict" | "attempt_conflict" | "accounting_conflict" | "unlinked_run" | "applied_revision_mismatch";
export class EvaluationRefusal extends Error {
  constructor(readonly code: EvaluationRefusalCode, message: string) { super(message); }
}

// ── Validation (schema mirror + verify_contracts.py rules) ───────────────────

const C = TRACE_V3_CHECKS;
const KINDS = ["initiative", "run", "execution", "host_session", "goal", "logical_task", "task_attempt", "agent_instance", "request", "operation", "decision", "workflow", "component", "invocation", "obligation", "memory", "knowledge", "candidate", "agent", "skill", "tool", "team", "loop", "config", "evaluation", "report", "benchmark_case", "transfer", "query"];
const num: TraceShapeCheck = (v, at, e) => { if (typeof v !== "number" || !Number.isFinite(v)) e.push(`${at}: not a number`); };
const int1: TraceShapeCheck = (v, at, e) => { if (typeof v !== "number" || !Number.isInteger(v) || v < 1) e.push(`${at}: not an integer >= 1`); };
const bounded = (item: TraceShapeCheck, max: number, min: number, unique: boolean): TraceShapeCheck => (v, at, e) => {
  C.array(item, max)(v, at, e);
  if (!Array.isArray(v)) return;
  if (v.length < min) e.push(`${at}: fewer than ${min} items`);
  if (unique && new Set(v.map(canonicalJson)).size !== v.length) e.push(`${at}: items not unique`);
};
const entity = C.object({ source_id: C.id, kind: C.oneOf(...KINDS), id: C.id, revision: C.hash });
const manifestShape = C.object({
  schema_version: C.konst(EVALUATION_MANIFEST_V2_SCHEMA),
  evaluation: entity,
  cases: bounded(C.object({ case_id: C.id, case_version: C.str, scorer_version: C.str, input_hash: C.hash, difficulty: C.nullable(C.str) }), 1000, 1, false),
  pairing: C.object({
    baseline_revision: C.hash, candidate_revision: C.hash, pair_ids: bounded(C.id, 1000, 0, true),
    seed_policy: C.str, repetition_count: int1, quality_floor: C.nullable(num),
  }),
  configuration_hash: C.hash, requested_model: C.str,
  observed_identity: C.object({ provider: C.nullable(C.str), model: C.nullable(C.str), status: C.oneOf("observed", "unavailable"), reason: C.nullable(C.str) }),
  applied_revision: C.nullable(C.hash),
  linked_runs: C.array(entity, 1000), accounting_identities: bounded(C.id, 1000, 0, true),
  query: QUERY_IDENTITY_CHECK,
  budget: C.object({
    mode: C.oneOf("strict_verified", "native_spend_threshold"), threshold_usd: C.num0,
    duration_limit_ms: int1, overshoot_possible: C.bool, qualification: C.evidence, policy_hash: C.hash,
  }),
  coverage: C.coverage, artifacts: C.array(C.evidence, 1000), receipt: C.evidence,
});
const trialShape = C.object({
  schema_version: C.konst(EVALUATION_TRIAL_SCHEMA), evaluation: C.object({ source_id: C.id, id: C.id }),
  attempt_id: C.id, rerun_of: C.nullable(C.id), pair_id: C.id, case_id: C.id, arm: C.oneOf("baseline", "candidate"),
  repetition: int1, seed: C.str, revision: C.hash, case_version: C.str, scorer_version: C.str, input_hash: C.hash,
  requested_model: C.str, configuration_hash: C.hash, observed_model: C.nullable(C.str),
  status: C.oneOf("completed", "cancelled", "timeout", "error"), score: C.nullable(num), latency_ms: C.nullable(C.num0),
  usage: C.array(C.object({ accounting_identity: C.id, cost_usd: C.nullable(C.num0), cost_basis: C.oneOf("measured", "derived_estimate", "unavailable"), tokens: C.nullable(C.int0) }), EVALUATION_LIMITS.usage_per_trial),
  run: C.nullable(C.object({ source_id: C.id, id: C.id })), evidence: C.evidence,
});

function coverageRule(c: Coverage, require: (ok: boolean, msg: string) => void): void {
  if (c.eligible !== null) {
    require(c.covered <= c.eligible, "covered exceeds eligible");
    if (c.missing !== null) require(c.covered + c.missing === c.eligible, "eligible must equal covered plus missing; excluded is outside eligible");
  }
  if (c.state === "complete") require(c.eligible !== null && c.covered === c.eligible && c.missing === 0, "complete requires known full coverage");
  else require(Boolean(c.reason), "incomplete coverage needs reason");
  if (c.state === "unavailable") require(c.covered === 0, "unavailable coverage cannot have covered samples");
}
const verdict = (errors: string[]): Verdict => (errors.length === 0 ? { ok: true } : { ok: false, errors });
const disclosed = (e: Evidence) => e.availability === "available" || ((e.availability === "expired" || e.availability === "redacted") && Boolean(e.reason));

export function validateEvaluationManifestV2(value: unknown): Verdict {
  const errors: string[] = [];
  manifestShape(value, "$", errors);
  if (errors.length) return verdict(errors);
  const v = value as EvaluationManifestV2;
  const require = (ok: boolean, msg: string) => { if (!ok) errors.push(msg); };
  queryRules(v.query, require);
  // Shared verify_contracts.py walk rules that apply to this document.
  coverageRule(v.coverage, require);
  const b = v.budget;
  require(b.threshold_usd > 0, "paid dispatch threshold must be positive");
  require(b.overshoot_possible === (b.mode === "native_spend_threshold"), "native threshold may overshoot; strict mode requires separate verified qualification");
  require(disclosed(b.qualification), "budget qualification cannot rest on missing or unsupported evidence");
  const oi = v.observed_identity;
  if (oi.status === "observed") require(oi.model !== null, "observed identity needs observed model");
  else require(oi.model === null && Boolean(oi.reason), "unavailable observed identity needs null model and reason");
  const owner = v.evaluation.source_id;
  require(v.evaluation.kind === "evaluation", "evaluation kind mismatch");
  require(v.artifacts.every((x) => x.source_id === owner && x.path.startsWith(evaluationHome(v.evaluation.id))), "evaluation artifact owner/home mismatch");
  require(disclosed(v.receipt), "evaluation receipt cannot rest on missing or unsupported evidence");
  require(v.receipt.source_id === owner && v.budget.qualification.source_id === owner, "evaluation receipt/budget qualification owner mismatch");
  require(v.linked_runs.every((x) => v.query.snapshot.source_ids.includes(x.source_id)), "evaluation linked run outside query snapshot sources");
  return verdict(errors);
}

/** B01 rules the contract leaves to the evaluation engine: one case row per case, runs are runs, arms differ. */
function manifestEngineErrors(m: EvaluationManifestV2): string[] {
  const out: string[] = [];
  const ids = m.cases.map((c) => c.case_id);
  if (new Set(ids).size !== ids.length) out.push("a case id is declared twice with different conditions");
  if (m.linked_runs.some((r) => r.kind !== "run")) out.push("a linked run must be a run entity");
  if (m.pairing.baseline_revision === m.pairing.candidate_revision) out.push("baseline and candidate revisions are the same; nothing is compared");
  if (m.evaluation.id.includes(":") || m.evaluation.id.includes("/")) out.push("evaluation id is not a contract path segment");
  if (m.pairing.pair_ids.length * m.pairing.repetition_count * 2 > EVALUATION_LIMITS.trials) out.push(`declared pairs x repetitions x 2 arms exceed the ${EVALUATION_LIMITS.trials}-slot bound`);
  const runs = m.linked_runs.map((r) => `${r.source_id}\u0000${r.id}`);
  if (new Set(runs).size !== runs.length) out.push("a linked run is declared twice");
  if (new Set(m.cases.map((c) => c.scorer_version)).size > 1) out.push("cases declare several scorer versions; one evaluation compares scores on one scale");
  return out;
}

export function validateTrialRecord(value: unknown): Verdict {
  const errors: string[] = [];
  trialShape(value, "$", errors);
  if (errors.length) return verdict(errors);
  const t = value as TrialRecord;
  if (t.status === "completed" && t.score === null) errors.push("a completed trial must report its score; a missing score is not completion");
  if (t.status !== "completed" && t.score !== null) errors.push("only a completed trial carries a score");
  const ids = t.usage.map((u) => u.accounting_identity);
  if (new Set(ids).size !== ids.length) errors.push("a trial bills one accounting identity twice");
  for (const u of t.usage) if ((u.cost_usd === null) !== (u.cost_basis === "unavailable")) errors.push(`usage ${u.accounting_identity}: cost and cost basis disagree`);
  if (t.rerun_of === t.attempt_id) errors.push("an attempt cannot rerun itself");
  return verdict(errors);
}

// ── Import ledger ────────────────────────────────────────────────────────────

export interface LedgerEntry {
  key: string;
  manifest: EvaluationManifestV2;
  /** Manifest revisions imported for this identity, oldest first (a recovery re-receipt advances it). */
  revisions: string[];
  attempts: Map<string, TrialRecord>;
  /** The billable request set: `source NUL identity` → the one usage observation billed for it. */
  billable: Map<string, { usage: TrialUsage; attempt_id: string; source_id: string }>;
}
export interface ImportReceipt {
  evaluation_key: string; outcome: "created" | "unchanged" | "extended" | "re_receipted";
  added_attempts: number; duplicate_attempts: number; billable_requests: number;
}

const evalKey = (e: { source_id: string; id: string }) => `${e.source_id}:${e.id}`;
const sameConditions = (a: EvaluationManifestV2, b: EvaluationManifestV2) =>
  canonicalJson([a.cases, a.pairing, a.configuration_hash, a.requested_model, a.observed_identity]) === canonicalJson([b.cases, b.pairing, b.configuration_hash, b.requested_model, b.observed_identity]);
const slotKey = (t: Pick<TrialRecord, "pair_id" | "arm" | "repetition">) => `${t.pair_id}\u0000${t.arm}\u0000${t.repetition}`;

/**
 * Imports are idempotent by (source, evaluation id): the same manifest and trials
 * imported twice leave one evaluation and one billable request set. A changed
 * revision is accepted only as a recovery re-receipt with identical conditions and a
 * superset of accounting identities; anything else is a conflict, not a second copy.
 */
export class EvaluationLedger {
  readonly entries = new Map<string, LedgerEntry>();

  import(manifestValue: unknown, trialValues: readonly unknown[]): ImportReceipt {
    const mv = validateEvaluationManifestV2(manifestValue);
    if (!mv.ok) throw new EvaluationRefusal("invalid_manifest", mv.errors.join("; ").slice(0, 4000));
    // The ledger keeps its own copies: a caller mutating its objects cannot rewrite accepted history.
    const manifest = structuredClone(manifestValue) as EvaluationManifestV2;
    const engine = manifestEngineErrors(manifest);
    if (engine.length) throw new EvaluationRefusal("invalid_manifest", engine.join("; "));
    if (trialValues.length > EVALUATION_LIMITS.trials) throw new EvaluationRefusal("invalid_trial", `more than ${EVALUATION_LIMITS.trials} trials`);
    const key = evalKey(manifest.evaluation);
    const prior = this.entries.get(key);
    let outcome: ImportReceipt["outcome"] = prior ? "unchanged" : "created";
    // Validate everything before mutating, so a refused import leaves the ledger as it was.
    const next: LedgerEntry = prior
      ? { ...prior, revisions: [...prior.revisions], attempts: new Map(prior.attempts), billable: new Map(prior.billable) }
      : { key, manifest, revisions: [manifest.evaluation.revision], attempts: new Map(), billable: new Map() };
    if (prior && canonicalJson(prior.manifest) !== canonicalJson(manifest)) {
      if (prior.manifest.evaluation.revision === manifest.evaluation.revision) throw new EvaluationRefusal("revision_conflict", `evaluation ${key} revision ${manifest.evaluation.revision} was imported with different content`);
      if (prior.revisions.includes(manifest.evaluation.revision)) throw new EvaluationRefusal("revision_conflict", `evaluation ${key} revision ${manifest.evaluation.revision} is older than the imported revision`);
      if (!sameConditions(prior.manifest, manifest)) throw new EvaluationRefusal("revision_conflict", `evaluation ${key} changed its cases, pairing, configuration or model; that is a new evaluation, not a re-receipt`);
      if (!prior.manifest.accounting_identities.every((x) => manifest.accounting_identities.includes(x))) throw new EvaluationRefusal("revision_conflict", `evaluation ${key} re-receipt drops billed accounting identities`);
      const runKey = (r: Entity) => `${r.source_id}\u0000${r.kind}\u0000${r.id}`;
      if (!prior.manifest.linked_runs.every((r) => manifest.linked_runs.some((x) => runKey(x) === runKey(r)))) throw new EvaluationRefusal("revision_conflict", `evaluation ${key} re-receipt drops linked runs`);
      next.manifest = manifest;
      next.revisions.push(manifest.evaluation.revision);
      outcome = "re_receipted";
    }
    const declared = new Set(next.manifest.accounting_identities);
    const linked = new Set(next.manifest.linked_runs.map((r) => `${r.source_id}\u0000${r.id}`));
    let added = 0, dup = 0;
    const pairs = new Set(next.manifest.pairing.pair_ids);
    for (const tv of trialValues) {
      const r = validateTrialRecord(tv);
      if (!r.ok) throw new EvaluationRefusal("invalid_trial", r.errors.join("; ").slice(0, 4000));
      const t = structuredClone(tv) as TrialRecord;
      if (!pairs.has(t.pair_id)) throw new EvaluationRefusal("invalid_trial", `trial ${t.attempt_id} names pair ${t.pair_id}, which the manifest does not declare`);
      if (t.repetition > next.manifest.pairing.repetition_count) throw new EvaluationRefusal("invalid_trial", `trial ${t.attempt_id} repetition ${t.repetition} exceeds the declared ${next.manifest.pairing.repetition_count}`);
      if (evalKey(t.evaluation) !== key) throw new EvaluationRefusal("invalid_trial", `trial ${t.attempt_id} names evaluation ${evalKey(t.evaluation)}, not ${key}`);
      if (t.evidence.source_id !== manifest.evaluation.source_id) throw new EvaluationRefusal("invalid_trial", `trial ${t.attempt_id} evidence is not owned by the evaluation source`);
      if (t.run && !linked.has(`${t.run.source_id}\u0000${t.run.id}`)) throw new EvaluationRefusal("unlinked_run", `trial ${t.attempt_id} ran in ${t.run.source_id}:${t.run.id}, which the manifest does not link`);
      const seen = next.attempts.get(t.attempt_id);
      if (seen) {
        if (canonicalJson(seen) !== canonicalJson(t)) throw new EvaluationRefusal("attempt_conflict", `attempt ${t.attempt_id} was imported with different content`);
        dup++;
        continue;
      }
      // A request is billed in the source of the run that made it (the evaluation's own source without one).
      const src = t.run?.source_id ?? manifest.evaluation.source_id;
      for (const u of t.usage) {
        if (!declared.has(u.accounting_identity)) throw new EvaluationRefusal("accounting_conflict", `accounting identity ${u.accounting_identity} is not declared by the evaluation manifest`);
        const k = `${src}\u0000${u.accounting_identity}`;
        const billed = next.billable.get(k);
        if (billed) throw new EvaluationRefusal("accounting_conflict", `accounting identity ${src}:${u.accounting_identity} is already billed by attempt ${billed.attempt_id}`);
        next.billable.set(k, { usage: u, attempt_id: t.attempt_id, source_id: src });
      }
      next.attempts.set(t.attempt_id, t);
      added++;
    }
    // Chain rules over the whole attempt set: a rerun names an unsuccessful attempt of its own slot,
    // and a slot holds at most one completed attempt (no picking the best of several runs).
    const completedBySlot = new Map<string, string>();
    for (const t of next.attempts.values()) {
      if (t.rerun_of !== null) {
        const p = next.attempts.get(t.rerun_of);
        if (!p) throw new EvaluationRefusal("attempt_conflict", `attempt ${t.attempt_id} reruns unknown attempt ${t.rerun_of}`);
        if (slotKey(p) !== slotKey(t)) throw new EvaluationRefusal("attempt_conflict", `attempt ${t.attempt_id} reruns an attempt of another slot`);
        if (p.status === "completed") throw new EvaluationRefusal("attempt_conflict", `attempt ${t.attempt_id} reruns completed attempt ${p.attempt_id}; a completed slot is not rerun`);
      }
      if (t.status === "completed") {
        const other = completedBySlot.get(slotKey(t));
        if (other) throw new EvaluationRefusal("attempt_conflict", `slot ${t.pair_id}/${t.arm}/${t.repetition} has two completed attempts (${other}, ${t.attempt_id})`);
        completedBySlot.set(slotKey(t), t.attempt_id);
      }
    }
    if (added > 0 && outcome === "unchanged") outcome = "extended";
    this.entries.set(key, next);
    return { evaluation_key: key, outcome, added_attempts: added, duplicate_attempts: dup, billable_requests: next.billable.size };
  }
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export type SlotState = "completed" | "recovered" | "cancelled" | "timeout" | "error" | "missing";
export interface Recovery {
  state: "complete" | "partial";
  expected_slots: number; completed: number; recovered: number;
  open: { pair_id: string; arm: Arm; repetition: number; state: SlotState; attempts: number }[];
  open_count: number;
}

function slots(e: LedgerEntry): Map<string, { state: SlotState; final: TrialRecord | null; attempts: TrialRecord[] }> {
  const by = new Map<string, TrialRecord[]>();
  for (const t of e.attempts.values()) {
    const k = slotKey(t);
    by.set(k, [...(by.get(k) ?? []), t]);
  }
  const out = new Map<string, { state: SlotState; final: TrialRecord | null; attempts: TrialRecord[] }>();
  const { pair_ids, repetition_count } = e.manifest.pairing;
  for (const pair_id of [...pair_ids].sort()) for (const arm of ["baseline", "candidate"] as const) for (let repetition = 1; repetition <= repetition_count; repetition++) {
    const k = slotKey({ pair_id, arm, repetition });
    const attempts = (by.get(k) ?? []).sort((a, b) => (a.attempt_id < b.attempt_id ? -1 : 1));
    const done = attempts.find((t) => t.status === "completed") ?? null;
    // Without a completion the latest attempt is the one no other attempt reruns.
    const rerun = new Set(attempts.map((t) => t.rerun_of));
    const last = attempts.filter((t) => !rerun.has(t.attempt_id)).pop() ?? attempts[attempts.length - 1];
    const state: SlotState = done ? (attempts.length > 1 ? "recovered" : "completed") : last ? (last.status as SlotState) : "missing";
    out.set(k, { state, final: done, attempts });
  }
  return out;
}

export function evaluationRecovery(e: LedgerEntry): Recovery {
  const s = slots(e);
  const open: Recovery["open"] = [];
  let completed = 0, recovered = 0;
  for (const [k, v] of s) {
    if (v.state === "completed") completed++;
    else if (v.state === "recovered") { completed++; recovered++; }
    else {
      const [pair_id, arm, rep] = k.split("\u0000");
      open.push({ pair_id: pair_id!, arm: arm as Arm, repetition: Number(rep), state: v.state, attempts: v.attempts.length });
    }
  }
  return { state: open.length ? "partial" : "complete", expected_slots: s.size, completed, recovered, open: open.slice(0, EVALUATION_LIMITS.listed), open_count: open.length };
}

// ── Paired analysis ──────────────────────────────────────────────────────────

export interface PairedPolicy { min_samples: number }
export const DEFAULT_PAIRED_POLICY: PairedPolicy = Object.freeze({ min_samples: 3 });

export interface Statistic {
  n: number; mean: number | null; variance: number | null; std_error: number | null;
  ci95: [number, number] | null; method: "paired_t_interval.two_sided.95"; reason: string | null;
}
export interface PairedSample {
  pair_id: string; repetition: number; case_id: string; difficulty: string | null; scorer_version: string;
  baseline_score: number; candidate_score: number; score_delta: number;
  cost_delta_usd: number | null; latency_delta_ms: number | null;
  evidence: [Evidence, Evidence];
}
export type PairedLabel = "improvement" | "regression" | "no_detectable_difference" | "descriptive_only" | "refused";
export interface PairedEvaluation {
  schema_version: typeof PAIRED_EVALUATION_SCHEMA; formula_version: typeof PAIRED_FORMULA_VERSION;
  evaluation: Entity; revisions: string[];
  conditions: { configuration_hash: string; requested_model: string; observed_model: string | null; seed_policy: string; repetition_count: number; baseline_revision: string; candidate_revision: string; cases: EvaluationCase[] };
  policy: PairedPolicy;
  compatibility: "compatible" | "refused"; refusal_reasons: string[];
  sample: { expected: number; n: number; pairs: number; coverage: Coverage };
  /** Benchmark quality: scores only. Arm means use every compatible completed trial of the arm, not only paired survivors. */
  quality: {
    score_delta: Statistic; baseline_mean: number | null; candidate_mean: number | null;
    candidate_arm: { completed: number; expected: number };
    quality_floor: number | null; floor_met: boolean | null;
  };
  /** Operational efficiency: paired cost/latency deltas and the billable set; never part of the label. */
  operational: {
    cost_delta_usd: Statistic; cost_basis: SpendBasis; latency_delta_ms: Statistic;
    billable_requests: number; unobserved_requests: number;
    spend_basis: SpendBasis; spend_by_basis: { measured: number; derived_estimate: number };
    /** Null when bases are mixed: measured billing and estimates are not added. */
    known_spend_usd: number | null; exact_spend_usd: number | null;
  };
  label: PairedLabel; label_reason: string;
  applied: { applied_revision: string | null; state: "not_applied" | "joined" | "refused"; reason: string | null };
  recovery: Recovery;
  samples: PairedSample[];
  result_hash: string;
}
export type SpendBasis = "measured" | "derived_estimate" | "unavailable" | "mixed";

/** Two-sided 97.5% Student t quantiles for df 1..30; above, the Cornish-Fisher expansion (error < 1e-4). */
const T975 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
export function tQuantile975(df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new Error("degrees of freedom must be a positive integer");
  if (df <= 30) return T975[df - 1]!;
  const z = 1.959963984540054;
  const g1 = (z ** 3 + z) / 4;
  const g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96;
  const g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  const g4 = (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
}
/** Order-independent sum: values are added in sorted order, so the same multiset gives the same bits. */
const fsum = (xs: readonly number[]) => [...xs].sort((a, b) => a - b).reduce((a, x) => a + x, 0);
export function pairedStatistic(xs: readonly number[]): Statistic {
  const n = xs.length;
  const base = { n, method: "paired_t_interval.two_sided.95" as const };
  if (n === 0) return { ...base, mean: null, variance: null, std_error: null, ci95: null, reason: "no paired samples" };
  const mean = fsum(xs) / n;
  if (n < 2) return { ...base, mean, variance: null, std_error: null, ci95: null, reason: "one paired sample has no variance" };
  const variance = fsum(xs.map((x) => (x - mean) ** 2)) / (n - 1);
  const std_error = Math.sqrt(variance / n);
  const t = tQuantile975(n - 1);
  return { ...base, mean, variance, std_error, ci95: [mean - t * std_error, mean + t * std_error], reason: null };
}

const costOf = (t: TrialRecord): { usd: number | null; basis: TrialUsage["cost_basis"] | "mixed" | null } => {
  if (t.usage.length === 0) return { usd: null, basis: null };
  const bases = new Set(t.usage.map((u) => u.cost_basis));
  if (bases.has("unavailable")) return { usd: null, basis: "unavailable" };
  if (bases.size > 1) return { usd: null, basis: "mixed" };
  return { usd: fsum(t.usage.map((u) => u.cost_usd!)), basis: t.usage[0]!.cost_basis };
};

/** Why a completed trial does not run under the manifest's declared conditions (null when it does). */
function conditionMismatch(m: EvaluationManifestV2, t: TrialRecord): string | null {
  const c = m.cases.find((x) => x.case_id === t.case_id);
  if (!c) return "case_not_declared";
  if (t.case_version !== c.case_version) return "case_version_mismatch";
  if (t.input_hash !== c.input_hash) return "input_mismatch";
  if (t.scorer_version !== c.scorer_version) return "scorer_mismatch";
  if (t.requested_model !== m.requested_model) return "model_mismatch";
  if (m.observed_identity.status === "observed" && t.observed_model !== m.observed_identity.model) return "observed_model_mismatch";
  if (t.configuration_hash !== m.configuration_hash) return "config_mismatch";
  if (t.revision !== (t.arm === "baseline" ? m.pairing.baseline_revision : m.pairing.candidate_revision)) return "arm_revision_mismatch";
  return null;
}
const INCOMPATIBLE = new Set(["case_not_declared", "case_version_mismatch", "input_mismatch", "scorer_mismatch", "model_mismatch", "observed_model_mismatch", "config_mismatch", "arm_revision_mismatch", "pair_case_mismatch", "seed_mismatch"]);

/** The billable set by cost basis, summed in a fixed order; requests the manifest declares but no trial reports are unobserved. */
function billedSpend(e: LedgerEntry): Pick<PairedEvaluation["operational"], "billable_requests" | "unobserved_requests" | "spend_basis" | "spend_by_basis" | "known_spend_usd" | "exact_spend_usd"> {
  const by = { measured: [] as number[], derived_estimate: [] as number[] };
  let unknown = 0;
  for (const k of [...e.billable.keys()].sort()) {
    const u = e.billable.get(k)!.usage;
    if (u.cost_usd === null || u.cost_basis === "unavailable") unknown++;
    else by[u.cost_basis].push(u.cost_usd);
  }
  const observed = new Set([...e.billable.values()].map((b) => b.usage.accounting_identity));
  const unobserved = e.manifest.accounting_identities.filter((x) => !observed.has(x)).length;
  const spend_by_basis = { measured: fsum(by.measured), derived_estimate: fsum(by.derived_estimate) };
  const spend_basis: SpendBasis = by.measured.length && by.derived_estimate.length ? "mixed" : by.measured.length ? "measured" : by.derived_estimate.length ? "derived_estimate" : "unavailable";
  const known = spend_basis === "mixed" ? null : spend_by_basis.measured + spend_by_basis.derived_estimate;
  return {
    billable_requests: e.billable.size, unobserved_requests: unobserved, spend_basis, spend_by_basis,
    known_spend_usd: known, exact_spend_usd: unknown || unobserved || known === null ? null : known,
  };
}

export function pairedEvaluation(e: LedgerEntry, policy: PairedPolicy = DEFAULT_PAIRED_POLICY): PairedEvaluation {
  if (!Number.isInteger(policy.min_samples) || policy.min_samples < 2) throw new EvaluationRefusal("invalid_manifest", "a paired policy needs a declared minimum of at least 2 samples");
  const m = e.manifest;
  const s = slots(e);
  const exclusions: Record<string, number> = {};
  const excl = (code: string) => { exclusions[code] = (exclusions[code] ?? 0) + 1; };
  const samples: PairedSample[] = [];
  const bases = new Set<TrialUsage["cost_basis"] | "mixed" | null>();
  const arms = { baseline: [] as number[], candidate: [] as number[] };
  let incomplete = 0, unverifiedModel = 0;
  for (const pair_id of [...m.pairing.pair_ids].sort()) for (let rep = 1; rep <= m.pairing.repetition_count; rep++) {
    const b = s.get(slotKey({ pair_id, arm: "baseline", repetition: rep }))!.final;
    const c = s.get(slotKey({ pair_id, arm: "candidate", repetition: rep }))!.final;
    if (b && conditionMismatch(m, b) === null) arms.baseline.push(b.score!);
    if (c && conditionMismatch(m, c) === null) arms.candidate.push(c.score!);
    if (!b || !c) { incomplete++; continue; }
    // With no observed model on the manifest, both arms must still report the same model.
    const modelSplit = m.observed_identity.status !== "observed" && b.observed_model !== c.observed_model;
    const why = conditionMismatch(m, b) ?? conditionMismatch(m, c) ?? (b.case_id !== c.case_id ? "pair_case_mismatch" : b.seed !== c.seed ? "seed_mismatch" : modelSplit ? "observed_model_mismatch" : null);
    if (why) { excl(why); continue; }
    if (m.observed_identity.status !== "observed" && b.observed_model === null) unverifiedModel++;
    const cb = costOf(b), cc = costOf(c);
    bases.add(cb.basis).add(cc.basis);
    const kase = m.cases.find((x) => x.case_id === b.case_id)!;
    samples.push({
      pair_id, repetition: rep, case_id: b.case_id, difficulty: kase.difficulty, scorer_version: kase.scorer_version,
      baseline_score: b.score!, candidate_score: c.score!, score_delta: c.score! - b.score!,
      cost_delta_usd: cb.usd !== null && cc.usd !== null && cb.basis === cc.basis ? cc.usd - cb.usd : null,
      latency_delta_ms: b.latency_ms !== null && c.latency_ms !== null ? c.latency_ms - b.latency_ms : null,
      evidence: [b.evidence, c.evidence],
    });
  }
  const expected = m.pairing.pair_ids.length * m.pairing.repetition_count;
  const coverage = makeCoverage(samples.length + incomplete, samples.length, exclusions, incomplete ? `${incomplete} pair repetitions are not complete on both arms` : "no complete pair");
  const refusal_reasons: string[] = [];
  const incompatible = Object.entries(exclusions).filter(([k]) => INCOMPATIBLE.has(k));
  if (samples.length === 0 && incompatible.length) refusal_reasons.push(`no pair runs under the declared conditions: ${incompatible.map(([k, n]) => `${k} x${n}`).join(", ")}`);
  if (new Set(samples.map((x) => x.scorer_version)).size > 1) refusal_reasons.push("samples span several scorer versions; scores on different scales are not pooled");
  const compatibility = refusal_reasons.length ? "refused" : "compatible";
  const score = pairedStatistic(compatibility === "compatible" ? samples.map((x) => x.score_delta) : []);
  const mean = (xs: number[]) => (xs.length ? fsum(xs) / xs.length : null);
  const candidate_mean = compatibility === "compatible" ? mean(arms.candidate) : null;
  const baseline_mean = compatibility === "compatible" ? mean(arms.baseline) : null;
  const floor = m.pairing.quality_floor;
  // The floor holds over the whole candidate arm; with candidate slots missing or excluded it is unknown.
  const armComplete = arms.candidate.length === expected;
  const floor_met = floor === null || candidate_mean === null || !armComplete ? null : candidate_mean >= floor;
  bases.delete(null);
  const cost_basis: SpendBasis = bases.size === 0 ? "unavailable" : bases.size === 1 ? (bases.values().next().value as SpendBasis) : "mixed";
  // Measured billing and estimates are not pooled into one cost statistic.
  const costs = samples.filter((x) => x.cost_delta_usd !== null).map((x) => x.cost_delta_usd!);
  const costStat = cost_basis === "mixed" ? { ...pairedStatistic([]), reason: "paired costs mix measured billing and estimates" } : pairedStatistic(costs);
  // The label is decided by quality alone; operational deltas are reported beside it.
  let label: PairedLabel, label_reason: string;
  if (compatibility === "refused") { label = "refused"; label_reason = refusal_reasons.join("; "); }
  else if (floor === null) { label = "descriptive_only"; label_reason = "no quality floor declared; a paired delta without one is descriptive"; }
  else if (floor_met === false) { label = "regression"; label_reason = `candidate mean score ${candidate_mean} is below the quality floor ${floor}`; }
  else if (floor_met === null) { label = "descriptive_only"; label_reason = `candidate arm has ${arms.candidate.length} of ${expected} compatible completed trials; the quality floor is unknown`; }
  else if (score.n < policy.min_samples) { label = "descriptive_only"; label_reason = `${score.n} paired samples, below the declared minimum ${policy.min_samples}`; }
  else if (coverage.state !== "complete") { label = "descriptive_only"; label_reason = `paired coverage is ${coverage.state}: ${coverage.reason}`; }
  else if (m.coverage.state !== "complete") { label = "descriptive_only"; label_reason = `the evaluation receipt discloses ${m.coverage.state} coverage: ${m.coverage.reason}`; }
  else if (coverage.excluded > 0) { label = "descriptive_only"; label_reason = `${coverage.excluded} pair repetitions are excluded; excluded pairs could hold the losses`; }
  else if (unverifiedModel > 0) { label = "descriptive_only"; label_reason = `${unverifiedModel} paired samples have no observed model on either arm; model compatibility is unverified`; }
  else if (score.ci95 && score.ci95[0] > 0) { label = "improvement"; label_reason = "95% interval of the paired score delta is above zero and the quality floor holds"; }
  else if (score.ci95 && score.ci95[1] < 0) { label = "regression"; label_reason = "95% interval of the paired score delta is below zero"; }
  else { label = "no_detectable_difference"; label_reason = "95% interval of the paired score delta includes zero"; }
  const applied: PairedEvaluation["applied"] = m.applied_revision === null
    ? { applied_revision: null, state: "not_applied", reason: null }
    : m.applied_revision === m.pairing.candidate_revision
      ? { applied_revision: m.applied_revision, state: "joined", reason: null }
      : { applied_revision: m.applied_revision, state: "refused", reason: "applied revision is not the evaluated candidate revision" };
  const body: Omit<PairedEvaluation, "result_hash"> = {
    schema_version: PAIRED_EVALUATION_SCHEMA, formula_version: PAIRED_FORMULA_VERSION,
    evaluation: m.evaluation, revisions: e.revisions,
    conditions: { configuration_hash: m.configuration_hash, requested_model: m.requested_model, observed_model: m.observed_identity.status === "observed" ? m.observed_identity.model : null, seed_policy: m.pairing.seed_policy, repetition_count: m.pairing.repetition_count, baseline_revision: m.pairing.baseline_revision, candidate_revision: m.pairing.candidate_revision, cases: [...m.cases].sort((a, b) => (a.case_id < b.case_id ? -1 : 1)) },
    policy: { ...policy },
    compatibility, refusal_reasons,
    sample: { expected, n: samples.length, pairs: new Set(samples.map((x) => x.pair_id)).size, coverage },
    quality: { score_delta: score, baseline_mean, candidate_mean, candidate_arm: { completed: arms.candidate.length, expected }, quality_floor: floor, floor_met },
    operational: {
      cost_delta_usd: costStat, cost_basis, latency_delta_ms: pairedStatistic(samples.filter((x) => x.latency_delta_ms !== null).map((x) => x.latency_delta_ms!)),
      ...billedSpend(e),
    },
    label, label_reason, applied, recovery: evaluationRecovery(e), samples,
  };
  return { ...body, result_hash: sha256(canonicalJson(body)) };
}

// ── Unpaired before/after ────────────────────────────────────────────────────

export interface UnpairedComparison {
  label: "descriptive_only" | "refused"; reasons: string[];
  baseline: { evaluation: Entity; mean_score: number | null; n: number };
  candidate: { evaluation: Entity; mean_score: number | null; n: number };
}
/** Two separate evaluations (before/after): never an improvement claim; incompatible conditions refuse. */
export function compareUnpaired(before: LedgerEntry, after: LedgerEntry): UnpairedComparison {
  const reasons: string[] = [];
  const a = before.manifest, b = after.manifest;
  const cases = (m: EvaluationManifestV2) => canonicalJson([...m.cases].map((c) => [c.case_id, c.case_version, c.scorer_version, c.input_hash]).sort());
  if (cases(a) !== cases(b)) reasons.push("case, scorer or input versions differ");
  if (a.requested_model !== b.requested_model || canonicalJson(a.observed_identity) !== canonicalJson(b.observed_identity)) reasons.push("model differs");
  if (a.configuration_hash !== b.configuration_hash) reasons.push("configuration differs");
  const scores = (e: LedgerEntry) => [...e.attempts.values()].filter((t) => t.status === "completed" && conditionMismatch(e.manifest, t) === null).map((t) => t.score!);
  const side = (e: LedgerEntry) => { const xs = scores(e); return { evaluation: e.manifest.evaluation, mean_score: xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null, n: xs.length }; };
  return { label: reasons.length ? "refused" : "descriptive_only", reasons: reasons.length ? reasons : ["unpaired before/after evaluations are descriptive; no causal improvement is claimed"], baseline: side(before), candidate: side(after) };
}

// ── Applied revision join ────────────────────────────────────────────────────

export interface PostApplyOutcome { outcome_id: string; applied_revision: string; observed_at: string; evidence: Evidence }
export interface AppliedJoin { evaluation: Entity; applied_revision: string; outcome: PostApplyOutcome; evaluation_label: PairedLabel; result_hash: string }
/** A post-apply outcome joins an evaluation only through the exact applied hash the evaluation recorded. */
export function joinAppliedOutcome(r: PairedEvaluation, o: PostApplyOutcome): AppliedJoin {
  if (r.applied.state !== "joined") throw new EvaluationRefusal("applied_revision_mismatch", r.applied.state === "not_applied" ? "the evaluation records no applied revision" : r.applied.reason ?? "applied revision refused");
  if (o.applied_revision !== r.applied.applied_revision) throw new EvaluationRefusal("applied_revision_mismatch", `outcome ${o.outcome_id} names applied revision ${o.applied_revision}, not ${r.applied.applied_revision}`);
  return { evaluation: r.evaluation, applied_revision: o.applied_revision, outcome: o, evaluation_label: r.label, result_hash: r.result_hash };
}

// ── Operational spend join ───────────────────────────────────────────────────

export interface EvaluationSpend {
  schema_version: typeof EVALUATION_SPEND_SCHEMA; evaluation: Entity;
  /** Billable requests known so far; the total is exact only when coverage is complete. */
  requests: number; from_evaluation_only: number; from_runs_only: number; shared: number;
  /** Requests the manifest declares that no trial reports: they exist, their cost is unknown. */
  unobserved: number;
  basis: SpendBasis; by_basis: { measured: number; derived_estimate: number };
  /** Null when bases are mixed: measured billing and estimates are not added. */
  known_usd: number | null; exact_usd: number | null; coverage: Coverage;
  lines: { source_id: string; accounting_identity: string; usd: number | null; basis: "measured" | "derived_estimate" | "unavailable"; origin: "evaluation" | "run" | "both" }[];
}
type SpendLine = EvaluationSpend["lines"][number];
/**
 * Benchmark usage and the usage of its linked operational runs, billed once per
 * source-qualified accounting identity (the source of the run that made the request).
 * A request both record is one request; a known cost keeps its basis.
 */
export function evaluationSpend(e: LedgerEntry, runs: readonly RunFacts[], unresolved: readonly string[] = []): EvaluationSpend {
  const m = e.manifest;
  const linked = new Set(m.linked_runs.map((r) => `${r.source_id}\u0000${r.id}`));
  // A linked run the caller did not supply is a run whose requests are unknown.
  const supplied = new Set(runs.map((r) => `${r.source_id}\u0000${r.run_id}`));
  unresolved = [...new Set([...unresolved, ...m.linked_runs.filter((r) => !supplied.has(`${r.source_id}\u0000${r.id}`)).map((r) => `${r.source_id}:${r.id}`)])].sort();
  const lines = new Map<string, SpendLine>();
  const unknownRuns: string[] = [];
  for (const [k, { usage, source_id }] of e.billable) lines.set(k, { source_id, accounting_identity: usage.accounting_identity, usd: usage.cost_usd, basis: usage.cost_usd === null ? "unavailable" : usage.cost_basis, origin: "evaluation" });
  for (const r of runs) {
    if (!linked.has(`${r.source_id}\u0000${r.run_id}`)) throw new EvaluationRefusal("unlinked_run", `run ${r.source_id}:${r.run_id} is not linked by evaluation ${e.key}`);
    // A supplied run without a complete request enumeration is still a run whose requests are unknown.
    if (r.usage_state !== "available" || r.extra_missing !== 0) unknownRuns.push(`${r.source_id}:${r.run_id}`);
    for (const l of r.leaves) {
      const k = `${r.source_id}\u0000${l.accounting_identity}`;
      const label = `${r.source_id}:${l.accounting_identity}`;
      const usd = l.measured_usd ?? l.derived_usd ?? null;
      const basis = l.measured_usd !== null && l.measured_usd !== undefined ? "measured" as const : usd !== null ? "derived_estimate" as const : "unavailable" as const;
      const prev = lines.get(k);
      if (!prev) { lines.set(k, { source_id: r.source_id, accounting_identity: l.accounting_identity, usd, basis, origin: "run" }); continue; }
      if (prev.origin !== "evaluation") throw new EvaluationRefusal("accounting_conflict", `run leaves bill ${label} twice`);
      if (prev.usd !== null && usd !== null && (prev.usd !== usd || prev.basis !== basis)) throw new EvaluationRefusal("accounting_conflict", `${label} is billed ${prev.usd} (${prev.basis}) by the evaluation and ${usd} (${basis}) by its run`);
      lines.set(k, prev.usd !== null ? { ...prev, origin: "both" } : { ...prev, usd, basis, origin: "both" });
    }
  }
  const out = [...lines.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  unresolved = [...new Set([...unresolved, ...unknownRuns])].sort();
  // A declared request the trials do not report is still observed when a linked run recorded it.
  const seen = new Set([...[...e.billable.values()].map((b) => b.usage.accounting_identity), ...runs.flatMap((r) => r.leaves.map((l) => l.accounting_identity))]);
  const unobserved = m.accounting_identities.filter((x) => !seen.has(x)).length;
  const covered = out.filter((x) => x.usd !== null);
  const by_basis = { measured: fsum(covered.filter((x) => x.basis === "measured").map((x) => x.usd!)), derived_estimate: fsum(covered.filter((x) => x.basis === "derived_estimate").map((x) => x.usd!)) };
  const has = (b: string) => covered.some((x) => x.basis === b);
  const basis: SpendBasis = has("measured") && has("derived_estimate") ? "mixed" : has("measured") ? "measured" : has("derived_estimate") ? "derived_estimate" : "unavailable";
  const known = basis === "mixed" ? null : by_basis.measured + by_basis.derived_estimate;
  // A linked run whose requests are unknown leaves the billable set itself unknown.
  const reasons = [unresolved.length ? `linked runs with unknown requests: ${unresolved.slice(0, 20).join(", ")}` : null, unobserved ? `${unobserved} declared requests have no observation` : null, covered.length < out.length ? "some billable requests report no cost" : null].filter(Boolean).join("; ");
  const coverage = makeCoverage(unresolved.length ? null : out.length + unobserved, covered.length, {}, reasons || "spend incomplete");
  return {
    schema_version: EVALUATION_SPEND_SCHEMA, evaluation: m.evaluation, requests: out.length,
    from_evaluation_only: out.filter((x) => x.origin === "evaluation").length, from_runs_only: out.filter((x) => x.origin === "run").length, shared: out.filter((x) => x.origin === "both").length,
    unobserved, basis, by_basis, known_usd: known, exact_usd: coverage.state === "complete" && known !== null ? known : null, coverage, lines: out,
  };
}
/** A spend document bills each request once; a repeated key is double counting. */
export function validateEvaluationSpend(s: { lines: { source_id: string; accounting_identity: string; usd: number | null }[]; requests: number; known_usd: number | null }): Verdict {
  const errors: string[] = [];
  const keys = s.lines.map((x) => `${x.source_id}\u0000${x.accounting_identity}`);
  if (new Set(keys).size !== keys.length) errors.push("a billable request is counted twice");
  if (s.requests !== keys.length) errors.push("request count differs from the billable lines");
  if (s.known_usd !== null && Math.abs(fsum(s.lines.map((x) => x.usd ?? 0)) - s.known_usd) > 1e-9) errors.push("known spend differs from the billable lines");
  return verdict(errors);
}

// ── C9 facts ─────────────────────────────────────────────────────────────────

/** The M28 facts the C9 engine computes series from: one per evaluation, already paired. */
export function evaluationFact(e: LedgerEntry, r: PairedEvaluation): EvaluationFact {
  const scores = [...e.attempts.values()].filter((t) => t.status === "completed")
    // Attributed to the declared arm, so a record carrying the wrong revision cannot fill the other arm's slots.
    .map((t) => ({ case_id: t.case_id, pair_id: t.pair_id, scorer_version: t.scorer_version, arm: t.arm, revision: t.arm === "baseline" ? e.manifest.pairing.baseline_revision : e.manifest.pairing.candidate_revision, score: t.score!, compatible: conditionMismatch(e.manifest, t) === null, evidence: t.evidence }))
    .sort((a, b) => (a.evidence.path + a.pair_id < b.evidence.path + b.pair_id ? -1 : 1));
  return {
    source_id: e.manifest.evaluation.source_id, evaluation_id: e.manifest.evaluation.id,
    applied_revision: r.applied.state === "joined" ? r.applied.applied_revision : null,
    arm_revisions: { baseline: e.manifest.pairing.baseline_revision, candidate: e.manifest.pairing.candidate_revision },
    compatibility: r.compatibility, refusal_reasons: r.refusal_reasons,
    expected_samples: r.sample.expected,
    incomplete_samples: r.sample.coverage.missing ?? 0,
    exclusions: Object.fromEntries(r.sample.coverage.exclusion_reasons.map((x) => [x.code, x.count])),
    samples: r.samples.map((x) => ({ case_id: x.case_id, pair_id: x.pair_id, scorer_version: x.scorer_version, score_delta: x.score_delta, cost_delta_usd: x.cost_delta_usd, latency_delta_ms: x.latency_delta_ms, evidence: x.evidence[1] })),
    cost_basis: r.operational.cost_basis,
    scores,
    evidence: e.manifest.receipt,
  };
}

export const isContractId = (s: string) => TRACE_ID_RE.test(s);
