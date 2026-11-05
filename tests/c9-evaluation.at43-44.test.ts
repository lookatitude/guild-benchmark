/**
 * B01 · P08/P10 evaluation and benchmark lineage.
 *   AT43 paired evaluation · AT44 engine import/recovery.
 *
 * Engine tests run on in-memory manifests and trials; the project read and server
 * tests write real `.guild/artifacts/generated/benchmarks/<id>/` homes and runs.
 * With the frozen contracts checkout present (A02_CONTRACT_ROOT, or
 * <umbrella>/contracts/guild-stack/v2) the manifest validator is checked against
 * verify_contracts.py; B01_REQUIRE_A02=1 makes the checkout mandatory.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EvaluationLedger,
  EvaluationRefusal,
  compareUnpaired,
  evaluationSpend,
  joinAppliedOutcome,
  pairedEvaluation,
  pairedStatistic,
  tQuantile975,
  validateEvaluationManifestV2,
  validateEvaluationSpend,
  type EvaluationManifestV2,
  type TrialRecord,
} from "../src/c9/evaluation.js";
import { validateMetricSeriesV2, type MetricSeriesV2, type QueryIdentity, type RefusalV2, type RunFacts } from "../src/c9/metric-series.js";
import { evaluationReport, openProjectSnapshot, projectQuery, readMetricSeries, readRequest, type ProjectSnapshot } from "../src/c9/project-read.js";
import type { TraceAnalysisV3, TraceCoverage, TraceUsage } from "../src/c9/trace-analysis.js";
import { createApp } from "../src/server.js";
import { canonicalSourceId } from "../src/c9/source-identity.js";

const BENCH_ROOT = fileURLToPath(new URL("..", import.meta.url));
function umbrellaRoots(): string[] {
  const out = [path.resolve(BENCH_ROOT, "..")];
  try {
    const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(BENCH_ROOT, ".git"), "utf8"));
    if (m) out.push(path.resolve(m[1]!.trim(), "../../../.."));
  } catch { /* a plain checkout has a .git directory */ }
  return out;
}
const A02_ROOT = process.env["A02_CONTRACT_ROOT"]
  ?? umbrellaRoots().map((u) => path.join(u, "contracts", "guild-stack", "v2")).find((p) => fs.existsSync(path.join(p, "fixtures", "examples.json")))
  ?? path.resolve(BENCH_ROOT, "../contracts/guild-stack/v2");
const A02_PRESENT = fs.existsSync(path.join(A02_ROOT, "fixtures", "examples.json"));
const REQUIRE = process.env["B01_REQUIRE_A02"] === "1";

const h = (c: string) => `sha256:${c.repeat(64)}`;
const H = h("a");
const BASE = h("b");
const CAND = h("c");
const CONFIG = h("d");
const AS_OF = "2026-10-26T01:00:00Z";
const ev = (source: string, p: string, at = "2026-10-26T00:00:00Z") => ({ source_id: source, path: p, sha256: H, schema_version: "guild.evidence.v1", observed_at: at, availability: "available" as const, reason: null });

function manifest(source = "source-a", o: Partial<EvaluationManifestV2> & { pairs?: number; reps?: number; floor?: number | null; id?: string } = {}): EvaluationManifestV2 {
  const id = o.id ?? "eval-1";
  const pairs = o.pairs ?? 4;
  const m: EvaluationManifestV2 = {
    schema_version: "guild.stack.evaluation-manifest.v2",
    evaluation: { source_id: source, kind: "evaluation", id, revision: H },
    cases: [1, 2].map((n) => ({ case_id: `case-${n}`, case_version: "1", scorer_version: "rubric.1", input_hash: h(String(n)), difficulty: n === 1 ? "easy" : "hard" })),
    pairing: { baseline_revision: BASE, candidate_revision: CAND, pair_ids: Array.from({ length: pairs }, (_, i) => `pair-${i + 1}`), seed_policy: "fixed seed per pair repetition", repetition_count: o.reps ?? 2, quality_floor: o.floor === undefined ? 0.6 : o.floor },
    configuration_hash: CONFIG, requested_model: "requested-model",
    observed_identity: { provider: "provider", model: "observed-model", status: "observed", reason: null },
    applied_revision: null,
    linked_runs: [{ source_id: source, kind: "run", id: "run-1", revision: H }],
    accounting_identities: [],
    query: {
      schema_version: "guild.stack.metric-series.v2",
      versions: { schema: "v2", analyzer: "a1", normalizer: "n1", formula: "proposed:m28.paired_score_delta.1", usage_semantics: "not_applicable", pricing: "p1", aggregation: "g1" },
      snapshot: { input_manifest_digest: H, source_ids: [source], source_generations: [{ source_id: source, generation: H }], as_of: "2026-10-26T00:00:20Z" },
      grain: "evaluation", filters: [],
      window: { from: "2026-10-26T00:00:00Z", to: "2026-10-26T00:00:20Z", basis: "as_of_snapshot", timezone: "UTC" },
      cohort_hash: H, underlying_scalar: null,
    } as QueryIdentity,
    budget: { mode: "native_spend_threshold", threshold_usd: 1, duration_limit_ms: 60000, overshoot_possible: true, qualification: ev(source, "runs/run-1/evidence.json"), policy_hash: H },
    coverage: { eligible: 1, covered: 1, excluded: 0, missing: 0, state: "complete", reason: null, exclusion_reasons: [] },
    artifacts: [ev(source, `artifacts/generated/benchmarks/${id}/results.json`)],
    receipt: ev(source, `artifacts/generated/benchmarks/${id}/receipt.json`),
    ...o,
  };
  delete (m as any).pairs; delete (m as any).reps; delete (m as any).floor; delete (m as any).id;
  return m;
}

type TrialOpts = Partial<TrialRecord> & { cost?: number | null; reqs?: string[] };
function trial(m: EvaluationManifestV2, pair: number, arm: "baseline" | "candidate", rep: number, o: TrialOpts = {}): TrialRecord {
  const attempt = o.attempt_id ?? `${arm[0]}-p${pair}-r${rep}`;
  const reqs = o.reqs ?? [`req-${attempt}`];
  const cost = o.cost === undefined ? (arm === "baseline" ? 0.5 : 0.25) : o.cost;
  const caseN = pair % 2 === 1 ? 1 : 2;
  const t: TrialRecord = {
    schema_version: "guild.benchmark.evaluation-trial.v1", evaluation: { source_id: m.evaluation.source_id, id: m.evaluation.id },
    attempt_id: attempt, rerun_of: null, pair_id: `pair-${pair}`, case_id: `case-${caseN}`, arm, repetition: rep, seed: `seed-${pair}-${rep}`,
    revision: arm === "baseline" ? BASE : CAND, case_version: "1", scorer_version: "rubric.1", input_hash: h(String(caseN)),
    requested_model: "requested-model", configuration_hash: CONFIG, observed_model: "observed-model",
    status: "completed", score: arm === "baseline" ? 0.5 : 0.75, latency_ms: arm === "baseline" ? 1000 : 800,
    usage: reqs.map((r) => ({ accounting_identity: r, cost_usd: cost === null ? null : cost / reqs.length, cost_basis: cost === null ? "unavailable" as const : "measured" as const, tokens: 100 })),
    run: { source_id: m.evaluation.source_id, id: "run-1" },
    evidence: ev(m.evaluation.source_id, `artifacts/generated/benchmarks/${m.evaluation.id}/trials.jsonl`),
  };
  const { cost: _c, reqs: _r, ...rest } = o;
  return { ...t, ...rest };
}
/** Every slot completed; candidate deltas [0.25, 0.25, 0.5, 0.25, ...] unless `score` overrides. */
function fullTrials(m: EvaluationManifestV2, cand: (pair: number, rep: number) => TrialOpts = () => ({})): TrialRecord[] {
  const out: TrialRecord[] = [];
  for (let p = 1; p <= m.pairing.pair_ids.length; p++) for (let r = 1; r <= m.pairing.repetition_count; r++) {
    out.push(trial(m, p, "baseline", r));
    out.push(trial(m, p, "candidate", r, { score: p === 2 ? 1 : 0.75, ...cand(p, r) }));
  }
  return out;
}
const declare = (m: EvaluationManifestV2, ts: TrialRecord[]) => ({ ...m, accounting_identities: [...new Set(ts.flatMap((t) => t.usage.map((u) => u.accounting_identity)))].sort() });
function imported(m: EvaluationManifestV2, ts: TrialRecord[]) {
  const md = declare(m, ts);
  const l = new EvaluationLedger();
  l.import(md, ts);
  return { ledger: l, entry: l.entries.get(`${md.evaluation.source_id}:${md.evaluation.id}`)!, manifest: md };
}
const shuffle = <T>(xs: T[]) => [...xs].reverse().sort((a, b) => (JSON.stringify(a).length % 3) - (JSON.stringify(b).length % 3));

// ── AT43 · paired evaluation ─────────────────────────────────────────────────

describe("AT43 · paired evaluation", () => {
  it("persists n, pairs, exclusions, variance and quality floor; a compatible paired delta is an improvement", () => {
    const { entry } = imported(manifest(), fullTrials(manifest()));
    const r = pairedEvaluation(entry);
    const deltas = [0.25, 0.25, 0.5, 0.5, 0.25, 0.25, 0.25, 0.25];
    const mean = deltas.reduce((a, x) => a + x, 0) / 8;
    const variance = deltas.reduce((a, x) => a + (x - mean) ** 2, 0) / 7;
    expect(r.compatibility).toBe("compatible");
    expect(r.sample).toMatchObject({ expected: 8, n: 8, pairs: 4 });
    expect(r.sample.coverage).toMatchObject({ state: "complete", excluded: 0, missing: 0 });
    expect(r.quality.score_delta.n).toBe(8);
    expect(r.quality.score_delta.mean).toBeCloseTo(mean, 12);
    expect(r.quality.score_delta.variance).toBeCloseTo(variance, 12);
    expect(r.quality.score_delta.std_error).toBeCloseTo(Math.sqrt(variance / 8), 12);
    // t(0.975, df=7) = 2.365
    expect(r.quality.score_delta.ci95![0]).toBeCloseTo(mean - 2.365 * Math.sqrt(variance / 8), 12);
    expect(r.quality).toMatchObject({ quality_floor: 0.6, floor_met: true, baseline_mean: 0.5 });
    expect(r.label).toBe("improvement");
    // Operational efficiency is reported beside quality, never inside the label.
    expect(r.operational.cost_delta_usd.mean).toBeCloseTo(-0.25, 12);
    expect(r.operational.latency_delta_ms.mean).toBe(-200);
    expect(r.operational).toMatchObject({ cost_basis: "measured", billable_requests: 16 });
    expect(r.operational.exact_spend_usd).toBeCloseTo(8 * 0.5 + 8 * 0.25, 12);
  });

  it("compatible paired deltas are reproducible: same inputs in any order give the same result hash", () => {
    const ts = fullTrials(manifest());
    const a = pairedEvaluation(imported(manifest(), ts).entry);
    const b = pairedEvaluation(imported(manifest(), shuffle(ts)).entry);
    expect(b.result_hash).toBe(a.result_hash);
    expect(b).toEqual(a);
    // and the hash moves when one score moves
    const c = pairedEvaluation(imported(manifest(), fullTrials(manifest(), (p, r) => (p === 1 && r === 1 ? { score: 0.875 } : {}))).entry);
    expect(c.result_hash).not.toBe(a.result_hash);
  });

  it("an out-of-condition trial is excluded with its reason; the remaining pairs stay compatible", () => {
    const ts = fullTrials(manifest(), (p) => (p === 4 ? { configuration_hash: h("e") } : {}));
    const r = pairedEvaluation(imported(manifest(), ts).entry);
    expect(r.compatibility).toBe("compatible");
    expect(r.sample.n).toBe(6);
    expect(r.sample.coverage.exclusion_reasons).toEqual([{ code: "config_mismatch", count: 2 }]);
    expect(r.samples.some((x) => x.pair_id === "pair-4")).toBe(false);
  });

  it("post-apply outcome joins only through the applied hash", () => {
    const applied = manifest("source-a", { applied_revision: CAND });
    const r = pairedEvaluation(imported(applied, fullTrials(applied)).entry);
    expect(r.applied).toEqual({ applied_revision: CAND, state: "joined", reason: null });
    const outcome = { outcome_id: "outcome-1", applied_revision: CAND, observed_at: "2026-10-27T00:00:00Z", evidence: ev("source-a", "runs/run-9/outcome.json") };
    const j = joinAppliedOutcome(r, outcome);
    expect(j).toMatchObject({ applied_revision: CAND, evaluation_label: "improvement", result_hash: r.result_hash, evaluation: applied.evaluation });
    // negative controls
    expect(() => joinAppliedOutcome(r, { ...outcome, applied_revision: h("f") })).toThrow(/applied revision/);
    const notApplied = pairedEvaluation(imported(manifest(), fullTrials(manifest())).entry);
    expect(() => joinAppliedOutcome(notApplied, outcome)).toThrow(/no applied revision/);
    const wrong = manifest("source-a", { applied_revision: h("f") });
    const w = pairedEvaluation(imported(wrong, fullTrials(wrong)).entry);
    expect(w.applied.state).toBe("refused");
    expect(() => joinAppliedOutcome(w, { ...outcome, applied_revision: h("f") })).toThrow(EvaluationRefusal);
  });

  describe("negative controls: no improvement label", () => {
    const refusedWith = (o: TrialOpts) => pairedEvaluation(imported(manifest(), fullTrials(manifest(), () => o)).entry);
    it.each([
      ["different requested model", { requested_model: "other-model" }, "model_mismatch"],
      ["different observed model", { observed_model: "other-observed" }, "observed_model_mismatch"],
      ["different configuration", { configuration_hash: h("e") }, "config_mismatch"],
      ["different case version", { case_version: "2" }, "case_version_mismatch"],
      ["different scorer", { scorer_version: "rubric.2" }, "scorer_mismatch"],
      ["different case input", { input_hash: h("9") }, "input_mismatch"],
      ["different seed", { seed: "other-seed" }, "seed_mismatch"],
    ])("%s refuses", (_n, o, code) => {
      const r = refusedWith(o as TrialOpts);
      expect(r.compatibility).toBe("refused");
      expect(r.label).toBe("refused");
      expect(r.refusal_reasons.join(" ")).toContain(code);
      expect(r.quality.score_delta.mean).toBeNull();
    });

    it("a cheaper candidate of lower quality is a regression, with its cost saving reported apart", () => {
      const r = pairedEvaluation(imported(manifest(), fullTrials(manifest(), () => ({ score: 0.375, cost: 0.05 }))).entry);
      expect(r.operational.cost_delta_usd.mean).toBeCloseTo(-0.45, 12);
      expect(r.quality.score_delta.mean).toBeCloseTo(-0.125, 12);
      expect(r.quality.floor_met).toBe(false);
      expect(r.label).toBe("regression");
    });

    it("a cheaper candidate of lower quality above the floor is still a regression", () => {
      const m = manifest("source-a", { floor: 0.3 });
      const r = pairedEvaluation(imported(m, fullTrials(m, (p) => ({ score: p % 2 ? 0.375 : 0.25, cost: 0.05 }))).entry);
      expect(r.quality.floor_met).toBe(true);
      expect(r.operational.cost_delta_usd.ci95![1]).toBeLessThan(0);
      expect(r.quality.score_delta.ci95![1]).toBeLessThan(0);
      expect(r.label).toBe("regression");
    });

    it("a higher-scoring candidate below the quality floor is not an improvement", () => {
      const m = manifest("source-a", { floor: 0.9 });
      const r = pairedEvaluation(imported(m, fullTrials(m)).entry);
      expect(r.quality.score_delta.ci95![0]).toBeGreaterThan(0);
      expect(r.label).toBe("regression");
      expect(r.label_reason).toMatch(/quality floor/);
    });

    it("no declared quality floor or too few pairs is descriptive only", () => {
      const nf = manifest("source-a", { floor: null });
      expect(pairedEvaluation(imported(nf, fullTrials(nf)).entry).label).toBe("descriptive_only");
      const small = manifest("source-a", { pairs: 1, reps: 2 });
      const r = pairedEvaluation(imported(small, fullTrials(small)).entry);
      expect(r.sample.n).toBe(2);
      expect(r.label).toBe("descriptive_only");
      expect(pairedEvaluation(imported(small, fullTrials(small)).entry, { min_samples: 2 }).label).not.toBe("descriptive_only");
    });

    it("before/after evaluations without pairs are descriptive, and incompatible ones refuse", () => {
      const before = imported(manifest("source-a", { id: "eval-before" }), fullTrials(manifest("source-a", { id: "eval-before" }))).entry;
      const after = imported(manifest("source-a", { id: "eval-after" }), fullTrials(manifest("source-a", { id: "eval-after" }))).entry;
      expect(compareUnpaired(before, after).label).toBe("descriptive_only");
      const otherModel = manifest("source-a", { id: "eval-other", requested_model: "other-model" });
      const other = imported(otherModel, fullTrials(otherModel, () => ({ requested_model: "other-model" }))).entry;
      const c = compareUnpaired(before, other);
      expect(c.label).toBe("refused");
      expect(c.reasons).toContain("model differs");
      const otherConfig = manifest("source-a", { id: "eval-config", configuration_hash: h("e") });
      expect(compareUnpaired(before, imported(otherConfig, fullTrials(otherConfig)).entry).reasons).toContain("configuration differs");
    });

    it("the same revision on both arms is not a comparison", () => {
      const m = manifest();
      m.pairing.candidate_revision = BASE;
      expect(() => new EvaluationLedger().import(m, [])).toThrow(/same/);
    });
  });

  it("the manifest validator agrees with the frozen C10 contract", () => {
    if (!A02_PRESENT) { expect(REQUIRE).toBe(false); return; }
    const example = JSON.parse(fs.readFileSync(path.join(A02_ROOT, "fixtures", "examples.json"), "utf8"))["evaluation-manifest"];
    const mutations: Array<[string, (m: any) => void, string]> = [
      ["kind", (m) => { m.evaluation.kind = "run"; }, "evaluation kind mismatch"],
      ["artifact home", (m) => { m.artifacts[0].path = "artifacts/reports/x.json"; }, "evaluation artifact owner/home mismatch"],
      ["receipt missing", (m) => { m.receipt.availability = "missing"; }, "evaluation receipt cannot rest on missing or unsupported evidence"],
      ["receipt owner", (m) => { m.receipt.source_id = "source-b"; }, "evaluation receipt/budget qualification owner mismatch"],
      ["linked run source", (m) => { m.linked_runs[0].source_id = "source-z"; }, "evaluation linked run outside query snapshot sources"],
      ["coverage", (m) => { m.coverage.covered = 3; }, "covered exceeds eligible"],
      ["zero threshold", (m) => { m.budget.threshold_usd = 0; }, "paid dispatch threshold must be positive"],
      ["strict overshoot", (m) => { m.budget.mode = "strict_verified"; }, "native threshold may overshoot; strict mode requires separate verified qualification"],
      ["qualification missing", (m) => { m.budget.qualification.availability = "missing"; }, "budget qualification cannot rest on missing or unsupported evidence"],
      ["observed without model", (m) => { m.observed_identity.model = null; }, "observed identity needs observed model"],
      ["unavailable with model", (m) => { m.observed_identity.status = "unavailable"; }, "unavailable observed identity needs null model and reason"],
    ];
    const docs: any[] = [example, ...mutations.map(([, f]) => { const c = structuredClone(example); f(c); return c; })];
    const py = [
      "import sys,json,ast,copy,math,hashlib", "from datetime import datetime",
      `root=${JSON.stringify(A02_ROOT)}`, "p=root+'/verify_contracts.py'",
      "t=ast.parse(open(p).read(),p)",
      "m=ast.Module(body=[n for n in t.body if isinstance(n,ast.FunctionDef) and n.name in {'dt','semantic_errors','input_identity','disclosed','usable'}],type_ignores=[])",
      "CATALOG=json.load(open(root+'/metric-catalog.json'))", "METRICS={x['id']:x for x in CATALOG['atomic_measurements']}",
      "SIGNED_METRICS=set()", "UNSIGNED_UNITS=set()", "USAGE_COUNTERS=[]", "BY_URI={}",
      "exec(compile(m,p,'exec'))",
      "print(json.dumps([semantic_errors('evaluation-manifest',v) for v in json.load(sys.stdin)]))",
    ].join("\n");
    const r = spawnSync("python3", ["-I", "-c", py], { input: JSON.stringify(docs), encoding: "utf8" });
    expect(r.stderr).toBe("");
    const pyErrors = JSON.parse(r.stdout) as string[][];
    expect(pyErrors[0]).toEqual([]);
    expect(validateEvaluationManifestV2(example)).toEqual({ ok: true });
    mutations.forEach(([, , msg], i) => {
      expect(pyErrors[i + 1]).toContain(msg);
      const v = validateEvaluationManifestV2(docs[i + 1]);
      expect(v.ok ? [] : v.errors).toContain(msg);
    });
    // structural: the frozen schema's required keys and closed shape
    const schema = JSON.parse(fs.readFileSync(path.join(A02_ROOT, "schemas", "evaluation-manifest.schema.json"), "utf8"));
    for (const k of schema.required as string[]) { const c = structuredClone(example); delete c[k]; expect(validateEvaluationManifestV2(c).ok).toBe(false); }
    expect(validateEvaluationManifestV2({ ...example, extra: 1 }).ok).toBe(false);
    expect(validateEvaluationManifestV2({ ...example, cases: [] }).ok).toBe(false);
  });

  it("R3 · excluded pairs could hold the losses: no improvement", () => {
    const m = manifest();
    // pairs 1-2 match (0.5 -> 0.75); pairs 3-4 lose (1 -> 0.6) but their candidate seeds differ
    const ts = fullTrials(m, (p) => (p <= 2 ? { score: 0.75 } : { score: 0.6, seed: "other-seed" })).map((t) => (t.arm === "baseline" && Number(t.pair_id.slice(5)) > 2 ? { ...t, score: 1 } : t));
    const r = pairedEvaluation(imported(m, ts).entry);
    expect(r.quality.candidate_mean).toBeCloseTo(0.675, 12);
    expect(r.quality.baseline_mean).toBeCloseTo(0.75, 12);
    expect(r.sample.coverage).toMatchObject({ state: "complete", excluded: 4 });
    expect(r.label).toBe("descriptive_only");
  });

  it("R4 · a receipt that discloses incomplete coverage is not an improvement", () => {
    const m = manifest("source-a", { coverage: { eligible: 20, covered: 16, excluded: 0, missing: 4, state: "partial", reason: "4 observations lost", exclusion_reasons: [] } });
    const r = pairedEvaluation(imported(m, fullTrials(m)).entry);
    expect(r.sample.coverage.state).toBe("complete");
    expect(r.label).toBe("descriptive_only");
    expect(r.label_reason).toMatch(/4 observations lost/);
  });

  it("R3 · paired cost statistics do not pool measured billing and estimates", () => {
    const m = manifest();
    const ts = fullTrials(m).map((t) => (t.pair_id === "pair-1" ? { ...t, usage: t.usage.map((u) => ({ ...u, cost_basis: "derived_estimate" as const })) } : t));
    const r = pairedEvaluation(imported(m, ts).entry);
    expect(r.operational.cost_basis).toBe("mixed");
    expect(r.operational.cost_delta_usd).toMatchObject({ n: 0, mean: null, ci95: null });
    expect(r.label).toBe("improvement");
  });

  it("R1 · t quantiles above 30 degrees of freedom are Student t, not normal", () => {
    expect(tQuantile975(31)).toBeCloseTo(2.0395, 3);
    expect(tQuantile975(40)).toBeCloseTo(2.0211, 3);
    expect(tQuantile975(60)).toBeCloseTo(2.0003, 3);
    expect(tQuantile975(120)).toBeCloseTo(1.9799, 3);
    // n = 32, t-statistic 1.99: the t interval includes zero, so no improvement
    const xs = Array.from({ length: 32 }, (_, i) => (i % 2 ? 1 : -1));
    const shift = 1.99 * Math.sqrt(pairedStatistic(xs).variance! / 32);
    expect(pairedStatistic(xs.map((x) => x + shift)).ci95![0]).toBeLessThan(0);
  });

  it("R1 · with no observed model on the manifest, arms must still agree, and an unverified model is descriptive", () => {
    const m = manifest("source-a", { observed_identity: { provider: null, model: null, status: "unavailable", reason: "host does not report" } });
    const split = pairedEvaluation(imported(m, fullTrials(m, () => ({ observed_model: "other-observed" }))).entry);
    expect(split.label).toBe("refused");
    expect(split.refusal_reasons.join(" ")).toContain("observed_model_mismatch");
    const unknown = fullTrials(m).map((t) => ({ ...t, observed_model: null }));
    expect(pairedEvaluation(imported(m, unknown).entry).label).toBe("descriptive_only");
  });

  it("R1 · the quality floor covers the whole candidate arm, not only paired survivors", () => {
    const m = manifest();
    const ts = fullTrials(m, (p, r) => (p + r > 3 ? { score: 0 } : { score: 0.75 })).filter((t) => !(t.arm === "baseline" && t.pair_id !== "pair-1" && !(t.pair_id === "pair-2" && t.repetition === 1)));
    const r = pairedEvaluation(imported(m, ts).entry);
    expect(r.samples.every((x) => x.candidate_score === 0.75)).toBe(true);
    expect(r.quality.candidate_mean).toBeCloseTo(3 * 0.75 / 8, 12);
    expect(r.quality.floor_met).toBe(false);
    expect(r.label).toBe("regression");
    // a missing candidate slot makes the floor unknown, never met
    const gap = pairedEvaluation(imported(m, fullTrials(m).filter((t) => !(t.arm === "candidate" && t.pair_id === "pair-4"))).entry);
    expect(gap.quality.floor_met).toBeNull();
    expect(gap.label).toBe("descriptive_only");
  });

  it("R1 · result hash does not depend on import order for non-binary costs", () => {
    const m = manifest();
    const ts = fullTrials(m, (p, r) => ({ cost: p === 1 && r === 1 ? 1 : 0.01 })).map((t) => (t.arm === "baseline" ? { ...t, usage: t.usage.map((u) => ({ ...u, cost_usd: 0.01 })) } : t));
    const big = ts.find((t) => t.usage[0]!.cost_usd === 1)!;
    const rest = ts.filter((t) => t !== big);
    // 1 + 0.01 x15 and 0.01 x15 + 1 differ in floating point
    const cents = Array(15).fill(0.01) as number[];
    expect([1, ...cents].reduce((a, x) => a + x, 0)).not.toBe([...cents, 1].reduce((a, x) => a + x, 0));
    const a = pairedEvaluation(imported(m, [big, ...rest]).entry);
    const b = pairedEvaluation(imported(m, [...rest, big]).entry);
    expect(b.result_hash).toBe(a.result_hash);
  });

  it("pairedStatistic: zero, one and many samples", () => {
    expect(pairedStatistic([])).toMatchObject({ n: 0, mean: null, ci95: null });
    expect(pairedStatistic([1])).toMatchObject({ n: 1, mean: 1, variance: null, ci95: null });
    const s = pairedStatistic([1, 2, 3]);
    expect(s.variance).toBe(1);
    expect(s.ci95![1]).toBeCloseTo(2 + 4.303 * Math.sqrt(1 / 3), 12);
  });
});

// ── AT44 · engine import/recovery ────────────────────────────────────────────

describe("AT44 · engine import/recovery", () => {
  it("the same evaluation imported twice is one identity and one billable request set", () => {
    const ts = fullTrials(manifest());
    const md = declare(manifest(), ts);
    const l = new EvaluationLedger();
    const first = l.import(md, ts);
    const second = l.import(structuredClone(md), structuredClone(ts));
    const third = l.import(md, [...ts, ...ts]);
    expect(first).toMatchObject({ outcome: "created", added_attempts: 16, billable_requests: 16 });
    expect(second).toMatchObject({ outcome: "unchanged", added_attempts: 0, duplicate_attempts: 16, billable_requests: 16 });
    expect(third).toMatchObject({ outcome: "unchanged", duplicate_attempts: 32, billable_requests: 16 });
    expect(l.entries.size).toBe(1);
    expect(pairedEvaluation(l.entries.get("source-a:eval-1")!).operational.billable_requests).toBe(16);
  });

  it("rerun after cancel and timeout recovers explicitly; spend of every attempt is billed once", () => {
    const m = manifest();
    const ts = fullTrials(m).filter((t) => !(t.pair_id === "pair-1" && t.arm === "candidate" && t.repetition === 1) && !(t.pair_id === "pair-2" && t.arm === "baseline" && t.repetition === 2));
    ts.push(trial(m, 1, "candidate", 1, { attempt_id: "c-p1-r1-a1", status: "cancelled", score: null, latency_ms: null, cost: 0.1 }));
    ts.push(trial(m, 1, "candidate", 1, { attempt_id: "c-p1-r1-a2", rerun_of: "c-p1-r1-a1", score: 0.75 }));
    ts.push(trial(m, 2, "baseline", 2, { attempt_id: "b-p2-r2-a1", status: "timeout", score: null, latency_ms: null, cost: 0.2 }));
    const { entry } = imported(m, ts);
    const r = pairedEvaluation(entry);
    expect(r.recovery).toMatchObject({ state: "partial", expected_slots: 16, completed: 15, recovered: 1, open_count: 1 });
    expect(r.recovery.open).toEqual([{ pair_id: "pair-2", arm: "baseline", repetition: 2, state: "timeout", attempts: 1 }]);
    expect(r.sample).toMatchObject({ expected: 8, n: 7 });
    expect(r.sample.coverage).toMatchObject({ state: "partial", eligible: 8, covered: 7, missing: 1 });
    expect(r.operational.billable_requests).toBe(17);
    expect(r.operational.exact_spend_usd).toBeCloseTo(7 * 0.5 + 8 * 0.25 + 0.1 + 0.2, 12);
    // then the timed-out slot is rerun and the evaluation completes; the import is idempotent on the earlier lines
    const rerun = trial(m, 2, "baseline", 2, { attempt_id: "b-p2-r2-a2", rerun_of: "b-p2-r2-a1" });
    const md2 = { ...declare(m, [...ts, rerun]), evaluation: { ...m.evaluation, revision: h("1") } };
    const l = new EvaluationLedger();
    l.import(declare(m, ts), ts);
    expect(l.import(md2, [...ts, rerun])).toMatchObject({ outcome: "re_receipted", added_attempts: 1, duplicate_attempts: ts.length });
    const done = pairedEvaluation(l.entries.get("source-a:eval-1")!);
    expect(done.recovery).toMatchObject({ state: "complete", recovered: 2, open_count: 0 });
    expect(done.revisions).toEqual([H, h("1")]);
  });

  describe("negative controls: no second copy of spend or attempts", () => {
    const m = manifest();
    const base = () => fullTrials(m);
    const refuses = (ts: TrialRecord[], code: string, md = declare(m, ts)) => {
      const l = new EvaluationLedger();
      expect(() => l.import(md, ts)).toThrow(EvaluationRefusal);
      try { l.import(md, ts); } catch (e) { expect((e as EvaluationRefusal).code).toBe(code); }
      expect(l.entries.size).toBe(0);
    };
    it("rerunning a completed slot", () => refuses([...base(), trial(m, 1, "candidate", 1, { attempt_id: "again", rerun_of: "c-p1-r1", status: "error", score: null })], "attempt_conflict"));
    it("two completed attempts in one slot (best-of picking)", () => refuses([...base(), trial(m, 1, "candidate", 1, { attempt_id: "best-of" })], "attempt_conflict"));
    it("one accounting identity billed by two attempts", () => refuses([...base(), trial(m, 1, "candidate", 1, { attempt_id: "dup-bill", status: "error", score: null, reqs: ["req-c-p1-r1"] })], "accounting_conflict"));
    it("an accounting identity the manifest does not declare", () => { const ts = base(); refuses(ts, "accounting_conflict", { ...declare(m, ts), accounting_identities: [] }); });
    it("a trial run in an unlinked operational run", () => refuses([...base().slice(1), trial(m, 1, "baseline", 1, { run: { source_id: "source-a", id: "run-9" } })], "unlinked_run"));
    it("a changed attempt or manifest under the same identity", () => {
      const ts = base();
      const l = new EvaluationLedger();
      l.import(declare(m, ts), ts);
      const changed = { ...ts[0]!, score: 0.25 };
      expect(() => l.import(declare(m, ts), [changed])).toThrow(/different content/);
      expect(() => l.import({ ...declare(m, ts), requested_model: "x" }, [])).toThrow(/different content/);
      expect(() => l.import({ ...declare(m, ts), requested_model: "x", evaluation: { ...m.evaluation, revision: h("2") } }, [])).toThrow(/new evaluation/);
      expect(() => l.import({ ...declare(m, ts), accounting_identities: [], evaluation: { ...m.evaluation, revision: h("2") } }, [])).toThrow(/drops billed/);
      // the refused imports left the first import as it was
      expect(l.entries.get("source-a:eval-1")!.attempts.get(ts[0]!.attempt_id)!.score).toBe(0.5);
      expect(l.entries.get("source-a:eval-1")!.revisions).toEqual([H]);
    });
  });

  it("R1 · undeclared pairs, repetitions beyond the declared count and dropped linked runs refuse", () => {
    const m = manifest();
    const ts = fullTrials(m);
    const l = () => new EvaluationLedger();
    expect(() => l().import(declare(m, [...ts, trial(m, 9, "candidate", 1)]), [...ts, trial(m, 9, "candidate", 1)])).toThrow(/does not declare/);
    expect(() => l().import(declare(m, [...ts, trial(m, 1, "candidate", 99, { attempt_id: "rep-99" })]), [...ts, trial(m, 1, "candidate", 99, { attempt_id: "rep-99" })])).toThrow(/exceeds the declared/);
    const led = l();
    led.import(declare(m, ts), ts);
    expect(() => led.import({ ...declare(m, ts), linked_runs: [], evaluation: { ...m.evaluation, revision: h("2") } }, [])).toThrow(/drops linked runs/);
  });

  it("R1 · the ledger keeps its own copies of imported objects", () => {
    const m = declare(manifest(), fullTrials(manifest()));
    const ts = fullTrials(manifest());
    const led = new EvaluationLedger();
    led.import(m, ts);
    const before = pairedEvaluation(led.entries.get("source-a:eval-1")!).result_hash;
    ts[0]!.score = 0;
    m.requested_model = "mutated";
    expect(pairedEvaluation(led.entries.get("source-a:eval-1")!).result_hash).toBe(before);
    expect(() => led.import(m, [])).toThrow(/different content/);
    expect(() => led.import({ ...m, requested_model: "requested-model" }, ts)).toThrow(/different content/);
  });

  it("R1 · declared requests without observations keep spend unknown", () => {
    const m = manifest();
    const ts = fullTrials(m);
    const md = { ...declare(m, ts), accounting_identities: [...declare(m, ts).accounting_identities, "req-never-reported"] };
    const led = new EvaluationLedger();
    led.import(md, ts);
    const r = pairedEvaluation(led.entries.get("source-a:eval-1")!);
    expect(r.operational).toMatchObject({ unobserved_requests: 1, exact_spend_usd: null });
    const s = evaluationSpend(led.entries.get("source-a:eval-1")!, [{ source_id: "source-a", run_id: "run-1", usage_state: "available", extra_missing: 0, leaves: [] } as unknown as RunFacts]);
    expect(s).toMatchObject({ unobserved: 1, exact_usd: null });
    expect(s.coverage).toMatchObject({ state: "partial", missing: 1 });
    const empty = new EvaluationLedger();
    empty.import(md, []);
    expect(pairedEvaluation(empty.entries.get("source-a:eval-1")!).operational).toMatchObject({ exact_spend_usd: null, unobserved_requests: 17 });
  });

  it("R1 · a request is billed in the source of the run that made it", () => {
    const m = manifest("source-a", { linked_runs: [{ source_id: "source-a", kind: "run", id: "run-1", revision: H }, { source_id: "source-b", kind: "run", id: "run-b", revision: H }] });
    m.query.snapshot = { ...m.query.snapshot, source_ids: ["source-a", "source-b"], source_generations: [{ source_id: "source-a", generation: H }, { source_id: "source-b", generation: H }] };
    const ts = fullTrials(m).slice(0, 2).map((t) => ({ ...t, run: { source_id: "source-b", id: "run-b" } }));
    const { entry } = imported(m, ts);
    const leaf = (id: string, usd: number) => ({ accounting_identity: id, measured_usd: usd, derived_usd: null }) as unknown as RunFacts["leaves"][number];
    const s = evaluationSpend(entry, [{ source_id: "source-b", run_id: "run-b", usage_state: "available", extra_missing: 0, leaves: [leaf("req-b-p1-r1", 0.5), leaf("req-c-p1-r1", 0.25)] } as RunFacts]);
    expect(s).toMatchObject({ requests: 2, shared: 2, known_usd: 0.75, exact_usd: null });
    expect(s.coverage.reason).toMatch(/source-a:run-1/);
  });

  it("R1 · measured billing and derived estimates are not added", () => {
    const m = manifest();
    const ts = fullTrials(m).slice(0, 2);
    ts[1] = { ...ts[1]!, usage: ts[1]!.usage.map((u) => ({ ...u, cost_basis: "derived_estimate" as const })) };
    const { entry } = imported(m, ts);
    const r = pairedEvaluation(entry);
    expect(r.operational).toMatchObject({ spend_basis: "mixed", known_spend_usd: null, exact_spend_usd: null, spend_by_basis: { measured: 0.5, derived_estimate: 0.25 } });
    const s = evaluationSpend(entry, []);
    expect(s).toMatchObject({ basis: "mixed", known_usd: null, exact_usd: null });
    const leaf = { accounting_identity: "req-c-p1-r1", measured_usd: 0.25, derived_usd: null } as unknown as RunFacts["leaves"][number];
    expect(() => evaluationSpend(entry, [{ source_id: "source-a", run_id: "run-1", usage_state: "available", extra_missing: 0, leaves: [leaf] } as RunFacts])).toThrow(/billed/);
  });

  it("R2 · unbounded slots, duplicate linked runs and mixed scorer scales refuse at import", () => {
    const big = manifest("source-a", { reps: 1e100 });
    expect(() => new EvaluationLedger().import(big, [])).toThrow(/slot bound/);
    const dupRuns = manifest();
    dupRuns.linked_runs = [dupRuns.linked_runs[0]!, { ...dupRuns.linked_runs[0]!, revision: h("2") }];
    expect(() => new EvaluationLedger().import(dupRuns, [])).toThrow(/linked run is declared twice/);
    const scales = manifest();
    scales.cases[1]!.scorer_version = "rubric.100";
    expect(() => new EvaluationLedger().import(scales, [])).toThrow(/several scorer versions/);
  });

  it("R2 · one request id in two sources is two requests; a run observation resolves a declared request", () => {
    const m = manifest("source-a", { linked_runs: [{ source_id: "source-a", kind: "run", id: "run-1", revision: H }, { source_id: "source-b", kind: "run", id: "run-b", revision: H }] });
    m.query.snapshot = { ...m.query.snapshot, source_ids: ["source-a", "source-b"], source_generations: [{ source_id: "source-a", generation: H }, { source_id: "source-b", generation: H }] };
    const ts = fullTrials(m).slice(0, 2).map((t, i) => ({ ...t, run: i ? { source_id: "source-b", id: "run-b" } : { source_id: "source-a", id: "run-1" }, usage: t.usage.map((u) => ({ ...u, accounting_identity: "req-shared" })) }));
    const md = { ...declare(m, ts), accounting_identities: ["req-only-in-run", "req-shared"] };
    const led = new EvaluationLedger();
    expect(led.import(md, ts).billable_requests).toBe(2);
    const entry = led.entries.get("source-a:eval-1")!;
    expect(pairedEvaluation(entry).operational.unobserved_requests).toBe(1);
    const leaf = (id: string, usd: number) => ({ accounting_identity: id, measured_usd: usd, derived_usd: null }) as unknown as RunFacts["leaves"][number];
    const sp = evaluationSpend(entry, [{ source_id: "source-a", run_id: "run-1", usage_state: "available", extra_missing: 0, leaves: [leaf("req-only-in-run", 0.5)] } as RunFacts, { source_id: "source-b", run_id: "run-b", usage_state: "available", extra_missing: 0, leaves: [] } as unknown as RunFacts]);
    expect(sp).toMatchObject({ requests: 3, unobserved: 0, known_usd: 1.25, exact_usd: 1.25 });
    expect(sp.coverage).toMatchObject({ state: "complete", eligible: 3 });
  });

  it("R4 · source and identity never merge through a separator", () => {
    const m = manifest("source-a", { linked_runs: [{ source_id: "source-a", kind: "run", id: "run-1", revision: H }, { source_id: "source-a:x", kind: "run", id: "run-x", revision: H }] });
    m.query.snapshot = { ...m.query.snapshot, source_ids: ["source-a", "source-a:x"], source_generations: [{ source_id: "source-a", generation: H }, { source_id: "source-a:x", generation: H }] };
    const ts = fullTrials(m).slice(0, 1).map((t) => ({ ...t, usage: [{ accounting_identity: "x:req", cost_usd: 1, cost_basis: "measured" as const, tokens: 1 }] }));
    const { entry } = imported(m, ts);
    const leaf = { accounting_identity: "req", measured_usd: 1, derived_usd: null } as unknown as RunFacts["leaves"][number];
    const s = evaluationSpend(entry, [{ source_id: "source-a", run_id: "run-1", usage_state: "available", extra_missing: 0, leaves: [] } as unknown as RunFacts, { source_id: "source-a:x", run_id: "run-x", usage_state: "available", extra_missing: 0, leaves: [leaf] } as unknown as RunFacts]);
    expect(s).toMatchObject({ requests: 2, shared: 0, known_usd: 2, exact_usd: 2 });
    expect(validateEvaluationSpend(s)).toEqual({ ok: true });
  });

  it("benchmark usage and the same linked run usage are billed once", () => {
    const ts = fullTrials(manifest()).slice(0, 2);
    const { entry } = imported(manifest(), ts);
    const leaf = (id: string, usd: number | null) => ({ accounting_identity: id, measured_usd: usd, derived_usd: null }) as unknown as RunFacts["leaves"][number];
    const run = { source_id: "source-a", run_id: "run-1", usage_state: "available", extra_missing: 0, leaves: [leaf("req-b-p1-r1", 0.5), leaf("req-c-p1-r1", 0.25), leaf("req-orchestration", 0.125)] } as RunFacts;
    const s = evaluationSpend(entry, [run]);
    expect(s).toMatchObject({ requests: 3, shared: 2, from_evaluation_only: 0, from_runs_only: 1, known_usd: 0.875, exact_usd: 0.875 });
    expect(validateEvaluationSpend(s)).toEqual({ ok: true });
    // negative control: adding benchmark usage and the same linked run usage double counts
    const naive = { lines: [...[...entry.billable.values()].map((v) => ({ source_id: v.source_id, accounting_identity: v.usage.accounting_identity, usd: v.usage.cost_usd })), ...run.leaves.map((l) => ({ source_id: "source-a", accounting_identity: l.accounting_identity, usd: l.measured_usd }))], requests: 5, known_usd: 0.75 + 0.875 };
    expect(naive.known_usd).not.toBe(s.known_usd);
    expect(validateEvaluationSpend(naive)).toEqual({ ok: false, errors: ["a billable request is counted twice"] });
    expect(() => evaluationSpend(entry, [{ ...run, run_id: "run-9" }])).toThrow(/not linked/);
    expect(() => evaluationSpend(entry, [{ ...run, leaves: [leaf("req-b-p1-r1", 0.9)] }])).toThrow(/billed/);
    // R4: a supplied run without a complete request enumeration is unknown too
    expect(evaluationSpend(entry, [{ ...run, usage_state: "unavailable", extra_missing: null, leaves: [] }]).exact_usd).toBeNull();
    expect(evaluationSpend(entry, [{ ...run, extra_missing: 2 }]).coverage.state).not.toBe("complete");
    // a linked run the caller did not read is unknown, never complete
    const omitted = evaluationSpend(entry, []);
    expect(omitted.exact_usd).toBeNull();
    expect(omitted.coverage.state).not.toBe("complete");
    // a linked run whose requests are unknown leaves the total unknown, not the known part
    const u = evaluationSpend(entry, [], ["source-a:run-1"]);
    expect(u.exact_usd).toBeNull();
    expect(u.coverage).toMatchObject({ eligible: null, state: "partial" });
  });

  it("metric quality and operational efficiency stay separate", () => {
    const a = pairedEvaluation(imported(manifest(), fullTrials(manifest())).entry);
    const b = pairedEvaluation(imported(manifest(), fullTrials(manifest(), () => ({ cost: 5 }))).entry);
    expect(b.quality).toEqual(a.quality);
    expect(b.label).toBe(a.label);
    expect(b.operational.cost_delta_usd.mean).not.toBe(a.operational.cost_delta_usd.mean);
    const unknown = pairedEvaluation(imported(manifest(), fullTrials(manifest(), () => ({ cost: null }))).entry);
    expect(unknown.quality).toEqual(a.quality);
    expect(unknown.operational.cost_delta_usd).toMatchObject({ n: 0, mean: null });
    expect(unknown.operational.exact_spend_usd).toBeNull();
  });
});

// ── C9 projection and service ────────────────────────────────────────────────

let base = "";
const rootOf = (s: string) => path.join(base, s);
function put(source: string, rel: string, body: string): void {
  const p = path.join(rootOf(source), ".guild", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
function writeEvaluation(dir: string, m: EvaluationManifestV2, ts: TrialRecord[], extraLines: TrialRecord[] = []): void {
  put(dir, `artifacts/generated/benchmarks/${m.evaluation.id}/evaluation-manifest.json`, JSON.stringify(declare(m, ts)));
  put(dir, `artifacts/generated/benchmarks/${m.evaluation.id}/trials.jsonl`, [...ts, ...extraLines].map((t) => JSON.stringify(t)).join("\n") + "\n");
}
const COMPLETE: TraceCoverage = { eligible: 1, covered: 1, excluded: 0, missing: 0, state: "complete", reason: null, exclusion_reasons: [] };
function traceEvent(source: string, run: string, n: number, acct: string, usd: number): TraceAnalysisV3 {
  const usage: TraceUsage = {
    granularity: "leaf_request", observation_id: `obs-${acct}`, revision: 1, final: true, accounting_identity: acct, parent_accounting_identity: null,
    inclusion: "leaf_exclusive", input_inclusive: 10, output: 5, cache_read_subset: 0, cache_write_subset: 0, total: 15, cost_usd: usd, cost_basis: "measured",
    currency: "USD", pricing_version: null, usage_semantics: "inclusive_input_cache_subset.v1", coverage: COMPLETE, native_baseline_usd: null, native_cumulative_usd: null,
  };
  return {
    schema_version: "guild.trace.analysis.v3", event_id: `record-${n}`, sequence: n, event_class: "request_completed", at: new Date(Date.parse("2026-10-26T00:00:00Z") + n * 1000).toISOString(),
    lineage: { source_id: source, run_id: run, execution_id: "exec-1", host_session_id: null, initiative_id: null, goal_id: null, logical_task_id: null, attempt_id: null, agent_instance_id: null, request_id: acct },
    operation_id: null, component_invocation_id: null, actor_id: "agent-1", pins: { assignment: H, definition: H, configuration: H, workflow: H, policy: H }, requested_model: "requested-model",
    observed_identity: { provider: "provider", model: "observed-model", status: "observed", reason: null },
    usage, payload_ref: null, prompt_hash: null, redaction_version: "guild.trace-scrub.v1", capture: COMPLETE, interval: null,
  };
}
const isRefusal = (x: unknown): x is RefusalV2 => (x as RefusalV2)?.schema_version === "guild.stack.refusal.v2";
function series(snap: ProjectSnapshot, metric: string, o: { filters?: QueryIdentity["filters"]; group_by?: "all" | "source" } = {}): MetricSeriesV2 | RefusalV2 {
  const q = projectQuery(snap, { metric_id: metric, filters: o.filters, grain: "evaluation" });
  const r = readMetricSeries(snap, readRequest(q, "metric_series", { request_id: "q-1", session_id: "stack-session-1" }), { group_by: o.group_by });
  if (!isRefusal(r)) expect(validateMetricSeriesV2(r)).toEqual({ ok: true });
  return r;
}
const ok = (r: MetricSeriesV2 | RefusalV2): MetricSeriesV2 => { if (isRefusal(r)) throw new Error(`refused: ${r.code} ${r.message}`); return r; };

beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guild-b01-"))); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe("AT43/AT44 · M28 series over the project read service", () => {
  it("M28 series reproduce the paired engine; duplicated trial lines change nothing", () => {
    const m = manifest();
    const ts = fullTrials(m);
    writeEvaluation("source-a", m, ts, ts.slice(0, 5));
    fs.mkdirSync(rootOf("source-b"), { recursive: true });
    const snap = openProjectSnapshot([{ source_id: "source-a", root: rootOf("source-a") }, { source_id: "source-b", root: rootOf("source-b") }], { as_of: AS_OF });
    const engine = pairedEvaluation(imported(m, ts).entry);
    expect(snap.evaluations.get("source-a:eval-1")!.paired.result_hash).toBe(engine.result_hash);
    const d = ok(series(snap, "M28.paired_score_delta", { group_by: "source" }));
    const pa = d.points.find((p) => p.key === "source-a")!;
    expect(pa.value).toBeCloseTo(engine.quality.score_delta.mean!, 12);
    expect(pa).toMatchObject({ numerator: 2.5, denominator: 8, cost_basis: "not_applicable" });
    expect(pa.coverage.state).toBe("complete");
    // source-b has no evaluation producer: unknown, never zero
    const pb = d.points.find((p) => p.key === "source-b")!;
    expect(pb).toMatchObject({ value: null });
    expect(pb.coverage.state).toBe("unavailable");
    expect(pb.reason).toMatch(/no evaluation producer/);
    expect(ok(series(snap, "M28.pair_count", { group_by: "source" })).points.find((p) => p.key === "source-a")!.value).toBe(4);
    const cost = ok(series(snap, "M28.paired_cost_delta_usd", { group_by: "source" })).points.find((p) => p.key === "source-a")!;
    expect(cost).toMatchObject({ cost_basis: "measured" });
    expect(cost.value).toBeCloseTo(-0.25, 12);
    expect(ok(series(snap, "M28.paired_latency_delta_ms", { group_by: "source" })).points.find((p) => p.key === "source-a")!.value).toBe(-200);
    const score = ok(series(snap, "M28.evaluation_score", { filters: [{ dimension: "workflow_revision", values: [CAND] }], group_by: "source" }));
    expect(score.unit).toBe("case_score");
    expect(score.points.find((p) => p.key === "source-a")).toMatchObject({ numerator: 6.5, denominator: 8, cost_basis: "not_applicable" });
    // filtered by case: the pairs of case-2 only
    const c2 = ok(series(snap, "M28.paired_score_delta", { filters: [{ dimension: "case", values: ["case-2"] }], group_by: "source" })).points.find((p) => p.key === "source-a")!;
    expect(c2).toMatchObject({ numerator: 1.5, denominator: 4 });
  });

  it("pooling refusals and partial coverage are explicit", () => {
    const m = manifest();
    const ts = fullTrials(m).filter((t) => !(t.pair_id === "pair-3" && t.arm === "candidate" && t.repetition === 2));
    writeEvaluation("source-a", m, ts);
    const m2 = manifest("source-a", { id: "eval-2" });
    writeEvaluation("source-a", m2, fullTrials(m2, () => ({ requested_model: "other-model" })));
    const snap = openProjectSnapshot([{ source_id: "source-a", root: rootOf("source-a") }], { as_of: AS_OF });
    const d = ok(series(snap, "M28.paired_score_delta"));
    expect(d.points[0]!.coverage).toMatchObject({ state: "partial", eligible: 8, covered: 7, missing: 1 });
    expect(d.points[0]!.coverage.exclusion_reasons).toEqual([{ code: "model_mismatch", count: 8 }]);
    expect(d.points[0]!.reason).toMatch(/eval-2 refused/);
    // both arms' scores, or several scorer scales, never pool
    const mixed = series(snap, "M28.evaluation_score");
    expect(isRefusal(mixed) && mixed.code).toBe("unsupported_capability");
    expect(isRefusal(series(snap, "M28.paired_score_delta", { filters: [{ dimension: "run", values: ["run-1"] }] }))).toBe(true);
    // R1: selecting both arm revisions refuses even when only one arm has trials
    expect(isRefusal(series(snap, "M28.evaluation_score", { filters: [{ dimension: "workflow_revision", values: [BASE, CAND] }] }))).toBe(true);
  });

  it("R2 · baseline records carrying the candidate revision cannot fill candidate slots", () => {
    const m = manifest();
    writeEvaluation("source-a", m, fullTrials(m).filter((t) => t.arm === "baseline").map((t) => ({ ...t, revision: CAND })));
    const snap = openProjectSnapshot([{ source_id: "source-a", root: rootOf("source-a") }], { as_of: AS_OF });
    const cand = ok(series(snap, "M28.evaluation_score", { filters: [{ dimension: "workflow_revision", values: [CAND] }] })).points[0]!;
    expect(cand.coverage.state).not.toBe("complete");
    expect(cand.coverage.missing === null || cand.coverage.missing > 0).toBe(true);
    expect(cand.value).toBeNull();
  });

  it("R1 · a selected arm with no trials is unknown, not complete", () => {
    const m = manifest();
    writeEvaluation("source-a", m, fullTrials(m).filter((t) => t.arm === "baseline"));
    const snap = openProjectSnapshot([{ source_id: "source-a", root: rootOf("source-a") }], { as_of: AS_OF });
    const cand = ok(series(snap, "M28.evaluation_score", { filters: [{ dimension: "workflow_revision", values: [CAND] }] })).points[0]!;
    expect(cand.value).toBeNull();
    expect(cand.coverage.state).not.toBe("complete");
    const base = ok(series(snap, "M28.evaluation_score", { filters: [{ dimension: "workflow_revision", values: [BASE] }] })).points[0]!;
    expect(base).toMatchObject({ value: 0.5 });
    expect(base.coverage.state).toBe("complete");
    expect(isRefusal(series(snap, "M28.evaluation_score", { filters: [{ dimension: "workflow_revision", values: [BASE, CAND] }] }))).toBe(true);
  });

  it("an evaluation that cannot be imported keeps the enumeration unknown", () => {
    const m = manifest();
    const ts = fullTrials(m);
    writeEvaluation("source-a", m, ts, [{ ...ts[0]!, score: 0.125 }]);
    const snap = openProjectSnapshot([{ source_id: "source-a", root: rootOf("source-a") }], { as_of: AS_OF });
    expect(snap.facts.sources[0]!.evaluations!.unreadable[0]).toMatchObject({ evaluation_id: "eval-1" });
    expect(snap.facts.sources[0]!.evaluations!.unreadable[0]!.reason).toMatch(/attempt_conflict/);
    const p = ok(series(snap, "M28.pair_count")).points[0]!;
    expect(p.value).toBeNull();
    expect(p.coverage.state).toBe("unavailable");
  });

  it("the evaluation report joins linked run usage once and changes the snapshot generation", async () => {
    const root = rootOf("ws");
    fs.mkdirSync(root, { recursive: true });
    const src = canonicalSourceId(root);
    const m = manifest(src);
    const ts = fullTrials(m).slice(0, 4);
    // The operational run recorded two of the benchmark's requests plus its own orchestration request.
    put("ws", "runs/run-1/trace.jsonl", [traceEvent(src, "run-1", 1, "req-b-p1-r1", 0.5), traceEvent(src, "run-1", 2, "req-c-p1-r1", 0.25), traceEvent(src, "run-1", 3, "req-orchestration", 0.125)].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const before = openProjectSnapshot([{ source_id: src, root }], { as_of: AS_OF }).facts.snapshot.input_manifest_digest;
    writeEvaluation("ws", m, ts);
    const snap = openProjectSnapshot([{ source_id: src, root }], { as_of: AS_OF });
    expect(snap.facts.snapshot.input_manifest_digest).not.toBe(before);
    const rep = evaluationReport(snap, src, "eval-1")!;
    expect(rep.spend).toMatchObject({ requests: 5, shared: 2, from_runs_only: 1 });
    expect(rep.spend.exact_usd).toBeCloseTo(0.5 + 0.25 + 0.5 + 0.25 + 0.125, 12);
    const app = createApp({ runsDir: path.join(base, "bench-runs"), casesDir: path.join(base, "cases"), port: 0, projectRoot: root });
    const res = await app.fetch(new Request("http://127.0.0.1:3055/api/project/evaluations/report", { method: "POST", headers: { host: "127.0.0.1:3055", "content-type": "application/json" }, body: JSON.stringify({ source_id: src, evaluation_id: "eval-1", as_of: AS_OF }) }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.paired.result_hash).toBe(rep.paired.result_hash);
    expect(body.spend.requests).toBe(5);
    const missing = await app.fetch(new Request("http://127.0.0.1:3055/api/project/evaluations/report", { method: "POST", headers: { host: "127.0.0.1:3055", "content-type": "application/json" }, body: JSON.stringify({ source_id: src, evaluation_id: "eval-9", as_of: AS_OF }) }));
    expect(missing.status).toBe(422);
    // an as_of before the evaluation evidence is a stale source, not a silent drop
    expect(() => openProjectSnapshot([{ source_id: src, root }], { as_of: "2026-10-25T00:00:00Z" })).toThrow();
  });
});
