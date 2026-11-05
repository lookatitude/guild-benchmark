import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api";
import { prefersReducedMotion } from "../lib/motion";
import type {
  CohortComparison,
  Coverage,
  Drilldown,
  MetricReport,
  QueryFilter,
  Ranking,
  ReportEntry,
  ReportSource,
  ServedEntry,
  SeriesPoint,
} from "../lib/metrics-types";

// P09/P11 metrics view over POST /api/project/metrics/* (src/c9/metric-report.ts).
// The chart, the exact-value table and the exported report all show the values
// the C9 read service returned. This page computes no metric: unknown shows as
// unknown, a refusal shows its reason, ranking and comparison come from the server.

const GROUPS = ["all", "source", "run", "host", "observed_model", "workflow_revision", "task"] as const;
const GROUP_LABEL: Record<(typeof GROUPS)[number], string> = {
  all: "overview (no grouping)",
  source: "source",
  run: "run",
  host: "host session",
  observed_model: "observed model",
  workflow_revision: "workflow revision",
  task: "task",
};
// Percentiles are shown next to the catalog metric that counts their samples.
const SAMPLE_COUNT: Record<string, string> = {
  "M05.latency_p50_ms": "M05.sample_count",
  "M05.latency_p95_ms": "M05.sample_count",
  "M19.tool_latency_p50_ms": "M19.tool_call_count",
  "M19.tool_latency_p95_ms": "M19.tool_call_count",
  "M24.refresh_latency_p50_ms": "M24.refresh_job_count",
  "M24.refresh_latency_p95_ms": "M24.refresh_job_count",
  "M26.retrieval_latency_p50_ms": "M26.query_count",
  "M26.retrieval_latency_p95_ms": "M26.query_count",
};
const SCHEMA_BASE = "https://guildstack.dev/contracts/guild-stack/v2/";

type Op = "metric_series" | "metric_drilldown";
function readRequest(e: ServedEntry, op: Op, cursor: string | null = null) {
  return {
    schema_version: "guild.stack.read-request.v2",
    request_id: op === "metric_series" ? "ui-metric-series" : "ui-metric-drilldown",
    session_id: "benchmark-ui",
    operation: op,
    result_schema_id: `${SCHEMA_BASE}${op === "metric_series" ? "metric-series" : "metric-drilldown"}.schema.json`,
    query: e.query,
    cursor,
    limit: 100,
    query_hash: e.query_hash,
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const parsed = (await res.json().catch(() => null)) as (T & { error?: string; message?: string; code?: string }) | null;
  if (!res.ok || !parsed) {
    const detail = parsed?.message ? `${parsed.code ?? "refused"}: ${parsed.message}` : parsed?.error ?? res.statusText;
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return parsed;
}

/** One POST whose body is the dependency; null body means "not yet". */
function usePost<T>(url: string, body: unknown | null) {
  const key = body === null ? null : JSON.stringify(body);
  const [state, setState] = useState<{ status: "idle" | "loading" | "success" | "error"; data?: T; error?: string }>({ status: "idle" });
  useEffect(() => {
    if (key === null) {
      setState({ status: "idle" });
      return;
    }
    let live = true;
    setState({ status: "loading" });
    postJson<T>(url, JSON.parse(key))
      .then((data) => live && setState({ status: "success", data }))
      .catch((err: Error) => live && setState({ status: "error", error: err.message }));
    return () => {
      live = false;
    };
  }, [url, key]);
  return state;
}

const show = (v: number | null) => (v === null ? "unknown" : String(v));
const filterText = (fs: QueryFilter[]) => (fs.length === 0 ? "none" : fs.map((f) => `${f.dimension} = ${f.values.join(" | ")}`).join("; "));

function CoverageText({ c }: { c: Coverage }) {
  return (
    <span data-testid="coverage">
      {c.state}: {c.covered} of {show(c.eligible)} covered, {show(c.missing)} missing, {c.excluded} excluded
      {c.exclusion_reasons.length > 0 ? ` (${c.exclusion_reasons.map((x) => `${x.code} ${x.count}`).join(", ")})` : ""}
      {c.reason ? <span className="muted"> · {c.reason}</span> : null}
    </span>
  );
}

function SourceBanner({ sources, omissions }: { sources: ReportSource[]; omissions: string[] }) {
  const down = sources.filter((s) => s.state !== "available");
  return (
    <>
      {down.length > 0 ? (
        <div className="error" role="alert" data-testid="unavailable-sources">
          {down.map((s) => (
            <p key={s.source_id}>
              Source <code>{s.names.join(", ") || s.source_id}</code> is unavailable: {s.reason ?? "no reason recorded"}. Its values are unknown, not zero.
            </p>
          ))}
        </div>
      ) : null}
      {omissions.length > 0 ? (
        <details className="card" data-testid="omissions">
          <summary>Omissions ({omissions.length})</summary>
          <ul>
            {omissions.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function headline(e: ReportEntry): string {
  if (e.state === "refused") return `refused (${e.refusal.code})`;
  if (e.points.length === 1 && e.points[0]!.key === "all") return show(e.points[0]!.value);
  return `${e.points.length} groups`;
}

function MetricChart({ e, scope }: { e: ServedEntry; scope: MetricReport["scope"] }) {
  const rows = e.points.map((p) => ({ key: p.key, value: p.value }));
  const caption = `Unit: ${e.unit_label} (${e.unit}). Filters: ${filterText(scope.filters)}. Window [${e.query.window.from}, ${e.query.window.to}) ${e.query.window.timezone}, ${e.window_basis}. Grouped by ${scope.group_by}.`;
  return (
    <figure className="card" data-testid="metric-chart">
      <div role="img" aria-label={`${e.name} (${e.metric_id}) in ${e.unit_label}`} style={{ width: "100%", height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="key" />
            <YAxis label={{ value: e.unit_label, angle: -90, position: "insideLeft" }} />
            <Tooltip />
            <Bar dataKey="value" name={e.unit_label} fill="var(--color-accent)" isAnimationActive={!prefersReducedMotion} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption data-testid="chart-caption">{caption} Unknown values have no bar; see the table.</figcaption>
    </figure>
  );
}

function DrilldownPanel({ e, point, groupBy }: { e: ServedEntry; point: SeriesPoint; groupBy: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const body = { request: readRequest(e, "metric_drilldown", cursor), point_key: point.key, group_by: groupBy };
  const st = usePost<Drilldown>(api.projectMetricDrilldown(), body);
  return (
    <div className="card" data-testid="drilldown" aria-live="polite">
      <h4>
        Evidence for <code>{point.key}</code>
      </h4>
      {st.status === "loading" ? <div className="loading">Loading evidence...</div> : null}
      {st.status === "error" ? (
        <div className="error" role="alert">
          {st.error}
        </div>
      ) : null}
      {st.status === "success" && st.data ? (
        <>
          <p className="muted">
            {st.data.records.length} record(s) on this page · query <code>{st.data.query_hash}</code>
          </p>
          <ul data-testid="drilldown-records">
            {st.data.records.map((r) => (
              <li key={`${r.source_id}|${r.path}|${r.sha256}`}>
                <code>{r.source_id}</code> <code>{r.path}</code> <code>{r.sha256}</code> {r.observed_at} {r.availability}
                {r.reason ? ` · ${r.reason}` : ""}
              </li>
            ))}
          </ul>
          {st.data.next_cursor ? (
            <button type="button" onClick={() => setCursor(st.data!.next_cursor)}>
              Next page
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function RankingPanel({ e, groupBy }: { e: ServedEntry; groupBy: string }) {
  const [direction, setDirection] = useState<"asc" | "desc">("asc");
  const [difficulty, setDifficulty] = useState<Record<string, string>>({});
  const [body, setBody] = useState<unknown | null>(null);
  const st = usePost<{ ranking: Ranking }>(api.projectMetricAnalysis(), body);
  const declared = Object.fromEntries(Object.entries(difficulty).filter(([, v]) => v.trim() !== ""));
  return (
    <section className="card" data-testid="ranking">
      <h4>Rank groups</h4>
      <p className="muted">Ranks only inside a declared task difficulty. Unknown values and partial coverage are never ranked.</p>
      <label>
        Order{" "}
        <select value={direction} onChange={(ev) => setDirection(ev.target.value as "asc" | "desc")}>
          <option value="asc">lowest first</option>
          <option value="desc">highest first</option>
        </select>
      </label>
      <ul>
        {e.points.map((p) => (
          <li key={p.key}>
            <label>
              Difficulty of <code>{p.key}</code>{" "}
              <input value={difficulty[p.key] ?? ""} onChange={(ev) => setDifficulty({ ...difficulty, [p.key]: ev.target.value })} />
            </label>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setBody({ request: readRequest(e, "metric_series"), group_by: groupBy, direction, difficulty: declared })}>
        Rank
      </button>
      {st.status === "error" ? (
        <div className="error" role="alert">
          {st.error}
        </div>
      ) : null}
      {st.status === "success" && st.data ? (
        <div data-testid="ranking-result">
          {st.data.ranking.ranked ? null : <p>Not ranked: {st.data.ranking.reason}</p>}
          {st.data.ranking.strata.map((s) => (
            <table key={s.difficulty}>
              <caption>Difficulty {s.difficulty}</caption>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Group</th>
                  <th>Value ({e.unit_label})</th>
                </tr>
              </thead>
              <tbody>
                {s.entries.map((x) => (
                  <tr key={x.key}>
                    <td>{x.rank}</td>
                    <td>
                      <code>{x.key}</code>
                    </td>
                    <td>{String(x.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
          {st.data.ranking.unranked.length > 0 ? (
            <ul data-testid="unranked">
              {st.data.ranking.unranked.map((u) => (
                <li key={u.key}>
                  <code>{u.key}</code> not ranked ({show(u.value)}): {u.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ComparePanel({ e, groupBy }: { e: ServedEntry; groupBy: string }) {
  const keys = e.points.map((p) => p.key);
  const [a, setA] = useState(keys[0] ?? "");
  const [b, setB] = useState(keys[1] ?? keys[0] ?? "");
  const [body, setBody] = useState<unknown | null>(null);
  const st = usePost<{ comparison: CohortComparison }>(api.projectMetricCompare(), body);
  const side = (k: string) => ({ request: readRequest(e, "metric_series"), group_by: groupBy, point_key: k });
  const c = st.data?.comparison;
  return (
    <section className="card" data-testid="compare">
      <h4>Compare two groups</h4>
      <label>
        A{" "}
        <select value={a} onChange={(ev) => setA(ev.target.value)}>
          {keys.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>{" "}
      <label>
        B{" "}
        <select value={b} onChange={(ev) => setB(ev.target.value)}>
          {keys.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>{" "}
      <button type="button" onClick={() => setBody({ a: side(a), b: side(b) })}>
        Compare
      </button>
      {st.status === "error" ? (
        <div className="error" role="alert">
          {st.error}
        </div>
      ) : null}
      {c ? (
        <div data-testid="compare-result">
          <p>
            <strong>{c.label === "descriptive_only" ? "Descriptive only" : "Not comparable"}</strong>. {c.statement}
          </p>
          {c.a && c.b ? (
            <p>
              <code>{c.a.key}</code> {show(c.a.value)} · <code>{c.b.key}</code> {show(c.b.value)} · B − A:{" "}
              {c.difference === null ? `not computed (${c.difference_reason})` : `${String(c.difference)} ${e.unit_label}`}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function MetricDetail({ e, report }: { e: ServedEntry; report: MetricReport }) {
  const [drill, setDrill] = useState<SeriesPoint | null>(null);
  const samples = SAMPLE_COUNT[e.metric_id] ? report.metrics.find((m) => m.metric_id === SAMPLE_COUNT[e.metric_id]) : undefined;
  const groupBy = report.scope.group_by;
  return (
    <section data-testid="metric-detail">
      <h3>
        {e.name} <code>{e.metric_id}</code>
      </h3>
      <dl className="kv-grid">
        <dt>Unit</dt>
        <dd>
          {e.unit_label} ({e.unit})
        </dd>
        <dt>Formula</dt>
        <dd>
          {e.formula} · <code>{e.formula_version}</code>
        </dd>
        <dt>Scope</dt>
        <dd>
          {e.scope}. Filters: {filterText(report.scope.filters)}. Grouped by {groupBy}.
        </dd>
        <dt>Missingness</dt>
        <dd>{e.missingness}</dd>
        <dt>Coverage</dt>
        <dd>
          <CoverageText c={e.coverage} />
        </dd>
        <dt>Cost basis</dt>
        <dd data-testid="cost-basis">
          {e.cost_bases.join(", ")}
          {e.pricing ? ` · pricing ${e.pricing.version}, source ${e.pricing.source_hash}` : ""}
        </dd>
        <dt>Usage semantics</dt>
        <dd>{e.usage_semantics}</dd>
        <dt>Query</dt>
        <dd>
          <code>{e.query_hash}</code>
        </dd>
        {samples ? (
          <>
            <dt>Sample count</dt>
            <dd data-testid="sample-count">
              {samples.state === "served"
                ? samples.points.map((p) => `${p.key}: n = ${show(p.value)}`).join("; ")
                : `refused: ${samples.refusal.message}`}{" "}
              (<code>{samples.metric_id}</code>)
            </dd>
          </>
        ) : null}
      </dl>
      <MetricChart e={e} scope={report.scope} />
      <div className="table-scroll">
        <table data-testid="exact-values">
          <caption>Exact values ({e.unit_label})</caption>
          <thead>
            <tr>
              <th>Group</th>
              <th>Value</th>
              <th>Known subtotal</th>
              <th>Exact total</th>
              <th>Numerator / denominator</th>
              <th>Coverage</th>
              <th>Cost basis</th>
              <th>Reason</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {e.points.map((p) => (
              <tr key={p.key} data-testid={`point-${p.key}`}>
                <td>
                  <code>{p.key}</code>
                </td>
                <td>{show(p.value)}</td>
                <td>{show(p.known_subtotal)}</td>
                <td>{show(p.exact_total)}</td>
                <td>
                  {show(p.numerator)} / {show(p.denominator)}
                </td>
                <td>
                  <CoverageText c={p.coverage} />
                </td>
                <td>{p.cost_basis}</td>
                <td>{p.reason ?? "—"}</td>
                <td>
                  <button type="button" onClick={() => setDrill(p)} aria-label={`Evidence for ${p.key}`}>
                    Evidence
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {drill ? <DrilldownPanel key={`${e.query_hash}|${drill.key}`} e={e} point={drill} groupBy={groupBy} /> : null}
      {groupBy !== "all" && e.points.length > 1 ? (
        <>
          <RankingPanel key={`r|${e.query_hash}`} e={e} groupBy={groupBy} />
          <ComparePanel key={`c|${e.query_hash}`} e={e} groupBy={groupBy} />
        </>
      ) : null}
    </section>
  );
}

function download(report: MetricReport) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `metric-report-${report.report_hash.replace(/^sha256:/, "").slice(0, 12)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function MetricsPage() {
  const [initiative, setInitiative] = useState("");
  const [groupBy, setGroupBy] = useState<(typeof GROUPS)[number]>("all");
  const [applied, setApplied] = useState<{ group_by: string; filters?: QueryFilter[] }>({ group_by: "all" });
  const [selected, setSelected] = useState<string | null>(null);
  const st = usePost<MetricReport>(api.projectMetricReport(), applied);
  const report = st.data;
  const entry = report?.metrics.find((m) => m.metric_id === selected);
  return (
    <div className="page">
      <h1>Metrics</h1>
      <form
        className="card"
        onSubmit={(ev) => {
          ev.preventDefault();
          setSelected(null);
          const id = initiative.trim();
          setApplied({ group_by: groupBy, ...(id ? { filters: [{ dimension: "initiative", values: [id] }] } : {}) });
        }}
      >
        <label>
          Initiative{" "}
          <input value={initiative} onChange={(ev) => setInitiative(ev.target.value)} placeholder="all initiatives" />
        </label>{" "}
        <label>
          Group by{" "}
          <select value={groupBy} onChange={(ev) => setGroupBy(ev.target.value as (typeof GROUPS)[number])}>
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>{" "}
        <button type="submit">Apply</button>
      </form>
      {st.status === "loading" ? <div className="loading">Loading metrics...</div> : null}
      {st.status === "error" ? (
        <div className="error" role="alert">
          Could not load metrics: {st.error}
        </div>
      ) : null}
      {report ? (
        <>
          <p data-testid="report-scope">
            Snapshot {report.snapshot.as_of}, digest <code>{report.snapshot.input_manifest_digest}</code>. Filters: {filterText(report.scope.filters)}. Window [
            {report.scope.window.from}, {report.scope.window.to}) {report.scope.window.timezone}. Grouped by {report.scope.group_by}.
          </p>
          <SourceBanner sources={report.sources} omissions={report.omissions} />
          <p>
            <button type="button" onClick={() => download(report)}>
              Export report (JSON)
            </button>{" "}
            <span className="muted">
              {report.schema_version} · <code>{report.report_hash}</code>
            </span>
          </p>
          <div className="table-scroll">
            <table data-testid="metric-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Value</th>
                  <th>Unit</th>
                  <th>Coverage</th>
                  <th>Cost basis</th>
                  <th>Formula version</th>
                </tr>
              </thead>
              <tbody>
                {report.metrics.map((m) => (
                  <tr key={m.metric_id} data-testid={`metric-${m.metric_id}`} aria-selected={m.metric_id === selected}>
                    <td>
                      <button type="button" onClick={() => setSelected(m.metric_id)}>
                        {m.name}
                      </button>{" "}
                      <code>{m.metric_id}</code>
                    </td>
                    <td>{headline(m)}</td>
                    <td>{m.state === "served" ? m.unit_label : m.unit}</td>
                    <td>{m.state === "served" ? <CoverageText c={m.coverage} /> : m.refusal.message}</td>
                    <td>{m.state === "served" ? m.cost_bases.join(", ") : "—"}</td>
                    <td>
                      <code>{m.formula_version}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {entry?.state === "served" ? <MetricDetail key={entry.query_hash} e={entry} report={report} /> : null}
          {entry?.state === "refused" ? (
            <div className="error" role="alert" data-testid="metric-refused">
              {entry.name} ({entry.metric_id}) is refused for this scope: {entry.refusal.code}: {entry.refusal.message}. Formula: {entry.formula}. Missingness: {entry.missingness}.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
