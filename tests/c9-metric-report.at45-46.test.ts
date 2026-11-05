/**
 * U04 · AT45 (chart/report parity) and AT46 (human analysis) over the C9 read
 * service: POST /api/project/metrics/{report,series,drilldown,analysis,compare}
 * on a workspace with multi-host, multi-model, multi-revision cohorts, an
 * outlier, a null-usage request, a zero-denominator cohort and an offline source.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/server.js";
import { canonicalSourceId } from "../src/c9/source-identity.js";
import { openProjectSnapshot, readRequest, type SourceDiagnostics } from "../src/c9/project-read.js";
import { ATOMIC_METRICS } from "../src/c9/metric-catalog.js";
import { METRIC_DESCRIPTIONS } from "../src/c9/metric-descriptions.js";
import { buildMetricReport, compareCohorts, rankSeries, verifyReportParity, type MetricReport, type ServedEntry } from "../src/c9/metric-report.js";
import { canonicalJson, sha256, validateMetricSeriesV2, type MetricDrilldownV2, type MetricSeriesV2, type QueryIdentity } from "../src/c9/metric-series.js";
import type { TraceAnalysisV3, TraceCoverage, TraceUsage } from "../src/c9/trace-analysis.js";

const COMPLETE: TraceCoverage = { eligible: 1, covered: 1, excluded: 0, missing: 0, state: "complete", reason: null, exclusion_reasons: [] };
const LOST: TraceCoverage = { eligible: 1, covered: 0, excluded: 0, missing: 1, state: "unavailable", reason: "host did not report usage", exclusion_reasons: [] };
const AS_OF = "2026-10-26T01:00:00Z";
const HEADERS = { host: "127.0.0.1:3055", "content-type": "application/json" };
const REV = { r1: `sha256:${"1".repeat(64)}`, r2: `sha256:${"2".repeat(64)}` };
const H = `sha256:${"a".repeat(64)}`;
const EPOCH = "1970-01-01T00:00:00Z";

function use(acct: string, input: number | null, output: number | null, cacheRead = 0): TraceUsage {
  const lost = input === null;
  return {
    granularity: "leaf_request", observation_id: `obs-${acct}`, revision: 1, final: true, accounting_identity: acct,
    parent_accounting_identity: null, inclusion: "leaf_exclusive", input_inclusive: input, output, cache_read_subset: lost ? null : cacheRead,
    cache_write_subset: lost ? null : 0, total: lost ? null : input + (output ?? 0), cost_usd: null, cost_basis: "unavailable", currency: "USD", pricing_version: null,
    usage_semantics: lost ? "unknown" : "inclusive_input_cache_subset.v1", coverage: lost ? LOST : COMPLETE, native_baseline_usd: null, native_cumulative_usd: null,
  };
}
let seq = 0;
interface Rec { n: number; acct: string; input: number | null; output: number | null; host: string | null; model: string; rev: string; initiative: string | null; cacheRead?: number }
function ev(source: string, run: string, r: Rec): TraceAnalysisV3 {
  return {
    schema_version: "guild.trace.analysis.v3", event_id: `record-${String(r.n).padStart(3, "0")}`, sequence: seq++, event_class: "request_completed",
    at: new Date(Date.parse("2026-10-26T00:00:00Z") + r.n * 1000).toISOString(),
    lineage: { source_id: source, run_id: run, execution_id: "exec-1", host_session_id: r.host, initiative_id: r.initiative, goal_id: null, logical_task_id: null, attempt_id: null, agent_instance_id: null, request_id: r.acct },
    operation_id: null, component_invocation_id: null, actor_id: "agent-1", pins: { assignment: H, definition: H, configuration: H, workflow: r.rev, policy: H },
    requested_model: r.model, observed_identity: { provider: "provider", model: r.model, status: "observed", reason: null },
    usage: use(r.acct, r.input, r.output, r.cacheRead ?? 0), payload_ref: null, prompt_hash: null, redaction_version: "guild.trace-scrub.v1", capture: COMPLETE, interval: null,
  };
}
const jsonl = (events: TraceAnalysisV3[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

let root = "";
function put(sub: string, rel: string, body: string): void {
  const p = path.join(root, sub, ".guild", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const sid = (sub: string) => canonicalSourceId(path.join(root, sub));
/**
 * Source a: run-1 (initiative init-1, host-claude, model-x, rev r1: 3 requests) and run-2
 * (initiative init-1, host-codex, rev r2: a model-y 900-output outlier, a model-y request
 * whose host reported no usage, and a model-w request with no usage at all). Source b: run-1 (no initiative, host-claude, model-z, rev r1,
 * zero input tokens). Source offline: configured, never created.
 */
function fixture(offline = true): void {
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  const subs = [{ name: "source-a", path: "a" }, { name: "source-b", path: "b" }, ...(offline ? [{ name: "offline", path: "gone" }] : [])];
  fs.writeFileSync(path.join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: subs }));
  const a1: Rec[] = [1, 2, 3].map((n) => ({ n, acct: `a1-req-${n}`, input: 10, output: 5, host: "host-claude", model: "model-x", rev: REV.r1, initiative: "init-1", cacheRead: 4 }));
  const a2: Rec[] = [
    { n: 4, acct: "a2-req-1", input: 20, output: 900, host: "host-codex", model: "model-y", rev: REV.r2, initiative: "init-1" },
    { n: 5, acct: "a2-req-2", input: null, output: null, host: "host-codex", model: "model-y", rev: REV.r2, initiative: "init-1" },
    { n: 7, acct: "a2-req-3", input: null, output: null, host: "host-codex", model: "model-w", rev: REV.r2, initiative: "init-1" },
  ];
  const b1: Rec[] = [{ n: 6, acct: "b1-req-1", input: 0, output: 2, host: "host-claude", model: "model-z", rev: REV.r1, initiative: null }];
  put("a", "runs/run-1/trace.jsonl", jsonl(a1.map((r) => ev(sid("a"), "run-1", r))));
  put("a", "runs/run-2/trace.jsonl", jsonl(a2.map((r) => ev(sid("a"), "run-2", r))));
  put("b", "runs/run-1/trace.jsonl", jsonl(b1.map((r) => ev(sid("b"), "run-1", r))));
}

const app = (): Hono => createApp({ runsDir: path.join(root, "bench-runs"), casesDir: path.join(root, "cases"), port: 0, projectRoot: root });
async function post(a: Hono, route: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await a.fetch(new Request(`http://127.0.0.1:3055/api/project/metrics/${route}`, { method: "POST", headers: HEADERS, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function pinned(a: Hono, spec: Record<string, unknown>): Promise<QueryIdentity> {
  return (await pinnedWithSources(a, spec)).query;
}
async function pinnedWithSources(a: Hono, spec: Record<string, unknown>): Promise<{ query: QueryIdentity; diagnostics: SourceDiagnostics[] }> {
  const r = await post(a, "query", { as_of: AS_OF, ...spec });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}
const sreq = (q: QueryIdentity) => readRequest(q, "metric_series", { request_id: "u04-1", session_id: "ui-session-1" });
const dreq = (q: QueryIdentity, cursor: string | null = null) => readRequest(q, "metric_drilldown", { request_id: "u04-2", session_id: "ui-session-1", cursor });
async function series(a: Hono, spec: Record<string, unknown>, group_by = "all"): Promise<MetricSeriesV2> {
  const q = await pinned(a, spec);
  const r = await post(a, "series", { request: sreq(q), group_by });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}
const served = (r: MetricReport, id: string) => r.metrics.find((m) => m.metric_id === id) as ServedEntry;
const point = (s: MetricSeriesV2 | ServedEntry, key: string) => s.points.find((p) => p.key === key)!;

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-u04-"))); seq = 0; });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("U04 · AT45 metric text", () => {
  it("every catalog metric has a name, formula, scope and missingness copied from A02", () => {
    const vendored = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/c9-a02/metric-catalog-descriptions.json"), "utf8")).atomic_descriptions as { id: string }[];
    expect(vendored.map((d) => d.id)).toEqual(ATOMIC_METRICS.map((m) => m.id));
    for (const d of vendored as ({ id: string } & Record<string, string>)[]) {
      const { id, ...text } = d;
      expect(METRIC_DESCRIPTIONS[id]).toEqual(text);
      for (const v of Object.values(text)) expect(v.length).toBeGreaterThan(0);
    }
  });
});


describe("U04 · AT45 report ↔ chart parity", () => {
  it("one report covers every catalog metric with text, unit, coverage and cost basis; unknown stays null", async () => {
    fixture();
    const r = await post(app(), "report", { as_of: AS_OF });
    expect(r.status).toBe(200);
    const rep = r.json as MetricReport;
    expect(rep.metrics.map((m) => m.metric_id)).toEqual(ATOMIC_METRICS.map((m) => m.id));
    for (const m of rep.metrics) {
      for (const k of ["name", "formula", "scope", "missingness", "unit", "formula_version"] as const) expect((m as any)[k], `${m.metric_id}.${k}`).toMatch(/\S/);
      if (m.state === "refused") { expect(m.refusal.message).toMatch(/\S/); continue; }
      expect(m.cost_bases.length, m.metric_id).toBeGreaterThan(0);
      expect(m.query_hash).toMatch(/^sha256:/);
      for (const p of m.points) {
        expect(p.drilldown.query_hash).toBe(m.query_hash);
        // Missing is never zero: a null value always carries a reason.
        if (p.value === null) expect(p.reason ?? p.coverage.reason, `${m.metric_id}:${p.key}`).toMatch(/\S/);
      }
    }
    // Uncollected and offline-affected values stay null, not 0.
    expect(point(served(rep, "M02.elapsed_ms"), "all").value).toBeNull();
    expect(point(served(rep, "M05.sample_count"), "all").value).toBeNull();
    expect(point(served(rep, "M12.eligible_count"), "all").value).toBeNull();
    expect(served(rep, "M07.output_tokens").coverage.state).toBe("partial");
    // The offline source is listed, not hidden.
    expect(rep.sources.find((s) => s.names.includes("offline"))).toMatchObject({ state: "unavailable" });
    expect(rep.omissions.join("\n")).toMatch(/offline\) unavailable/);
    expect(rep.metrics.find((m) => m.metric_id === "M10.derived_estimate_usd")).toMatchObject({ state: "refused", refusal: { code: "input_unavailable" } });
  });

  it("a zero denominator is null with a reason, never 0 or NaN", async () => {
    fixture(false);
    const s = await series(app(), { metric_id: "M08.cache_hit_ratio" }, "source");
    const b = point(s, sid("b"));
    expect(b.value).toBeNull();
    expect(b.denominator ?? 0).toBe(0);
    expect(b.reason).toMatch(/\S/);
    expect(point(s, sid("a")).value).toBeCloseTo(12 / 50);
  });

  it("every served report entry equals the series endpoint; altered formula version, top-N or edited values fail", async () => {
    fixture();
    const a = app();
    const rep = (await post(a, "report", { as_of: AS_OF, group_by: "source" })).json as MetricReport;
    const all: MetricSeriesV2[] = [];
    for (const e of rep.metrics) {
      if (e.state !== "served") continue;
      const s = await series(a, { metric_id: e.metric_id, window: { ...rep.scope.window, basis: e.window_basis } }, "source");
      expect(validateMetricSeriesV2(s)).toEqual({ ok: true });
      all.push(s);
    }
    expect(all.length).toBeGreaterThan(90);
    const pin = await pinnedWithSources(a, { metric_id: "M01.run_count" });
    const expected = { metric_ids: ATOMIC_METRICS.map((m) => m.id), group_by: "source" as const, sources: pin.diagnostics, snapshot: pin.query.snapshot, scope: { filters: [], window: { from: EPOCH, to: AS_OF, basis: "as_of_snapshot" as const }, grain: "run" } };
    expect(expected.sources.some((d) => d.state === "unavailable")).toBe(true);
    expect(verifyReportParity(rep, all, expected)).toEqual({ ok: true });
    const rehash = (x: MetricReport): MetricReport => { const { report_hash: _h, ...body } = x; return { ...body, report_hash: sha256(canonicalJson(body)) }; };
    const edit = (f: (e: ServedEntry) => ServedEntry, id = "M07.output_tokens") => rehash({ ...rep, metrics: rep.metrics.map((e) => (e.metric_id === id ? f(e as ServedEntry) : e)) });
    // Negative control 1: a report with another formula version.
    const v = verifyReportParity(edit((e) => ({ ...e, formula_version: "proposed:m07.output_tokens.2" })), all, expected);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).toMatch(/formula_version/);
    // Negative control 2: a top-N aggregation (largest point only).
    const top = verifyReportParity(edit((e) => ({ ...e, points: [...e.points].sort((x, y) => (y.value ?? -1) - (x.value ?? -1)).slice(0, 1) })), all, expected);
    expect(top.ok).toBe(false);
    expect(JSON.stringify(top)).toMatch(/top-N/);
    // Negative control 3: a value edited in the export.
    const edited = verifyReportParity(edit((e) => ({ ...e, points: e.points.map((p) => ({ ...p, value: p.value === null ? 0 : p.value + 1 })) })), all, expected);
    expect(edited.ok).toBe(false);
    // Negative control 4: a body changed without a new hash.
    expect(verifyReportParity({ ...rep, omissions: [] }, all, expected).ok).toBe(false);
    // Negative control 5: a stale (unavailable) source hidden from the export, rehashed.
    const hidden = verifyReportParity(rehash({ ...rep, sources: rep.sources.filter((x) => x.state === "available"), omissions: rep.omissions.filter((o) => !/unavailable:/.test(o)) }), all, expected);
    expect(hidden.ok).toBe(false);
    expect(JSON.stringify(hidden)).toMatch(/missing from the report/);
    // Negative control 6: a served metric exported as refused.
    const refused = rehash({ ...rep, metrics: rep.metrics.map((e) => (e.metric_id === "M07.output_tokens" ? { state: "refused", metric_id: e.metric_id, name: e.name, formula: e.formula, scope: e.scope, missingness: e.missingness, unit: e.unit, formula_version: e.formula_version, refusal: { code: "x", message: "x" } } : e)) });
    expect(JSON.stringify(verifyReportParity(refused, all, expected))).toMatch(/exported as refused/);
    // Negative control 7: relabelled scope or grouping, and a dropped metric.
    expect(verifyReportParity(rehash({ ...rep, scope: { ...rep.scope, filters: [{ dimension: "initiative", values: ["init-1"] }] } }), all, expected).ok).toBe(false);
    expect(verifyReportParity(rehash({ ...rep, scope: { ...rep.scope, group_by: "host" } }), all, expected).ok).toBe(false);
    expect(verifyReportParity(rehash({ ...rep, metrics: rep.metrics.slice(1) }), all, expected).ok).toBe(false);
    // Negative control 8: relabelled window basis and forged provenance fields.
    expect(verifyReportParity(rehash({ ...rep, scope: { ...rep.scope, window: { ...rep.scope.window, basis: "activity_completed" } } }), all, expected).ok).toBe(false);
    for (const forge of [
      (e: ServedEntry) => ({ ...e, window_basis: "activity_completed" as const }),
      (e: ServedEntry) => ({ ...e, unit_label: "thousand tokens" }),
      (e: ServedEntry) => ({ ...e, usage_semantics: "provider_session_only.v1" }),
      (e: ServedEntry) => ({ ...e, cost_bases: ["measured"] }),
      (e: ServedEntry) => ({ ...e, pricing: { version: "forged", currency: "USD" as const, source_hash: `sha256:${"0".repeat(64)}` } }),
      (e: ServedEntry) => ({ ...e, formula: "average(output_tokens)" }),
    ]) expect(verifyReportParity(edit(forge), all, expected).ok).toBe(false);
    // Negative control 9: forged source diagnostics (a run without trace hidden).
    const forgedSource = rehash({ ...rep, sources: rep.sources.map((x, i) => (i === 0 ? { ...x, runs_without_trace: x.runs_without_trace + 1 } : x)) });
    expect(JSON.stringify(verifyReportParity(forgedSource, all, expected))).toMatch(/diagnostics differ/);
  });

  it("an activity window is applied, not widened to the whole snapshot", async () => {
    fixture(false);
    const a = app();
    const window = { from: "2026-10-26T00:00:05Z", to: AS_OF };
    const r = await post(a, "report", { as_of: AS_OF, metric_ids: ["M07.output_tokens", "M14.outcome_count", "M28.pair_count"], window });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rep = r.json as MetricReport;
    expect(rep.scope.window).toMatchObject({ ...window, basis: "activity_completed" });
    const e = served(rep, "M07.output_tokens");
    expect(e.window_basis).toBe("activity_completed");
    const s = await series(a, { metric_id: "M07.output_tokens", window: { ...window, basis: "activity_completed" } });
    expect(e.points).toEqual(s.points);
    // Only record 6 (source b, 2 output tokens) completes in the window; the whole snapshot is 917.
    expect(point(s, "all").known_subtotal).toBe(2);
    expect(served(rep, "M14.outcome_count").window_basis).toBe("accepted_outcome_cohort");
    expect(rep.metrics.find((m) => m.metric_id === "M28.pair_count")).toMatchObject({ state: "refused", refusal: { message: expect.stringMatching(/as_of_snapshot inventories/) } });
    // An as_of_snapshot report cannot carry a lower bound it would ignore.
    const bad = await post(a, "report", { as_of: AS_OF, window: { ...window, basis: "as_of_snapshot" } });
    expect(bad.status).toBe(400);
  });

  it("report requests are validated before any metric is read", async () => {
    fixture(false);
    const a = app();
    expect((await post(a, "report", { as_of: AS_OF, metric_ids: [] })).status).toBe(400);
    expect((await post(a, "report", { as_of: AS_OF, grain: "invalid" })).status).toBe(400);
    expect((await post(a, "report", { as_of: AS_OF, window: { from: "nonsense", to: "also-invalid", basis: "activity_completed" } })).status).toBe(400);
    expect((await post(a, "report", { as_of: AS_OF, window: { from: AS_OF, to: "2026-10-26T00:00:00Z", basis: "activity_completed" } })).status).toBe(400);
    expect((await post(a, "report", { as_of: AS_OF, metric_ids: ["M99.nope"] })).status).toBe(422);
    // An evaluation-only filter is a per-metric refusal, not a refused report.
    const ev = await post(a, "report", { as_of: AS_OF, metric_ids: ["M28.pair_count", "M07.output_tokens"], filters: [{ dimension: "case", values: ["case-1"] }] });
    expect(ev.status).toBe(200);
    expect((ev.json as MetricReport).metrics.map((m) => [m.metric_id, m.state])).toEqual([["M28.pair_count", "served"], ["M07.output_tokens", "refused"]]);
  });

  it("overview → initiative → run → request evidence reconciles with the exported report", async () => {
    fixture(false);
    const a = app();
    const overview = await series(a, { metric_id: "M07.output_tokens" });
    expect(point(overview, "all").value).toBe(5 * 3 + 900 + 2);
    const init = { filters: [{ dimension: "initiative", values: ["init-1"] }] };
    const initiative = await series(a, { metric_id: "M07.output_tokens", ...init });
    expect(point(initiative, "all").value).toBe(915);
    const runs = await series(a, { metric_id: "M07.output_tokens", ...init }, "run");
    expect(runs.points.map((p) => [p.key, p.value])).toEqual([[`${sid("a")}:run-1`, 15], [`${sid("a")}:run-2`, 900]]);
    // Run points are known subtotals of the initiative point.
    expect(runs.points.reduce((x, p) => x + (p.known_subtotal ?? 0), 0)).toBe(point(initiative, "all").known_subtotal);
    const run2 = point(runs, `${sid("a")}:run-2`);
    const q = runs.query;
    const d = await post(a, "drilldown", { request: dreq(q), point_key: run2.key, group_by: "run" });
    expect(d.status).toBe(200);
    const page = d.json as MetricDrilldownV2;
    expect(page.query_hash).toBe(run2.drilldown.query_hash);
    expect(page.records).toHaveLength(3);
    expect(page.records.every((e) => e.source_id === sid("a") && e.path === "runs/run-2/trace.jsonl")).toBe(true);
    expect(page.records).toEqual(run2.evidence);
    // The export with the same scope carries the same values and drilldown hash.
    const rep = (await post(a, "report", { as_of: AS_OF, metric_ids: ["M07.output_tokens"], group_by: "run", ...init })).json as MetricReport;
    expect(rep.scope.filters).toEqual(init.filters);
    expect(served(rep, "M07.output_tokens").points).toEqual(runs.points);
    const pin = await pinnedWithSources(a, { metric_id: "M01.run_count" });
    const expected = { metric_ids: ["M07.output_tokens"], group_by: "run" as const, sources: pin.diagnostics, snapshot: pin.query.snapshot, scope: { filters: init.filters, window: { from: EPOCH, to: AS_OF, basis: "as_of_snapshot" as const }, grain: "run" } };
    expect(verifyReportParity(rep, [runs], expected)).toEqual({ ok: true });
  });
});

describe("U04 · AT46 human analysis", () => {
  it("host, model and workflow-revision cohorts show coverage, exclusions and the unattributed remainder", async () => {
    fixture();
    const a = app();
    for (const [by, keys] of [["host", ["host-claude", "host-codex"]], ["observed_model", ["model-w", "model-x", "model-y", "model-z"]], ["workflow_revision", [REV.r1, REV.r2]]] as const) {
      const s = await series(a, { metric_id: "M09.total_tokens" }, by);
      expect(s.points.map((p) => p.key)).toEqual([...keys]);
      for (const p of s.points) expect(p.coverage).toHaveProperty("exclusion_reasons");
    }
    const byHost = await series(a, { metric_id: "M09.total_tokens" }, "host");
    // host-codex holds requests whose host reported no usage: a partial known subtotal with the outlier visible, no exact total.
    expect(point(byHost, "host-codex")).toMatchObject({ value: 920, known_subtotal: 920, exact_total: null, coverage: { state: "partial", covered: 1 } });
    const byModel = await series(a, { metric_id: "M09.total_tokens" }, "observed_model");
    expect(point(byModel, "model-w")).toMatchObject({ value: null, known_subtotal: null });
    // Filtering on a host is the same series engine, one cohort.
    const claude = await series(a, { metric_id: "M09.total_tokens", filters: [{ dimension: "host", values: ["host-claude"] }] });
    expect(point(claude, "all").known_subtotal).toBe(point(byHost, "host-claude").known_subtotal);
  });

  it("a record with no host session makes host-filtered membership unknown, not a complete zero", async () => {
    fixture(false);
    put("b", "runs/run-2/trace.jsonl", jsonl([ev(sid("b"), "run-2", { n: 8, acct: "b2-req-1", input: 5, output: 10, host: null, model: "model-z", rev: REV.r1, initiative: null })]));
    const a = app();
    const s = await series(a, { metric_id: "M07.output_tokens", filters: [{ dimension: "host", values: ["host-codex"] }] });
    const p = point(s, "all");
    expect(p.coverage.state).not.toBe("complete");
    expect(p.exact_total).toBeNull();
    expect(p.coverage.reason).toMatch(/run-2 membership unknown/);
    // Grouped by host, the record shows as the unattributed remainder, and no host group is complete or exact.
    const g = await series(a, { metric_id: "M07.output_tokens" }, "host");
    expect(point(g, "unattributed").value).toBe(10);
    for (const key of ["host-claude", "host-codex"]) {
      expect(point(g, key).coverage.state, key).not.toBe("complete");
      expect(point(g, key).exact_total, key).toBeNull();
    }
    const q = await pinned(a, { metric_id: "M07.output_tokens" });
    const ranking = (await post(a, "analysis", { request: sreq(q), group_by: "host", direction: "asc", difficulty: { "host-claude": "easy", "host-codex": "easy" } })).json.ranking;
    expect(ranking.ranked).toBe(false);
  });

  it("a request whose observations disagree on host is unplaced, in either order; out-of-window records do not count", async () => {
    for (const order of [["host-a", "host-b"], ["host-b", "host-a"]]) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root);
      fs.mkdirSync(path.join(root, "a"), { recursive: true });
      const recs = order.map((host, i) => ev(sid("a"), "run-1", { n: 10 + i, acct: "dup-1", input: 1, output: 10, host, model: "m", rev: REV.r1, initiative: null }));
      put("a", "runs/run-1/trace.jsonl", jsonl(recs));
      const a = createApp({ runsDir: path.join(root, "bench-runs"), casesDir: path.join(root, "cases"), port: 0, projectRoot: path.join(root, "a") });
      const g = await series(a, { metric_id: "M07.output_tokens" }, "host");
      expect(g.points.map((p) => p.key), order.join()).toEqual(["host-a", "host-b", "unattributed"]);
      for (const key of ["host-a", "host-b"]) expect(point(g, key).coverage.state, `${order.join()} ${key}`).not.toBe("complete");
      expect(point(g, "unattributed").value).toBe(10);
      const f = await series(a, { metric_id: "M07.output_tokens", filters: [{ dimension: "host", values: ["host-a"] }] });
      expect(point(f, "all").exact_total).toBeNull();
    }
    // A null-host record outside the activity window does not make an in-window host filter unknown.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    put("a", "runs/run-1/trace.jsonl", jsonl([
      ev(sid("a"), "run-1", { n: 1, acct: "old-1", input: 1, output: 3, host: null, model: "m", rev: REV.r1, initiative: null }),
      ev(sid("a"), "run-1", { n: 20, acct: "new-1", input: 1, output: 7, host: "host-a", model: "m", rev: REV.r1, initiative: null }),
    ]));
    const a = createApp({ runsDir: path.join(root, "bench-runs"), casesDir: path.join(root, "cases"), port: 0, projectRoot: path.join(root, "a") });
    const window = { from: "2026-10-26T00:00:10Z", to: AS_OF, basis: "activity_completed" };
    const inWin = await series(a, { metric_id: "M07.output_tokens", window, filters: [{ dimension: "host", values: ["host-a"] }] });
    expect(point(inWin, "all")).toMatchObject({ value: 7, exact_total: 7, coverage: { state: "complete" } });
    const whole = await series(a, { metric_id: "M07.output_tokens", filters: [{ dimension: "host", values: ["host-a"] }] });
    expect(point(whole, "all").exact_total).toBeNull();
  });

  it("a refusal-only report still reconciles its snapshot and scope", async () => {
    fixture(false);
    const a = app();
    const rep = (await post(a, "report", { as_of: AS_OF, metric_ids: ["M10.derived_estimate_usd"] })).json as MetricReport;
    expect(rep.metrics[0]!.state).toBe("refused");
    const pin = await pinnedWithSources(a, { metric_id: "M01.run_count" });
    const expected = { metric_ids: ["M10.derived_estimate_usd"], group_by: "all" as const, sources: pin.diagnostics, snapshot: pin.query.snapshot, scope: { filters: [], window: { from: EPOCH, to: AS_OF, basis: "as_of_snapshot" as const }, grain: "run" } };
    expect(verifyReportParity(rep, [], expected)).toEqual({ ok: true });
    const rehash = (x: MetricReport): MetricReport => { const { report_hash: _h, ...body } = x; return { ...body, report_hash: sha256(canonicalJson(body)) }; };
    expect(verifyReportParity(rehash({ ...rep, snapshot: { ...rep.snapshot, as_of: "2026-10-26T00:30:00Z" } }), [], expected).ok).toBe(false);
    expect(verifyReportParity(rehash({ ...rep, scope: { ...rep.scope, filters: [{ dimension: "host", values: ["h"] }] } }), [], expected).ok).toBe(false);
    expect(verifyReportParity(rehash({ ...rep, scope: { ...rep.scope, window: { ...rep.scope.window, basis: "activity_completed" } } }), [], expected).ok).toBe(false);
    expect(verifyReportParity(rehash({ ...rep, scope: { ...rep.scope, window: { ...rep.scope.window, timezone: "Asia/Tokyo" as "UTC" } } }), [], expected).ok).toBe(false);
  });

  it("a request started on one host and completed on another is unplaced; goal counts are not attributed to hosts", async () => {
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    const started = { ...ev(sid("a"), "run-1", { n: 1, acct: "req-1", input: 0, output: 0, host: "host-b", model: "m", rev: REV.r2, initiative: null }), event_class: "request_started" as const, usage: null };
    const done = ev(sid("a"), "run-1", { n: 2, acct: "req-1", input: 1, output: 5, host: "host-a", model: "m", rev: REV.r1, initiative: null });
    put("a", "runs/run-1/trace.jsonl", jsonl([started, done]));
    const a = createApp({ runsDir: path.join(root, "bench-runs"), casesDir: path.join(root, "cases"), port: 0, projectRoot: path.join(root, "a") });
    const g = await series(a, { metric_id: "M07.output_tokens" }, "host");
    for (const key of ["host-a", "host-b"]) expect(point(g, key).coverage.state, key).not.toBe("complete");
    expect(point(g, "unattributed").value).toBe(5);
    for (const [dim, v] of [["host", "host-b"], ["workflow_revision", REV.r2]] as const) {
      const f = await series(a, { metric_id: "M07.output_tokens", filters: [{ dimension: dim, values: [v] }] });
      expect(point(f, "all").exact_total, dim).toBeNull();
    }
    // Host and revision filters together: the unplaced request may match both.
    const both = await series(a, { metric_id: "M07.output_tokens", filters: [{ dimension: "host", values: ["host-a"] }, { dimension: "workflow_revision", values: [REV.r2] }] });
    expect(point(both, "all").exact_total).toBeNull();
    expect(point(both, "all").coverage.state).not.toBe("complete");
    // Grouped goal counts are unavailable, and so is the whole-series coverage.
    const goalsByHost = await series(a, { metric_id: "M01.goal_count" }, "host");
    expect(goalsByHost.coverage.state).toBe("unavailable");
    const goals = await series(a, { metric_id: "M01.goal_count", filters: [{ dimension: "host", values: ["host-a"] }] });
    expect(point(goals, "all")).toMatchObject({ value: null, coverage: { state: "unavailable" } });
    expect(point(goals, "all").reason).toMatch(/run-level/);
    // Ungrouped and unfiltered, goal counting is unchanged.
    expect(point(await series(a, { metric_id: "M01.goal_count" }), "all").value).toBe(0);
  });

  it("a task fact of an excluded run does not make a run-filtered host series unknown", () => {
    fixture(false);
    const snap = openProjectSnapshot([{ source_id: sid("a"), root: path.join(root, "a") }], { as_of: AS_OF });
    const src = snap.facts.sources[0]!;
    src.tasks.push({ source_id: sid("a"), run_id: "run-2", task_id: "task-9", cohort: null, outcome: "succeeded", acceptance: "verified", terminal_at: "2026-10-26T00:00:30Z", spend_usd: null, spend_basis: null, evidence: src.runs[0]!.evidence });
    const rep = buildMetricReport(snap, {}, { metric_ids: ["M07.output_tokens"], filters: [{ dimension: "run", values: ["run-1"] }, { dimension: "host", values: ["host-claude"] }] });
    expect(point(served(rep, "M07.output_tokens"), "all")).toMatchObject({ value: 15, exact_total: 15, coverage: { state: "complete" } });
  });

  it("task outcomes are not grouped by host, revision or model; task facts under a host filter are unknown", async () => {
    fixture(false);
    const a = app();
    const q = await pinned(a, { metric_id: "M14.outcome_count", window: { from: "1970-01-01T00:00:00Z", to: AS_OF, basis: "accepted_outcome_cohort" } });
    for (const by of ["host", "workflow_revision", "observed_model"]) {
      const r = await post(a, "series", { request: sreq(q), group_by: by });
      expect([r.status, r.json.code], by).toEqual([422, "unsupported_capability"]);
    }
    // A recorded task outcome has no host binding: with one present, a host-filtered task count is not complete.
    const snap = openProjectSnapshot([{ source_id: sid("a"), root: path.join(root, "a") }], { as_of: AS_OF });
    const src = snap.facts.sources[0]!;
    src.outcomes = "collected";
    src.tasks.push({ source_id: sid("a"), run_id: "run-1", task_id: "task-9", cohort: null, outcome: "succeeded", acceptance: "verified", terminal_at: "2026-10-26T00:00:30Z", spend_usd: null, spend_basis: null, evidence: src.runs[0]!.evidence });
    const rep = buildMetricReport(snap, {}, { metric_ids: ["M01.task_count"], filters: [{ dimension: "host", values: ["host-none"] }] });
    expect(served(rep, "M01.task_count").coverage.state).not.toBe("complete");
    expect(point(served(rep, "M01.task_count"), "all").exact_total).toBeNull();
  });

  it("p50/p95 come with their sample count; with no span source all three are unknown, not 0", async () => {
    fixture();
    const rep = (await post(app(), "report", { as_of: AS_OF, metric_ids: ["M05.latency_p50_ms", "M05.latency_p95_ms", "M05.sample_count"] })).json as MetricReport;
    for (const id of ["M05.latency_p50_ms", "M05.latency_p95_ms", "M05.sample_count"]) {
      const p = point(served(rep, id), "all");
      expect(p.value).toBeNull();
      expect(p.reason).toMatch(/span source/);
    }
  });

  it("estimate provenance: a derived cost names its pricing version and source hash", () => {
    fixture(false);
    const pricing = { version: "price-2026-10", currency: "USD", source_hash: `sha256:${"9".repeat(64)}`, entries: ["model-x", "model-y", "model-z"].map((model) => ({ provider: "provider", model, uncached_input: 1, cache_read: 0.5, cache_write: null, output: 2 })) };
    const snap = openProjectSnapshot([{ source_id: sid("a"), root: path.join(root, "a") }], { as_of: AS_OF, pricing });
    const rep = buildMetricReport(snap, {}, { metric_ids: ["M10.derived_estimate_usd", "M10.measured_spend_usd"] });
    const est = served(rep, "M10.derived_estimate_usd");
    expect(est.cost_bases).toEqual(["derived_estimate"]);
    expect(est.pricing).toEqual({ version: expect.stringContaining("price-2026-10"), currency: "USD", source_hash: pricing.source_hash });
    const measured = served(rep, "M10.measured_spend_usd");
    expect(measured.cost_bases).toEqual(["measured"]);
    expect(point(measured, "all").value).toBeNull();
  });

  it("rankings: no declared difficulty → no leaderboard; null usage is never the cheapest; strata rank separately", async () => {
    fixture();
    const a = app();
    const q = await pinned(a, { metric_id: "M09.total_tokens" });
    const none = await post(a, "analysis", { request: sreq(q), group_by: "observed_model", direction: "asc" });
    expect(none.status).toBe(200);
    expect(none.json.ranking).toMatchObject({ ranked: false, strata: [] });
    expect(none.json.ranking.reason).toMatch(/no unqualified leaderboard/);
    // The offline source stays visible beside the ranking.
    expect(none.json.sources.some((s: any) => s.state === "unavailable" && s.names.includes("offline"))).toBe(true);
    const r = await post(a, "analysis", { request: sreq(q), group_by: "observed_model", direction: "asc", difficulty: { "model-x": "easy", "model-y": "easy", "model-z": "hard" } });
    const ranking = r.json.ranking;
    // Offline source → every point is partial: nothing is ranked; model-w (null usage) is unknown, not cheapest.
    expect(ranking.ranked).toBe(false);
    expect(ranking.unranked.find((u: any) => u.key === "model-w")).toMatchObject({ value: null });
    expect(ranking.unranked.find((u: any) => u.key === "model-y").reason).toMatch(/coverage partial/);
    // Without the offline source, complete cohorts rank; model-y's lost usage keeps it unranked.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    fixture(false);
    const b = app();
    const q2 = await pinned(b, { metric_id: "M09.total_tokens" });
    const ok = (await post(b, "analysis", { request: sreq(q2), group_by: "observed_model", direction: "asc", difficulty: { "model-w": "easy", "model-x": "easy", "model-y": "easy", "model-z": "hard" } })).json.ranking;
    expect(ok.ranked).toBe(true);
    expect(ok.strata).toEqual([{ difficulty: "easy", entries: [{ key: "model-x", value: 45, rank: 1 }] }, { difficulty: "hard", entries: [{ key: "model-z", value: 2, rank: 1 }] }]);
    expect(ok.unranked.map((u: any) => [u.key, u.value])).toEqual([["model-w", null], ["model-y", 920]]);
    // Negative control: a naive ascending sort would put model-w's null usage first as cheapest.
    const flat = ok.strata.flatMap((s: any) => s.entries);
    expect(flat.some((e: any) => e.key === "model-w" || e.key === "model-y")).toBe(false);
    // model-z (hard, 2 tokens) is not ranked against model-x (easy, 45 tokens).
    expect(ok.strata.every((s: any) => s.entries.length === 1)).toBe(true);
  });

  it("rankSeries never ranks null, partial or unattributed points", () => {
    const pt = (key: string, value: number | null, state: "complete" | "partial" = "complete") => ({ key, value, coverage: { state, reason: state === "partial" ? "lost" : null }, reason: value === null ? "lost" : null }) as any;
    const s = { metric_id: "M09.total_tokens", unit: "tokens", points: [pt("a", null), pt("b", 5), pt("c", 3, "partial"), pt("unattributed", 1), pt("d", 9)] } as unknown as MetricSeriesV2;
    const r = rankSeries(s, { direction: "asc", difficulty: { a: "x", b: "x", c: "x", unattributed: "x", d: "x" } });
    expect(r.strata).toEqual([{ difficulty: "x", entries: [{ key: "b", value: 5, rank: 1 }, { key: "d", value: 9, rank: 2 }] }]);
    expect(r.unranked.map((u) => u.key)).toEqual(["a", "c", "unattributed"]);
  });

  it("revision cohorts compare descriptively only; incompatible comparisons are refused", async () => {
    fixture(false);
    const a = app();
    const q = await pinned(a, { metric_id: "M07.output_tokens" });
    const side = (key: string, query = q) => ({ request: sreq(query), group_by: "workflow_revision", point_key: key });
    const c = await post(a, "compare", { a: side(REV.r1), b: side(REV.r2) });
    expect(c.status).toBe(200);
    const cmp = c.json.comparison;
    // Negative control: mixed revisions are never called a causal gain.
    expect(cmp).toMatchObject({ compatible: true, label: "descriptive_only", causal: false });
    expect(cmp.statement).toMatch(/not a causal gain/);
    expect(cmp.label).not.toMatch(/improve|gain/);
    // r2 holds the request with lost usage → partial: no difference is computed.
    expect(cmp.difference).toBeNull();
    expect(cmp.difference_reason).toMatch(/incomplete coverage/);
    // Different windows are not comparable.
    const q2 = await pinned(a, { metric_id: "M07.output_tokens", window: { from: "2026-10-26T00:00:00Z", to: AS_OF, basis: "activity_completed" } });
    const bad = (await post(a, "compare", { a: side(REV.r1), b: side(REV.r1, q2) })).json.comparison;
    expect(bad).toMatchObject({ compatible: false, label: "refused", causal: false, difference: null });
    expect(bad.incompatibilities.join(";")).toMatch(/different windows/);
    // Filters varying in two dimensions are not one cohort comparison.
    const qa = await pinned(a, { metric_id: "M07.output_tokens", filters: [{ dimension: "host", values: ["host-claude"] }] });
    const qb = await pinned(a, { metric_id: "M07.output_tokens", filters: [{ dimension: "observed_model", values: ["model-y"] }] });
    const two = (await post(a, "compare", { a: { request: sreq(qa), point_key: "all" }, b: { request: sreq(qb), point_key: "all" } })).json.comparison;
    expect(two.incompatibilities.join(";")).toMatch(/2 dimensions/);
  });

  it("compareCohorts: a complete, same-basis pair gets a difference; different metrics are refused", () => {
    const base = { metric_id: "M07.output_tokens", underlying_metric_id: null, unit: "tokens", query: { versions: { schema: "s", analyzer: "a", normalizer: "n", formula: "f", usage_semantics: "u", pricing: "p", aggregation: "g" }, snapshot: { as_of: AS_OF }, window: { from: "x", to: "y" }, grain: "run", filters: [] } };
    const pt = (key: string, value: number) => ({ key, value, coverage: { state: "complete" }, cost_basis: "not_applicable" });
    const s = { ...base, points: [pt("p", 10), pt("q", 4)] } as unknown as MetricSeriesV2;
    expect(compareCohorts({ series: s, key: "p", group_by: "host" }, { series: s, key: "q", group_by: "host" })).toMatchObject({ compatible: true, difference: -6, causal: false });
    const other = { ...s, metric_id: "M06.input_tokens" } as unknown as MetricSeriesV2;
    expect(compareCohorts({ series: s, key: "p", group_by: "host" }, { series: other, key: "q", group_by: "host" })).toMatchObject({ compatible: false, label: "refused" });
    // A host point against a workflow-revision point changes the cohort dimension.
    expect(compareCohorts({ series: s, key: "p", group_by: "host" }, { series: s, key: "q", group_by: "workflow_revision" }).incompatibilities.join(";")).toMatch(/different groupings/);
    // A different filter plus a different group key varies two dimensions.
    const filtered = { ...s, query: { ...base.query, filters: [{ dimension: "observed_model", values: ["m"] }] } } as unknown as MetricSeriesV2;
    expect(compareCohorts({ series: s, key: "p", group_by: "host" }, { series: filtered, key: "q", group_by: "host" }).incompatibilities.join(";")).toMatch(/2 dimensions/);
    // A repeated dimension is compared as a whole: host and model both change here.
    const rep2 = (h: string, m: string) => ({ ...s, query: { ...base.query, filters: [{ dimension: "host", values: ["h1", "h2"] }, { dimension: "host", values: [h] }, { dimension: "observed_model", values: [m] }] } }) as unknown as MetricSeriesV2;
    expect(compareCohorts({ series: rep2("h1", "m1"), key: "p", group_by: "all" }, { series: rep2("h2", "m2"), key: "p", group_by: "all" }).compatible).toBe(false);
    // The same point under the same overview query is not a comparison.
    expect(compareCohorts({ series: s, key: "p", group_by: "all" }, { series: s, key: "p", group_by: "all" }).compatible).toBe(false);
  });
});

// Regenerates the UI fixture from real responses:
// GEN_U04_UI=$PWD/ui/src/__tests__/fixtures/metrics-u04.json npx vitest run tests/c9-metric-report.at45-46.test.ts -t "ui fixture"
describe.runIf(process.env.GEN_U04_UI)("U04 ui fixture", () => {
  it("writes the MetricsPage fixture", async () => {
    fixture();
    const a = app();
    const all = (await post(a, "report", { as_of: AS_OF })).json as MetricReport;
    const ids = ["M09.total_tokens", "M05.latency_p50_ms", "M05.sample_count", "M10.derived_estimate_usd"];
    const rep = (await post(a, "report", { as_of: AS_OF, group_by: "observed_model", metric_ids: ids })).json as MetricReport;
    const q = served(rep, "M09.total_tokens").query;
    const dr = (await post(a, "drilldown", { request: dreq(q), point_key: "model-y", group_by: "observed_model" })).json;
    const an = (await post(a, "analysis", { request: sreq(q), group_by: "observed_model", direction: "asc", difficulty: {} })).json;
    const side = (k: string) => ({ request: sreq(q), group_by: "observed_model", point_key: k });
    const cmp = (await post(a, "compare", { a: side("model-x"), b: side("model-z") })).json;
    fs.writeFileSync(process.env.GEN_U04_UI!, JSON.stringify({ report_all: all, report_model: rep, drilldown: dr, analysis: { ranking: an.ranking }, compare: { comparison: cmp.comparison } }) + "\n");
  });
});
