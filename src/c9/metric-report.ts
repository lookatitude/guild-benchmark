/**
 * benchmark/src/c9 — U04 metric report export and human analysis (AT45, AT46).
 *
 * Nothing here computes a C9 value. Every value comes from `readMetricSeries`
 * (the one engine behind POST /api/project/metrics/series). The report copies
 * whole series; the analysis orders and pairs points the engine returned.
 *
 * - A report names its snapshot, scope, every metric's formula version, query
 *   hash, coverage and all points. `verifyReportParity` fails when a report
 *   carries a different formula version or a truncated (top-N) point list.
 * - A ranking needs a declared task difficulty per point and ranks only points
 *   with a known value and complete coverage. Null stays null: an unknown value
 *   is never the cheapest.
 * - A comparison needs compatible series (same metric, versions, snapshot,
 *   window, grain; filters differ in one cohort dimension at most). It is always
 *   descriptive: only a B01 paired evaluation can label an improvement.
 */

import { ATOMIC_BY_ID, ATOMIC_METRICS } from "./metric-catalog.js";
import { METRIC_DESCRIPTIONS } from "./metric-descriptions.js";
import { compareTraceInstants, isRfc3339 } from "./trace-analysis.js";
import { OUTCOME_METRICS, SeriesRefusal, canonicalJson, queryHash, sha256, validateReadRequestV2, type Coverage, type GroupBy, type MetricSeriesV2, type QueryFilter, type QueryIdentity, type RefusalV2, type SeriesPoint, type WindowBasis } from "./metric-series.js";
import { projectQuery, readMetricSeries, readRequest, type ProjectSnapshot, type SourceDiagnostics } from "./project-read.js";

export const METRIC_REPORT_SCHEMA = "guild.benchmark.metric-report.v1" as const;
export const METRIC_REPORT_GENERATOR = "u04.metric-report.1" as const;
const EPOCH = "1970-01-01T00:00:00Z";
const isM28 = (id: string) => id.startsWith("M28.");

export interface MetricText { name: string; formula: string; scope: string; missingness: string }
export interface ServedEntry extends MetricText {
  state: "served"; metric_id: string; unit: string; unit_label: string; formula_version: string; query_hash: string;
  /** The pinned query: drilldown, analysis and compare requests reuse it unchanged. */
  query: QueryIdentity;
  window_basis: WindowBasis; usage_semantics: string; pricing: MetricSeriesV2["pricing"]; cost_bases: string[];
  coverage: Coverage; points: SeriesPoint[];
}
export interface RefusedEntry extends MetricText {
  state: "refused"; metric_id: string; unit: string; formula_version: string; refusal: { code: string; message: string };
}
export type ReportEntry = ServedEntry | RefusedEntry;
export interface MetricReport {
  schema_version: typeof METRIC_REPORT_SCHEMA; generator_version: string;
  snapshot: QueryIdentity["snapshot"];
  scope: { filters: QueryFilter[]; window: { from: string; to: string; basis: ReportBasis; timezone: "UTC" }; grain: string; group_by: GroupBy };
  sources: (SourceDiagnostics & { names: string[] })[];
  omissions: string[];
  metrics: ReportEntry[];
  report_hash: string;
}
/** A report window: the whole snapshot up to as_of, or an activity window [from,to). */
export type ReportBasis = "as_of_snapshot" | "activity_completed";
export interface ReportSpec {
  metric_ids?: string[]; filters?: QueryFilter[]; window?: { from: string; to: string; basis?: ReportBasis }; grain?: QueryIdentity["grain"]; group_by?: GroupBy;
}

/** Catalog text for a metric: what a reader needs to interpret the number. */
export function metricText(metricId: string): MetricText {
  const d = METRIC_DESCRIPTIONS[metricId];
  if (!d) return { name: metricId, formula: "not described in the catalog", scope: "unknown", missingness: "unknown" };
  return { name: d.family_name, formula: `${d.formula} (${d.family_formula})`, scope: d.dimensions, missingness: d.availability };
}

/**
 * The window basis a metric reads in this report: outcomes select by accepted terminal time
 * in the same [from,to); evaluation series (M28) are as_of inventories only; others use the
 * report's basis. Null: the metric cannot be read over this window.
 */
function basisFor(metricId: string, basis: ReportBasis): WindowBasis | null {
  if (OUTCOME_METRICS.has(metricId)) return "accepted_outcome_cohort";
  if (isM28(metricId)) return basis === "as_of_snapshot" ? "as_of_snapshot" : null;
  return basis;
}

/** Refuse a report scope the read service cannot serve, before any metric is read. */
function checkScope(snap: ProjectSnapshot, ids: readonly string[], scope: MetricReport["scope"]): void {
  if (ids.length === 0) throw new SeriesRefusal("invalid_request", "a report names at least one metric");
  const w = scope.window;
  if (!isRfc3339(w.from) || !isRfc3339(w.to)) throw new SeriesRefusal("invalid_request", "window from and to are RFC 3339 instants");
  if (compareTraceInstants(w.from, w.to) >= 0) throw new SeriesRefusal("invalid_request", "window from must precede to");
  if (w.basis === "as_of_snapshot" && (w.from !== EPOCH || w.to !== snap.facts.snapshot.as_of)) {
    throw new SeriesRefusal("invalid_request", "an as_of_snapshot report reads the whole snapshot up to as_of; use activity_completed for a [from,to) window");
  }
  // Shape only: whether a metric serves these filters is that metric's own refusal.
  const bare = projectQuery(snap, { metric_id: "M01.run_count", grain: scope.grain as QueryIdentity["grain"], window: { from: w.from, to: w.to, basis: w.basis } });
  const v = validateReadRequestV2(readRequest({ ...bare, filters: scope.filters }, "metric_series", { request_id: "metric-report", session_id: "benchmark" }));
  if (!v.ok) throw new SeriesRefusal("invalid_request", v.errors.join("; ").slice(0, 400));
}

const isRefusal = (x: unknown): x is RefusalV2 => (x as RefusalV2)?.schema_version === "guild.stack.refusal.v2";

/** One series through the read service, exactly as POST /api/project/metrics/series serves it. */
export function serveSeries(snap: ProjectSnapshot, spec: { metric_id: string; filters?: QueryFilter[]; window?: { from: string; to: string; basis: WindowBasis }; grain?: QueryIdentity["grain"] }, groupBy: GroupBy): MetricSeriesV2 | RefusalV2 | { code: string; message: string } {
  let q: QueryIdentity;
  try { q = projectQuery(snap, spec); } catch (err) {
    if (err instanceof SeriesRefusal) return { code: err.code, message: err.message };
    throw err;
  }
  return readMetricSeries(snap, readRequest(q, "metric_series", { request_id: "metric-report", session_id: "benchmark" }), { group_by: groupBy });
}

/** Build the exported report over one snapshot, one filter set and one [from,to) window. */
export function buildMetricReport(snap: ProjectSnapshot, names: Record<string, string[]>, spec: ReportSpec = {}): MetricReport {
  const asOf = snap.facts.snapshot.as_of;
  const ids = spec.metric_ids ?? ATOMIC_METRICS.map((m) => m.id);
  const basis: ReportBasis = spec.window?.basis ?? (spec.window ? "activity_completed" : "as_of_snapshot");
  const window = { from: spec.window?.from ?? EPOCH, to: spec.window?.to ?? asOf };
  const groupBy = spec.group_by ?? "all";
  const grain = spec.grain ?? "run";
  const filters = (spec.filters ?? []).map((f) => ({ dimension: f.dimension, values: [...f.values].sort() })).sort((a, b) => (a.dimension < b.dimension ? -1 : 1));
  const scope = { filters, window: { ...window, basis, timezone: "UTC" as const }, grain, group_by: groupBy };
  checkScope(snap, ids, scope);
  const metrics: ReportEntry[] = [];
  for (const id of ids) {
    const m = ATOMIC_BY_ID.get(id);
    if (!m) throw new SeriesRefusal("unsupported_capability", `metric ${id} is not in the C9 catalog`);
    const text = metricText(id);
    if (id === "M29.series_value") {
      metrics.push({ state: "refused", metric_id: id, unit: m.unit, formula_version: m.formula_version, ...text, refusal: { code: "invalid_request", message: "M29 is an alias; a report names its underlying scalar metric" } });
      continue;
    }
    const metricBasis = basisFor(id, basis);
    if (metricBasis === null) {
      metrics.push({ state: "refused", metric_id: id, unit: m.unit, formula_version: m.formula_version, ...text, refusal: { code: "invalid_request", message: "evaluation series are as_of_snapshot inventories; this report reads an activity window" } });
      continue;
    }
    const out = serveSeries(snap, { metric_id: id, filters, window: { ...window, basis: metricBasis }, grain }, groupBy);
    if (!("schema_version" in out) || isRefusal(out)) {
      metrics.push({ state: "refused", metric_id: id, unit: m.unit, formula_version: m.formula_version, ...text, refusal: { code: out.code, message: out.message } });
      continue;
    }
    metrics.push({
      state: "served", metric_id: id, ...text, unit: out.unit, unit_label: out.unit_label, formula_version: out.query.versions.formula,
      query_hash: queryHash(out.query), query: out.query, window_basis: out.query.window.basis, usage_semantics: out.usage_semantics, pricing: out.pricing,
      cost_bases: [...new Set(out.points.map((p) => p.cost_basis))].sort(), coverage: out.coverage, points: out.points,
    });
  }
  const sources = snap.diagnostics.map((d) => ({ ...d, names: names[d.source_id] ?? [] }));
  const omissions: string[] = sources.flatMap((s) => sourceOmissions(s, s.names));
  const refused = metrics.filter((e) => e.state === "refused").map((e) => e.metric_id);
  if (refused.length) omissions.push(`${refused.length} metric(s) refused for this scope: ${refused.join(", ")}`);
  const partial = metrics.filter((e): e is ServedEntry => e.state === "served" && e.coverage.state !== "complete").map((e) => e.metric_id);
  if (partial.length) omissions.push(`${partial.length} metric(s) with incomplete coverage: ${partial.join(", ")}`);
  const body = {
    schema_version: METRIC_REPORT_SCHEMA, generator_version: METRIC_REPORT_GENERATOR, snapshot: snap.facts.snapshot,
    // Source disclosures are never truncated: parity requires every one.
    scope, sources, omissions, metrics,
  };
  return { ...body, report_hash: sha256(canonicalJson(body)) };
}

/** The omissions a source's diagnostics require a report to disclose. */
function sourceOmissions(s: SourceDiagnostics, names: readonly string[]): string[] {
  const out: string[] = [];
  if (s.state !== "available") out.push(`source ${s.source_id} (${names.join(", ") || "unnamed"}) unavailable: ${s.reason ?? "no reason recorded"}`);
  if (s.run_errors.length) out.push(`source ${s.source_id}: ${s.run_errors.length} run(s) could not be read`);
  if (s.runs_without_trace) out.push(`source ${s.source_id}: ${s.runs_without_trace} run(s) without a retained trace`);
  return out;
}

export type Verdict = { ok: true } | { ok: false; errors: string[] };

/** What a report must reconcile against: the series the service served for the same request. */
export interface ParityExpectation {
  metric_ids: readonly string[]; group_by: GroupBy;
  /** The snapshot and scope the report was requested over (independent of any served entry). */
  snapshot: QueryIdentity["snapshot"];
  scope: { filters: QueryFilter[]; window: { from: string; to: string; basis: ReportBasis }; grain: string };
  /** Source diagnostics of the same snapshot (POST /api/project/metrics/query returns them). */
  sources: readonly SourceDiagnostics[];
}

/**
 * Report ↔ chart parity: the report names every requested metric, every snapshot source
 * with its state, and each served entry equals the series the read service returns for
 * it (same formula version, query, unit, coverage and every point). A metric the service
 * serves cannot be exported as refused; an unavailable source must stay listed.
 */
export function verifyReportParity(report: MetricReport, series: readonly MetricSeriesV2[], expected: ParityExpectation): Verdict {
  const errors: string[] = [];
  const { report_hash, ...body } = report;
  if (sha256(canonicalJson(body)) !== report_hash) errors.push("report_hash does not match the report body");
  if (canonicalJson(report.metrics.map((m) => m.metric_id)) !== canonicalJson(expected.metric_ids)) errors.push("report metrics differ from the requested metric list");
  if (report.scope.group_by !== expected.group_by) errors.push(`report grouping ${report.scope.group_by} is not the requested ${expected.group_by}`);
  if (canonicalJson(report.snapshot) !== canonicalJson(expected.snapshot)) errors.push("report snapshot differs from the requested snapshot");
  const sortedFilters = (fs: readonly QueryFilter[]) => fs.map((f) => ({ dimension: f.dimension, values: [...f.values].sort() })).sort((a, b) => (a.dimension < b.dimension ? -1 : 1));
  const w = report.scope.window, ew = expected.scope.window;
  if (canonicalJson(report.scope.filters) !== canonicalJson(sortedFilters(expected.scope.filters)) || report.scope.grain !== expected.scope.grain || w.from !== ew.from || w.to !== ew.to || w.basis !== ew.basis || w.timezone !== "UTC") {
    errors.push("report scope (filters, grain or window) differs from the requested scope");
  }
  for (const d of expected.sources) {
    const r = report.sources.find((x) => x.source_id === d.source_id);
    if (!r) errors.push(`source ${d.source_id} is missing from the report`);
    else {
      const { names: _n, ...diag } = r;
      if (canonicalJson(diag) !== canonicalJson(d)) errors.push(`source ${d.source_id} diagnostics differ from the snapshot`);
    }
    for (const o of sourceOmissions(d, r?.names ?? [])) if (!report.omissions.includes(o)) errors.push(`source ${d.source_id} omission not disclosed: ${o}`);
  }
  if (report.sources.length !== expected.sources.length) errors.push("report lists sources outside the snapshot");
  for (const e of report.metrics) {
    const cat = ATOMIC_BY_ID.get(e.metric_id);
    if (!cat) { errors.push(`${e.metric_id}: not a catalog metric`); continue; }
    const text = metricText(e.metric_id);
    if (e.name !== text.name || e.formula !== text.formula || e.scope !== text.scope || e.missingness !== text.missingness) errors.push(`${e.metric_id}: exported name, formula, scope or missingness text differs from the catalog`);
    if (e.formula_version !== cat.formula_version) errors.push(`${e.metric_id}: report formula_version ${e.formula_version} is not the catalog version ${cat.formula_version}`);
    const s = series.find((x) => x.metric_id === e.metric_id);
    if (e.state !== "served") {
      if (s) errors.push(`${e.metric_id}: exported as refused but the service serves it`);
      continue;
    }
    if (!s) { errors.push(`${e.metric_id}: no served series to reconcile`); continue; }
    const q = s.query;
    if (canonicalJson(q.filters) !== canonicalJson(report.scope.filters) || q.grain !== report.scope.grain || q.window.from !== report.scope.window.from || q.window.to !== report.scope.window.to) {
      errors.push(`${e.metric_id}: report scope (filters, grain or window) differs from the series query`);
    }
    if (e.formula_version !== s.query.versions.formula) errors.push(`${e.metric_id}: report formula_version ${e.formula_version} differs from the series ${s.query.versions.formula}`);
    if (e.query_hash !== queryHash(s.query) || canonicalJson(e.query) !== canonicalJson(s.query)) errors.push(`${e.metric_id}: report query or query_hash differs from the series query`);
    if (canonicalJson(s.query.snapshot) !== canonicalJson(report.snapshot)) errors.push(`${e.metric_id}: series snapshot differs from the report snapshot`);
    if (e.unit !== s.unit || e.unit_label !== s.unit_label) errors.push(`${e.metric_id}: unit ${e.unit} (${e.unit_label}) differs from ${s.unit} (${s.unit_label})`);
    const basis = basisFor(e.metric_id, report.scope.window.basis);
    if (e.window_basis !== q.window.basis || basis !== q.window.basis) errors.push(`${e.metric_id}: window basis ${e.window_basis} (report ${report.scope.window.basis}) differs from the series ${q.window.basis}`);
    if (e.usage_semantics !== s.usage_semantics) errors.push(`${e.metric_id}: usage semantics differ from the series`);
    if (canonicalJson(e.pricing) !== canonicalJson(s.pricing)) errors.push(`${e.metric_id}: pricing provenance differs from the series`);
    if (canonicalJson(e.cost_bases) !== canonicalJson([...new Set(s.points.map((p) => p.cost_basis))].sort())) errors.push(`${e.metric_id}: cost bases differ from the series points`);
    if (canonicalJson(e.coverage) !== canonicalJson(s.coverage)) errors.push(`${e.metric_id}: coverage differs from the series`);
    if (e.points.length !== s.points.length) errors.push(`${e.metric_id}: report has ${e.points.length} points, the series ${s.points.length} (top-N or partial export)`);
    else if (canonicalJson(e.points) !== canonicalJson(s.points)) errors.push(`${e.metric_id}: report points differ from the series points`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ── Human analysis (AT46) ────────────────────────────────────────────────────

export interface RankedEntry { key: string; value: number; rank: number }
export interface UnrankedEntry { key: string; value: number | null; reason: string }
export interface Ranking {
  metric_id: string; unit: string; direction: "asc" | "desc"; ranked: boolean; reason: string | null;
  strata: { difficulty: string; entries: RankedEntry[] }[];
  unranked: UnrankedEntry[];
}

/**
 * Rank a series' points within declared task-difficulty strata. A point without a
 * declared difficulty, a null value, incomplete coverage or an unattributed key is
 * listed as unranked with its reason. No declared difficulty at all: no ranking.
 */
export function rankSeries(series: MetricSeriesV2, opts: { direction: "asc" | "desc"; difficulty?: Record<string, string | null> }): Ranking {
  const declared = opts.difficulty ?? {};
  const base = { metric_id: series.metric_id, unit: series.unit, direction: opts.direction };
  const unranked: UnrankedEntry[] = [];
  const strata = new Map<string, RankedEntry[]>();
  for (const p of series.points) {
    const d = declared[p.key];
    if (p.value === null) unranked.push({ key: p.key, value: null, reason: `value unknown: ${p.reason ?? p.coverage.reason ?? "no reason recorded"}` });
    else if (p.coverage.state !== "complete") unranked.push({ key: p.key, value: p.value, reason: `coverage ${p.coverage.state}: ${p.coverage.reason ?? "incomplete"}` });
    else if (p.key === "unattributed") unranked.push({ key: p.key, value: p.value, reason: "records without this dimension are not a cohort" });
    else if (typeof d !== "string" || d.length === 0) unranked.push({ key: p.key, value: p.value, reason: "no declared task difficulty" });
    else {
      const xs = strata.get(d) ?? [];
      xs.push({ key: p.key, value: p.value, rank: 0 });
      strata.set(d, xs);
    }
  }
  const sign = opts.direction === "asc" ? 1 : -1;
  const out = [...strata.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([difficulty, xs]) => {
    xs.sort((a, b) => sign * (a.value - b.value) || (a.key < b.key ? -1 : 1));
    // Competition ranking: equal values share a rank.
    xs.forEach((x, i) => { x.rank = i > 0 && xs[i - 1]!.value === x.value ? xs[i - 1]!.rank : i + 1; });
    return { difficulty, entries: xs };
  });
  const anyDeclared = series.points.some((p) => typeof declared[p.key] === "string" && declared[p.key] !== "");
  return {
    ...base, ranked: out.length > 0,
    reason: out.length > 0 ? null : anyDeclared ? "no point with a declared difficulty has a known value and complete coverage" : "no declared task difficulty: ranking withheld (no unqualified leaderboard)",
    strata: out, unranked,
  };
}

export interface CohortComparison {
  compatible: boolean; incompatibilities: string[];
  /** Always descriptive: a cohort difference is observational, never a causal gain. */
  label: "descriptive_only" | "refused"; causal: false; statement: string;
  a: { key: string; value: number | null; coverage: Coverage; cost_basis: string } | null;
  b: { key: string; value: number | null; coverage: Coverage; cost_basis: string } | null;
  difference: number | null; difference_reason: string | null; unit: string;
}

const pointOf = (s: MetricSeriesV2, key: string) => s.points.find((p) => p.key === key) ?? null;

/**
 * Compare two cohort points. Series must be compatible and vary in one cohort dimension:
 * either one filter, or the grouping key under one shared grouping. The difference is b − a
 * of returned values.
 */
export function compareCohorts(a: { series: MetricSeriesV2; key: string; group_by: GroupBy }, b: { series: MetricSeriesV2; key: string; group_by: GroupBy }): CohortComparison {
  const inc: string[] = [];
  const qa = a.series.query, qb = b.series.query;
  if (a.series.metric_id !== b.series.metric_id || a.series.underlying_metric_id !== b.series.underlying_metric_id) inc.push("different metrics");
  if (a.series.unit !== b.series.unit) inc.push("different units");
  for (const k of ["schema", "analyzer", "normalizer", "formula", "usage_semantics", "pricing", "aggregation"] as const) if (qa.versions[k] !== qb.versions[k]) inc.push(`${k} version differs`);
  if (canonicalJson(qa.snapshot) !== canonicalJson(qb.snapshot)) inc.push("different snapshots");
  if (canonicalJson(qa.window) !== canonicalJson(qb.window)) inc.push("different windows");
  if (qa.grain !== qb.grain) inc.push("different grains");
  const dims = new Set([...qa.filters, ...qb.filters].map((f) => f.dimension));
  // Every filter on a dimension is part of its constraint (a dimension may repeat).
  const constraint = (q: QueryIdentity, d: string) => q.filters.filter((f) => f.dimension === d).map((f) => canonicalJson(f.values)).sort();
  const differing = [...dims].filter((d) => canonicalJson(constraint(qa, d)) !== canonicalJson(constraint(qb, d)));
  if (a.group_by !== b.group_by) inc.push(`different groupings (${a.group_by} vs ${b.group_by})`);
  else if (a.group_by !== "all" && a.key !== b.key && !differing.includes(a.group_by)) differing.push(a.group_by);
  if (differing.length > 1) inc.push(`cohorts differ in ${differing.length} dimensions (${differing.join(", ")}); a cohort comparison varies one`);
  const pa = pointOf(a.series, a.key), pb = pointOf(b.series, b.key);
  if (!pa) inc.push(`no point ${a.key}`);
  if (!pb) inc.push(`no point ${b.key}`);
  if (pa && pb && queryHash(qa) === queryHash(qb) && a.key === b.key) inc.push("a cohort is not compared with itself");
  if (pa?.key === "unattributed" || pb?.key === "unattributed") inc.push("records without this dimension are not a cohort");
  const view = (p: SeriesPoint | null) => (p ? { key: p.key, value: p.value, coverage: p.coverage, cost_basis: p.cost_basis } : null);
  const unit = a.series.unit;
  if (inc.length) {
    return { compatible: false, incompatibilities: inc, label: "refused", causal: false, statement: "Not comparable: " + inc.join("; "), a: view(pa), b: view(pb), difference: null, difference_reason: "not comparable", unit };
  }
  let reason: string | null = null;
  if (pa!.value === null || pb!.value === null) reason = "a cohort value is unknown";
  else if (pa!.coverage.state !== "complete" || pb!.coverage.state !== "complete") reason = "a cohort has incomplete coverage";
  else if (pa!.cost_basis !== pb!.cost_basis) reason = `cost bases differ (${pa!.cost_basis} vs ${pb!.cost_basis})`;
  return {
    compatible: true, incompatibilities: [], label: "descriptive_only", causal: false,
    statement: "Observational difference between cohorts. It is not a causal gain: cohorts can differ in tasks, hosts, models and revisions. Only a paired evaluation can label an improvement.",
    a: view(pa), b: view(pb), difference: reason === null ? pb!.value! - pa!.value! : null, difference_reason: reason, unit,
  };
}
