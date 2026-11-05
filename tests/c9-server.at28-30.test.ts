/**
 * T04 server wiring: POST /api/project/metrics/{query,series,drilldown} over a
 * workspace of two real `.guild/` sources (AT28 completeness, AT29 snapshot and
 * cursor, AT30 contract envelopes), plus the request guards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hono } from "hono";
import { createApp } from "../src/server.js";
import { projectMetricQuery } from "../src/project-reader.js";
import { canonicalSourceId } from "../src/c9/source-identity.js";
import { readRequest } from "../src/c9/project-read.js";
import { validateMetricDrilldownV2, validateMetricSeriesV2, type MetricDrilldownV2, type MetricSeriesV2, type QueryIdentity, type RefusalV2 } from "../src/c9/metric-series.js";
import type { TraceAnalysisV3, TraceCoverage, TraceUsage } from "../src/c9/trace-analysis.js";

const H = `sha256:${"a".repeat(64)}`;
const PINS = { assignment: H, definition: H, configuration: H, workflow: H, policy: H };
const COMPLETE: TraceCoverage = { eligible: 1, covered: 1, excluded: 0, missing: 0, state: "complete", reason: null, exclusion_reasons: [] };
const AS_OF = "2026-10-26T01:00:00Z";
const HEADERS = { host: "127.0.0.1:3055", "content-type": "application/json" };

function use(acct: string, input: number, output: number): TraceUsage {
  return {
    granularity: "leaf_request", observation_id: `obs-${acct}`, revision: 1, final: true, accounting_identity: acct,
    parent_accounting_identity: null, inclusion: "leaf_exclusive", input_inclusive: input, output, cache_read_subset: 0,
    cache_write_subset: 0, total: input + output, cost_usd: null, cost_basis: "unavailable", currency: "USD", pricing_version: null,
    usage_semantics: "inclusive_input_cache_subset.v1", coverage: COMPLETE, native_baseline_usd: null, native_cumulative_usd: null,
  };
}
let seq = 0;
function ev(source: string, run: string, n: number, usage: TraceUsage): TraceAnalysisV3 {
  return {
    schema_version: "guild.trace.analysis.v3", event_id: `record-${String(n).padStart(3, "0")}`, sequence: seq++, event_class: "request_completed",
    at: new Date(Date.parse("2026-10-26T00:00:00Z") + n * 1000).toISOString(),
    lineage: { source_id: source, run_id: run, execution_id: "exec-1", host_session_id: "host-session-1", initiative_id: null, goal_id: null, logical_task_id: null, attempt_id: null, agent_instance_id: null, request_id: usage.accounting_identity },
    operation_id: null, component_invocation_id: null, actor_id: "agent-1", pins: PINS, requested_model: "requested-model",
    observed_identity: { provider: "provider", model: "observed-model", status: "observed", reason: null },
    usage, payload_ref: null, prompt_hash: null, redaction_version: "guild.trace-scrub.v1", capture: COMPLETE, interval: null,
  };
}
const jsonl = (events: TraceAnalysisV3[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

let root = "";
function put(sub: string, rel: string, body: string): void {
  const p = path.join(root, sub, ".guild", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
function workspace(subGuilds: { name: string; path: string }[]): void {
  fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
  fs.writeFileSync(path.join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: subGuilds }));
}
/** The lineage source id the plugin writes for a root (not its workspace display name). */
const sid = (sub: string) => canonicalSourceId(path.join(root, sub));
/** AT28 fixture: source-a run-1 has 501 records with output only on record 501; source-b has the same local run id. */
function at28(): void {
  workspace([{ name: "source-a", path: "a" }, { name: "source-b", path: "b" }]);
  fs.mkdirSync(path.join(root, "a"), { recursive: true });
  fs.mkdirSync(path.join(root, "b"), { recursive: true });
  const a: TraceAnalysisV3[] = [];
  for (let n = 1; n <= 501; n++) a.push(ev(sid("a"), "run-1", n, use(`req-${n}`, 1, n === 501 ? 7 : 0)));
  put("a", "runs/run-1/trace.jsonl", jsonl(a));
  put("b", "runs/run-1/trace.jsonl", jsonl([ev(sid("b"), "run-1", 1, use("req-1", 2, 3))]));
}

const app = (projectRoot: string | null = root): Hono => createApp({ runsDir: path.join(root, "bench-runs"), casesDir: path.join(root, "cases"), port: 0, ...(projectRoot ? { projectRoot } : {}) });
async function post(a: Hono, route: string, body: unknown, headers: Record<string, string> = HEADERS): Promise<{ status: number; json: any }> {
  const res = await a.fetch(new Request(`http://127.0.0.1:3055/api/project/metrics/${route}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function pinned(a: Hono, spec: Record<string, unknown>): Promise<{ query: QueryIdentity; diagnostics: any[] }> {
  const r = await post(a, "query", { as_of: AS_OF, ...spec });
  expect(r.status).toBe(200);
  return r.json;
}
const seriesReq = (q: QueryIdentity) => readRequest(q, "metric_series", { request_id: "q-1", session_id: "ui-session-1" });
const drillReq = (q: QueryIdentity, cursor: string | null = null, limit?: number) => readRequest(q, "metric_drilldown", { request_id: "q-2", session_id: "ui-session-1", cursor, ...(limit ? { limit } : {}) });

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bench-c9-"))); seq = 0; });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("T04 server · AT28 completeness", () => {
  it("series over the endpoint counts record 501 and both source-qualified runs; per-source points reconcile", async () => {
    at28();
    const a = app();
    const out = await pinned(a, { metric_id: "M07.output_tokens" });
    // The workspace root has no runs: available with 0 runs.
    const runsBy: Record<string, number> = { [sid("a")]: 1, [sid("b")]: 1, [canonicalSourceId(root)]: 0 };
    expect(out.diagnostics.map((d) => [d.source_id, d.state, d.runs])).toEqual(Object.keys(runsBy).sort().map((id) => [id, "available", runsBy[id]]));
    expect(out.sources).toEqual({ [sid("a")]: ["source-a"], [sid("b")]: ["source-b"], [canonicalSourceId(root)]: ["workspace"] });
    const s = await post(a, "series", { request: seriesReq(out.query), group_by: "source" });
    expect(s.status).toBe(200);
    expect(validateMetricSeriesV2(s.json)).toEqual({ ok: true });
    const pts = Object.fromEntries((s.json as MetricSeriesV2).points.map((p) => [p.key, p]));
    expect(pts[sid("a")]).toMatchObject({ value: 7, coverage: { eligible: 501 } });
    expect(pts[sid("b")]!.value).toBe(3);
    const total = await post(a, "series", { request: seriesReq(out.query) });
    expect((total.json as MetricSeriesV2).points[0]!.value).toBe(10);
    const runs = await pinned(a, { metric_id: "M01.run_count" });
    const r = await post(a, "series", { request: seriesReq(runs.query) });
    // Negative control: collapsing bare run ids would give 1.
    expect((r.json as MetricSeriesV2).points[0]!.value).toBe(2);
  });

  it("drilldown pages all 501 records once, in stable order", async () => {
    at28();
    const a = app();
    const { query } = await pinned(a, { metric_id: "M07.output_tokens" });
    const p1 = await post(a, "drilldown", { request: drillReq(query, null, 500), point_key: "all" });
    expect(p1.status).toBe(200);
    expect(validateMetricDrilldownV2(p1.json)).toEqual({ ok: true });
    const page1 = p1.json as MetricDrilldownV2;
    expect(page1.records.length).toBe(500);
    expect(page1.next_cursor).not.toBeNull();
    const p2 = await post(a, "drilldown", { request: drillReq(query, page1.next_cursor, 500) });
    const page2 = p2.json as MetricDrilldownV2;
    const all = [...page1.records, ...page2.records];
    expect(page2.next_cursor).toBeNull();
    // 501 records of source-a plus 1 of source-b, none from a 50-record preview.
    expect(all.length).toBe(502);
    expect(new Set(all.map((e) => `${e.source_id}|${e.path}|${e.sha256}`)).size).toBe(all.length);
  });
});

describe("T04 server · AT29 snapshot", () => {
  it("a source change between pages is a 409 stale_cursor; an unchanged re-read serves the same page", async () => {
    at28();
    const a = app();
    const { query } = await pinned(a, { metric_id: "M07.output_tokens" });
    const p1 = (await post(a, "drilldown", { request: drillReq(query, null, 100) })).json as MetricDrilldownV2;
    const again = (await post(a, "drilldown", { request: drillReq(query, null, 100) })).json as MetricDrilldownV2;
    expect(again).toEqual(p1);
    put("b", "runs/run-2/trace.jsonl", jsonl([ev(sid("b"), "run-2", 2, use("req-9", 1, 1))]));
    const stale = await post(a, "drilldown", { request: drillReq(query, p1.next_cursor, 100) });
    expect(stale.status).toBe(409);
    expect(stale.json as RefusalV2).toMatchObject({ schema_version: "guild.stack.refusal.v2", code: "stale_cursor", retryable: true });
    expect((stale.json as RefusalV2).expected_snapshot).not.toBe((stale.json as RefusalV2).observed_snapshot);
    const fresh = await post(a, "series", { request: seriesReq(query) });
    expect(fresh.status).toBe(409);
    expect(fresh.json.code).toBe("stale_source");
  });

  it("an offline source stays in the snapshot and the denominator", async () => {
    at28();
    workspace([{ name: "source-a", path: "a" }, { name: "source-b", path: "b" }, { name: "source-c", path: "offline" }]);
    const a = app();
    const out = await pinned(a, { metric_id: "M07.output_tokens" });
    expect(out.query.snapshot.source_ids).toEqual([sid("a"), sid("b"), sid("offline"), canonicalSourceId(root)].sort());
    expect(out.diagnostics.find((d) => d.source_id === sid("offline"))).toMatchObject({ state: "unavailable" });
    const s = (await post(a, "series", { request: seriesReq(out.query) })).json as MetricSeriesV2;
    const p = s.points[0]!;
    // Negative control: the readable sources alone would claim a complete total.
    expect(p.coverage.state).not.toBe("complete");
    expect(p.exact_total).toBeNull();
    expect(p.known_subtotal).toBe(10);
  });
});

describe("T04 server · AT30 envelopes and guards", () => {
  it("unpinned queries, relabelled versions and bad grouping refuse with the C9 refusal envelope", async () => {
    at28();
    const a = app();
    const { query } = await pinned(a, { metric_id: "M10.derived_estimate_usd" });
    const noPricing = await post(a, "series", { request: seriesReq(query) });
    expect(noPricing.json).toMatchObject({ schema_version: "guild.stack.refusal.v2", code: "input_unavailable" });
    expect(noPricing.status).toBe(422);
    const tokens = await pinned(a, { metric_id: "M07.output_tokens" });
    const relabelled = { ...tokens.query, versions: { ...tokens.query.versions, aggregation: "other.1" } };
    const r = await post(a, "series", { request: seriesReq(relabelled) });
    expect(r.json.code).toBe("unsupported_capability");
    const g = await post(a, "series", { request: seriesReq(tokens.query), group_by: "phase" });
    expect([g.status, g.json.code]).toEqual([400, "invalid_request"]);
    const unknown = await post(a, "query", { as_of: AS_OF, metric_id: "M99.nope" });
    expect(unknown.json.code).toBe("unsupported_capability");
    const filt = await post(a, "query", { as_of: AS_OF, metric_id: "M07.output_tokens", filters: [{ dimension: "phase", values: ["p"] }] });
    expect(filt.json.code).toBe("unsupported_capability");
  });

  it("refuses foreign callers, oversize or malformed bodies, bad as_of and unsafe source names", async () => {
    at28();
    const a = app();
    expect((await post(a, "query", { metric_id: "M01.run_count" }, { ...HEADERS, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(a, "query", { metric_id: "M01.run_count" }, { ...HEADERS, host: "evil.example" })).status).toBe(403);
    expect((await post(a, "query", "{not json")).status).toBe(400);
    expect((await post(a, "query", { metric_id: "M01.run_count", pad: "x".repeat(300_000) })).status).toBe(413);
    expect((await post(a, "query", { metric_id: "M01.run_count", as_of: "yesterday" })).status).toBe(400);
    expect((await post(a, "series", { request: { query: {} } })).status).toBe(400);
    expect((await post(app(null), "query", { metric_id: "M01.run_count" })).status).toBe(404);
    // A root whose canonical id is not a contract id (basename past 128 chars) refuses the snapshot.
    workspace([{ name: "long", path: "x".repeat(130) }]);
    const unsafe = await post(app(), "query", { as_of: AS_OF, metric_id: "M01.run_count" });
    expect(unsafe.status).toBe(422);
    expect(unsafe.json.error).toMatch(/unsafe source id/);
  });

  it("plain project mode reads traces under the plugin's canonical source id; display names are not identities", async () => {
    fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
    put("", "runs/run-1/trace.jsonl", jsonl([ev(canonicalSourceId(root), "run-1", 1, use("req-1", 1, 7)), ev("project", "run-1", 2, use("req-2", 1, 5))]));
    const a = app();
    const out = await pinned(a, { metric_id: "M07.output_tokens" });
    expect(out.query.snapshot.source_ids).toEqual([canonicalSourceId(root)]);
    expect(out.sources).toEqual({ [canonicalSourceId(root)]: ["project"] });
    const p = ((await post(a, "series", { request: seriesReq(out.query) })).json as MetricSeriesV2).points[0]!;
    // The record naming the display name is foreign: not counted, and the total is not exact.
    expect(p.known_subtotal).toBe(7);
    expect(p.exact_total).toBeNull();
    expect(out.diagnostics[0].invalid_events).toBe(1);
  });

  it("two workspace names for one root are one source, read once", async () => {
    at28();
    workspace([{ name: "source-a", path: "a" }, { name: "alias-a", path: "a" }, { name: "source-b", path: "b" }]);
    const a = app();
    const out = await pinned(a, { metric_id: "M07.output_tokens" });
    expect(out.sources[sid("a")]).toEqual(["source-a", "alias-a"]);
    expect(((await post(a, "series", { request: seriesReq(out.query) })).json as MetricSeriesV2).points[0]!.value).toBe(10);
  });

  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it("the workspace root stays in the snapshot even with no readable content", async () => {
    at28();
    const a = app();
    const out = await pinned(a, { metric_id: "M07.output_tokens" });
    expect(out.query.snapshot.source_ids).toContain(canonicalSourceId(root));
    expect(out.sources[canonicalSourceId(root)]).toEqual(["workspace"]);
    if (asRoot) return;
    // Its runs exist but cannot be listed: the source is unavailable and the total is not exact.
    put("", "runs/run-9/trace.jsonl", jsonl([ev(canonicalSourceId(root), "run-9", 1, use("req-1", 1, 1))]));
    fs.chmodSync(path.join(root, ".guild", "runs"), 0o000);
    try {
      const again = await pinned(a, { metric_id: "M07.output_tokens" });
      expect(again.diagnostics.find((d) => d.source_id === canonicalSourceId(root))).toMatchObject({ state: "unavailable" });
      const p = ((await post(a, "series", { request: seriesReq(again.query) })).json as MetricSeriesV2).points[0]!;
      expect(p.exact_total).toBeNull();
      expect(p.coverage.state).not.toBe("complete");
    } finally {
      fs.chmodSync(path.join(root, ".guild", "runs"), 0o755);
    }
  });

  it("an unreadable capture manifest makes the run unknown, never an empty complete capture", async () => {
    if (asRoot) return;
    at28();
    put("b", "runs/run-1/trace-capture-manifest.json", JSON.stringify({ schema_version: "guild.trace.capture_manifest.v1", source_id: sid("b"), run_id: "run-1", events_written: 1, duplicates: 0, losses: { unrecorded: 5 }, upstream_drop_unknown: false }));
    const a = app();
    const readable = await pinned(a, { metric_id: "M07.output_tokens" });
    const pr = ((await post(a, "series", { request: seriesReq(readable.query), group_by: "source" })).json as MetricSeriesV2).points.find((x) => x.key === sid("b"))!;
    expect(pr.coverage.state).not.toBe("complete");
    const manifest = path.join(root, "b", ".guild", "runs", "run-1", "trace-capture-manifest.json");
    fs.chmodSync(manifest, 0o000);
    try {
      const out = await pinned(a, { metric_id: "M07.output_tokens" });
      const d = out.diagnostics.find((x) => x.source_id === sid("b"));
      expect(d.run_errors.map((e: { run_id: string }) => e.run_id)).toEqual(["run-1"]);
      const p = ((await post(a, "series", { request: seriesReq(out.query), group_by: "source" })).json as MetricSeriesV2).points.find((x) => x.key === sid("b"))!;
      expect(p.exact_total).toBeNull();
      expect(p.coverage.state).not.toBe("complete");
    } finally {
      fs.chmodSync(manifest, 0o644);
    }
  });

  it("a present but unreadable or invalid workspace.json refuses instead of dropping its children", async () => {
    at28();
    const ws = path.join(root, ".guild", "workspace.json");
    const cases: [string, () => void][] = [
      ["not valid JSON", () => fs.writeFileSync(ws, "{nope")],
      ["no sub_guilds array", () => fs.writeFileSync(ws, JSON.stringify({ sub_guilds: "a" }))],
      ["without a string name and path", () => fs.writeFileSync(ws, JSON.stringify({ sub_guilds: [{ name: "source-a", path: "a" }, { name: 7 }] }))],
      ["outside the project root", () => fs.writeFileSync(ws, JSON.stringify({ sub_guilds: [{ name: "source-a", path: "a" }, { name: "far", path: "../far" }] }))],
      ["present but unreadable", () => { fs.symlinkSync(path.join(root, "a"), ws); }],
    ];
    for (const [why, make] of cases) {
      make();
      const r = await post(app(), "query", { as_of: AS_OF, metric_id: "M07.output_tokens" });
      expect(`${why}:${r.status}`).toBe(`${why}:422`);
      expect(r.json.error).toContain(`source set unknown`);
      expect(r.json.error).toContain(why);
      fs.rmSync(ws, { force: true });
    }
    // Negative control: the lenient reader alone would serve a complete zero from the root.
    fs.writeFileSync(ws, "{nope");
    const sources = (await import("../src/project-reader.js")).resolveGuildSources;
    expect((await sources(root)).map((s) => s.name)).toEqual(["project"]);
  });

  it("the default as_of keeps sub-second precision, so a same-second event is not after it", async () => {
    fs.mkdirSync(path.join(root, ".guild"), { recursive: true });
    const e = ev(canonicalSourceId(root), "run-1", 1, use("req-1", 1, 7));
    e.at = "2026-10-26T01:00:00.100Z";
    put("", "runs/run-1/trace.jsonl", jsonl([e]));
    const r = await projectMetricQuery(root, { metric_id: "M07.output_tokens" }, () => new Date("2026-10-26T01:00:00.900Z"));
    expect(r.status).toBe(200);
    expect((r.body as { query: QueryIdentity }).query.snapshot.as_of).toBe("2026-10-26T01:00:00.900Z");
  });

  it("reads never write into the sources", async () => {
    at28();
    const before = fs.readdirSync(path.join(root, "a", ".guild", "runs", "run-1")).sort();
    const a = app();
    const { query } = await pinned(a, { metric_id: "M07.output_tokens" });
    await post(a, "series", { request: seriesReq(query) });
    await post(a, "drilldown", { request: drillReq(query) });
    expect(fs.readdirSync(path.join(root, "a", ".guild", "runs", "run-1")).sort()).toEqual(before);
    expect(fs.existsSync(path.join(root, "b", ".guild", "analysis"))).toBe(false);
  });
});
