import { Fragment, useCallback, useEffect, useState, type CSSProperties } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useRunStatus } from "../hooks/useRunStatus";
import { useFetch } from "../hooks/useFetch";
import { StageGraph } from "../components/StageGraph";
import { ArtifactList } from "../components/ArtifactList";
import { MetricBreakdown } from "../components/MetricBreakdown";
import { ScoreCard } from "../components/ScoreCard";
import { LifecycleTimeline } from "../components/LifecycleTimeline";
import { api } from "../lib/api";
import AnalysisJobPanel from "../components/AnalysisJobPanel";
import RecommendationPanel from "../components/RecommendationPanel";
import type { LifecycleRunRecord, MetricsJson } from "../../../src/types";

export default function RunDetailPage() {
  const params = useParams<{ run_id: string }>();
  const runId = params.run_id;
  const [searchParams] = useSearchParams();
  const guild = searchParams.get("guild") ?? undefined;
  const { data: fetched, error, status, isPolling } = useRunStatus(runId);
  const [selectedStage, setSelectedStage] = useState<string | undefined>(undefined);

  // SC-9: fetch the lifecycle record once the run is terminal (not polling).
  // 404 is expected for standard benchmark runs — the component hides the
  // section in that case. Deferring until terminal keeps polling-contract
  // tests predictable (no extra fetch during the non-terminal phase).
  const lifecycleUrl =
    runId && !isPolling && status === "success" ? api.lifecycleRecord(runId) : null;
  const { data: lifecycleRecord } = useFetch<LifecycleRunRecord>(lifecycleUrl);

  // useFetch keeps the previous run's data across a route change. Treat the
  // object present when runId changed as stale until a new response lands.
  const [route, setRoute] = useState<{ runId?: string; stale?: unknown }>({ runId });
  if (route.runId !== runId) setRoute({ runId, stale: fetched });
  const data = fetched !== undefined && fetched !== route.stale ? fetched : undefined;

  // Live project runs often have no benchmark record: the benchmark read
  // fails (and keeps polling), yet diagnostics must still load. Sticky per
  // run id so the error -> loading flip of each poll does not remount it.
  const [missingFor, setMissingFor] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (data) setMissingFor(undefined);
    else if (status === "error") setMissingFor(runId);
  }, [data, status, runId]);
  const showDiagnostics = !!runId && (data ? !isPolling : missingFor === runId);

  return (
    <section>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <h1>
          Run <code>{runId}</code>
        </h1>
        <Link to="/runs">← all runs</Link>
      </header>

      {isPolling ? (
        <div
          className="loading"
          role="status"
          aria-live="polite"
          data-testid="run-in-progress-banner"
        >
          Run in progress… (polling every 2s until terminal)
        </div>
      ) : null}

      {status === "loading" && !data ? (
        <div className="loading">Loading run…</div>
      ) : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {error?.message ?? "failed to load run"}
        </div>
      ) : null}
      {status === "success" && data ? (
        <>
          <ScoreCard score={data.score} caption="Score" />

          <section>
            <h2>Stages</h2>
            <StageGraph
              metrics={data.metrics}
              selected={selectedStage}
              onSelect={setSelectedStage}
            />
            {selectedStage ? (
              <p className="muted">
                Selected: <code>{selectedStage}</code> — gate outcome{" "}
                <code>
                  {data.metrics.gate_outcomes[selectedStage] ?? "missing"}
                </code>
              </p>
            ) : (
              <p className="muted">Select a stage to see its gate outcome.</p>
            )}
          </section>

          <section>
            <h2>Score components</h2>
            <MetricBreakdown score={data.score} />
          </section>

          <section>
            <h2>Artifacts</h2>
            <ArtifactList detail={data} />
          </section>

          {lifecycleRecord ? (
            <LifecycleTimeline entries={lifecycleRecord.timeline} />
          ) : null}


          <section>
            <h2>Run metadata</h2>
            <dl className="kv-grid">
              <dt>Started</dt>
              <dd>{data.run.started_at}</dd>
              <dt>Completed</dt>
              <dd>{data.run.completed_at}</dd>
              <dt>Wall clock</dt>
              <dd>
                {data.run.wall_clock_ms != null
                  ? `${data.run.wall_clock_ms} ms`
                  : "—"}
              </dd>
              <dt>Wall budget</dt>
              <dd>
                {data.run.wall_clock_budget_ms != null
                  ? `${data.run.wall_clock_budget_ms} ms`
                  : "—"}
              </dd>
              <dt>Specialists dispatched</dt>
              <dd>
                {data.metrics.dispatched_specialists.join(", ") || (
                  <span className="muted">none</span>
                )}
              </dd>
              <dt>Expected specialists</dt>
              <dd>{data.metrics.expected_specialists.join(", ")}</dd>
              <dt>Events</dt>
              <dd>
                <code>{data.events.length}</code>
              </dd>
              <dt>Loop rounds</dt>
              <dd data-testid="loop-rounds-per-lane">
                {formatLoopRounds(data.metrics.loop_rounds_per_lane)}
              </dd>
              {data.run.auth_identity_hash ? (
                <>
                  <dt>Auth identity</dt>
                  <dd>
                    <code
                      title={data.run.auth_identity_hash}
                      data-testid="auth-identity-hash-badge"
                      className="muted"
                    >
                      {data.run.auth_identity_hash.slice(0, 7)}…
                    </code>
                  </dd>
                </>
              ) : null}
              {data.score.model_family ? (
                <>
                  <dt>Model family</dt>
                  <dd>
                    <code
                      data-testid="model-family-chip"
                      className="muted"
                    >
                      {data.score.model_family}
                    </code>
                  </dd>
                </>
              ) : null}
            </dl>
          </section>
        </>
      ) : null}
      {showDiagnostics ? <RunDiagnosticSection runId={runId!} guild={guild} /> : null}
    </section>
  );
}

function formatLoopRounds(rounds: MetricsJson["loop_rounds_per_lane"]): string {
  const lanes = Object.entries(rounds);
  if (lanes.length === 0) return "none";
  return lanes
    .map(([lane, layers]) => {
      const total = Object.values(layers).reduce(
        (sum, layer) => sum + (layer?.ended ?? layer?.started ?? 0),
        0,
      );
      return `${lane}: ${total}`;
    })
    .join(", ");
}

// ---- E01 — evidence-first diagnostic analysis (C-ANALYSIS / C-JOBS) -------
//
// Renders plugin-produced analysis artifacts exactly as the D01 reader
// returns them from GET /api/project/analysis/artifacts. The benchmark score
// above is a separate product concept: nothing here is a quality score, and
// evidence completeness is only "which of the 11 evidence parts exist".
// Absent fields render "not reported", never zero or success. ComparePage
// imports these exports so both routes share one rendering.

// Local wire mirrors of benchmark/src/types.ts (D01). Kept here because the
// UI write scope cannot touch the shared types file.
export type AnalysisValidation =
  | "valid"
  | "partial"
  | "malformed"
  | "unsupported_schema"
  | "wrong_source"
  | "absent";

export interface AnalysisFreshness {
  state: string;
  reason: string | null;
  decision_eligible?: boolean;
}

export interface AnalysisSummary {
  kind: "run" | "comparison";
  id: string;
  source_guild: string;
  analysis_id: string | null;
  schema_version: string | null;
  artifact_eligible: boolean | null;
  validation: AnalysisValidation;
  invalid_recommendation_rows: number;
  recommendation_count: number;
  finding_count: number;
}

export interface AnalysisListResponse {
  artifacts: AnalysisSummary[];
  total: number;
}

export interface AnalysisDetailResponse {
  summary: AnalysisSummary;
  artifact?: Record<string, unknown>;
  recommendations: Array<Record<string, unknown>>;
  invalid_recommendation_lines: number;
  freshness: AnalysisFreshness;
}

/** Same rule as the server's isSafeAnalysisId (analysis-process.ts). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isSafeAnalysisId(id: string): boolean {
  return SAFE_ID.test(id);
}

export const analysisApi = {
  list: () => `${api.base}/project/analysis/artifacts`,
  detail: (kind: "run" | "comparison", id: string, guild?: string) =>
    `${api.base}/project/analysis/artifacts?kind=${kind}&id=${encodeURIComponent(id)}${
      guild ? `&guild=${encodeURIComponent(guild)}` : ""
    }`,
};

/** Long and shuffled ids wrap instead of overflowing at 320px. */
export const WRAP: CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 };

export type AnalysisRead<T> =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; data: T }
  | { state: "unconfigured"; hint: string | null }
  | { state: "unavailable"; message: string }
  | { state: "malformed"; message: string }
  | { state: "error"; message: string };

const VALIDATIONS: readonly string[] = ["valid", "partial", "malformed", "unsupported_schema", "wrong_source", "absent"];

function isNullable<T>(v: unknown, check: (x: unknown) => x is T): boolean {
  return v === null || check(v);
}
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Structural check of one D01 summary row; anything off is malformed. */
export function isAnalysisSummary(v: unknown): v is AnalysisSummary {
  const s = rec(v);
  return (
    !!s &&
    (s.kind === "run" || s.kind === "comparison") &&
    isStr(s.id) &&
    isStr(s.source_guild) &&
    isNullable(s.analysis_id, isStr) &&
    isNullable(s.schema_version, isStr) &&
    isNullable(s.artifact_eligible, isBool) &&
    isStr(s.validation) &&
    VALIDATIONS.includes(s.validation) &&
    isNum(s.invalid_recommendation_rows) &&
    isNum(s.recommendation_count) &&
    isNum(s.finding_count)
  );
}

export function isAnalysisListResponse(v: unknown): v is AnalysisListResponse {
  const b = rec(v);
  return !!b && Array.isArray(b.artifacts) && b.artifacts.every(isAnalysisSummary) && isNum(b.total);
}

export function isAnalysisDetailResponse(v: unknown): v is AnalysisDetailResponse {
  const b = rec(v);
  const f = rec(b?.freshness);
  return (
    !!b &&
    isAnalysisSummary(b.summary) &&
    (b.artifact === undefined || !!rec(b.artifact)) &&
    Array.isArray(b.recommendations) &&
    b.recommendations.every((r) => !!rec(r)) &&
    isNum(b.invalid_recommendation_lines) &&
    !!f &&
    isStr(f.state) &&
    isNullable(f.reason, isStr) &&
    (f.decision_eligible === undefined || isBool(f.decision_eligible))
  );
}

/** Fetch that keeps the HTTP status meaning: 503 analysis_package_unconfigured
 * is a disabled state, 404 is "not available here", not an error. A 2xx body
 * that fails `validate` is "malformed" and never reaches render. */
export function useAnalysisRead<T>(
  url: string | null,
  validate: (body: unknown) => body is T,
  reload = 0,
): AnalysisRead<T> {
  const [read, setRead] = useState<AnalysisRead<T>>(url ? { state: "loading" } : { state: "idle" });
  useEffect(() => {
    if (!url) {
      setRead({ state: "idle" });
      return;
    }
    const ac = new AbortController();
    setRead({ state: "loading" });
    fetch(url, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (res) => {
        const parsed: unknown = await res.json().catch(() => undefined);
        if (ac.signal.aborted) return;
        if (res.ok) {
          if (validate(parsed)) setRead({ state: "ok", data: parsed });
          else setRead({ state: "malformed", message: "response does not match the analysis contract" });
          return;
        }
        const body = rec(parsed) ?? {};
        const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
        if (res.status === 503 && body.error === "analysis_package_unconfigured") {
          setRead({ state: "unconfigured", hint: typeof body.hint === "string" ? body.hint : null });
        } else if (res.status === 404) setRead({ state: "unavailable", message });
        else setRead({ state: "error", message });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setRead({ state: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => ac.abort();
  }, [url, reload]);
  return read;
}

// ---- defensive readers: a missing or mistyped field stays undefined ------

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const NOT_REPORTED = <span className="muted" data-testid="not-reported">not reported</span>;

// ---- assessment statuses -------------------------------------------------

const ASSESSMENT_STYLE: Record<string, { pill: string; label: string }> = {
  satisfied: { pill: "pass", label: "Satisfied" },
  violated: { pill: "fail", label: "Violated" },
  ambiguous: { pill: "timeout", label: "Ambiguous" },
  unobservable: { pill: "errored", label: "Unobservable" },
};

/** The four producer statuses + "not reported" + unrecognized, each distinct. */
/** Own-key lookup only: "__proto__" and friends never resolve. */
function known<T>(map: Record<string, T>, key: unknown): T | undefined {
  return typeof key === "string" && Object.hasOwn(map, key) ? map[key] : undefined;
}

export function AssessmentStatus({ status }: { status: unknown }) {
  if (status === undefined || status === null) {
    return (
      <span className="pill" data-assessment="not_reported">
        Not reported
      </span>
    );
  }
  const style = known(ASSESSMENT_STYLE, status);
  if (!style) {
    return (
      <span className="pill" data-assessment="unrecognized" style={WRAP}>
        Unrecognized: {String(status)}
      </span>
    );
  }
  return (
    <span className="pill" data-status={style.pill} data-assessment={status as string}>
      {style.label}
    </span>
  );
}

// ---- evidence references -------------------------------------------------

const RUN_REF = /^\.guild\/runs\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([^#]+)(#.*)?$/;

/** Only a relative `.guild/runs/<reported-run>/<contained path>` ref links,
 * and only to the in-app run view. Schemes, absolute paths, traversal and
 * unreported runs stay plain text. */
export function evidenceLinkTarget(
  ref: string,
  reportedRuns: readonly string[],
): { runId: string; path: string; ref: string } | { refused: string } {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) return { refused: "URL scheme" };
  if (ref.includes("\\") || ref.includes("\0")) return { refused: "unsafe characters" };
  const m = RUN_REF.exec(ref);
  if (!m) return { refused: "not a run artifact reference" };
  const [, runId, rel] = m;
  const segments = rel.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
    return { refused: "path traversal" };
  }
  // Same rule the artifact route applies to the first path segment.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(segments[0])) return { refused: "URL scheme" };
  if (!reportedRuns.includes(runId)) return { refused: "run not reported by this artifact" };
  return { runId, path: rel, ref };
}

export function EvidenceRef({
  value,
  reportedRuns,
  guild,
}: {
  value: string;
  reportedRuns: readonly string[];
  guild: string;
}) {
  const target = evidenceLinkTarget(value, reportedRuns);
  if ("runId" in target) {
    // The reference opens in place (run, path, line), opens the file through
    // the project-run artifact route, and hands the ref to the run overview.
    const path = target.path;
    const fragment = /#.*$/.exec(target.ref)?.[0];
    const line = fragment ? /^#line:(\d+)$/.exec(fragment)?.[1] : undefined;
    return (
      <details data-testid="evidence-ref" data-ref-path={path} style={WRAP}>
        <summary style={WRAP}>
          <code style={WRAP}>{value}</code>
        </summary>
        <dl className="kv-grid" data-testid="evidence-ref-panel" style={WRAP}>
          <dt>Run</dt>
          <dd style={WRAP}><code style={WRAP}>{target.runId}</code></dd>
          <dt>Path</dt>
          <dd style={WRAP}><code style={WRAP}>{path}</code></dd>
          <dt>Line</dt>
          <dd data-testid="evidence-ref-line">{line ?? (fragment ? <code style={WRAP}>{fragment}</code> : "not reported")}</dd>
          <dt>Reference</dt>
          <dd style={WRAP}><code style={WRAP}>{value}</code></dd>
        </dl>
        <a
          href={api.projectRunArtifact(target.runId, path, guild)}
          data-testid="evidence-file-link"
          target="_blank"
          rel="noopener noreferrer"
          style={WRAP}
        >
          Open file
        </a>{" "}
        <Link
          to={`/project-runs/${encodeURIComponent(target.runId)}?guild=${encodeURIComponent(guild)}&ref=${encodeURIComponent(path)}`}
          data-testid="evidence-link"
          data-ref-path={path}
          title={value}
          style={WRAP}
        >
          Open run overview
        </Link>
      </details>
    );
  }
  return (
    <span data-testid="evidence-unlinked" title={`Not linked: ${target.refused}`} style={WRAP}>
      <code style={WRAP}>{value}</code> <span className="muted">(not linked: {target.refused})</span>
    </span>
  );
}

function EvidenceList({
  refs,
  reportedRuns,
  guild,
}: {
  refs: unknown;
  reportedRuns: readonly string[];
  guild: string;
}) {
  const list = strs(refs);
  if (list.length === 0) return <span className="muted">no evidence references</span>;
  return (
    <ul className="evidence-refs" style={{ ...WRAP, margin: 0, paddingLeft: 18 }}>
      {list.map((ref) => (
        <li key={ref} style={WRAP}>
          <EvidenceRef value={ref} reportedRuns={reportedRuns} guild={guild} />
        </li>
      ))}
    </ul>
  );
}

// ---- freshness / validation ---------------------------------------------

const FRESHNESS_TEXT: Record<string, string> = {
  current: "Current: the producer confirmed this artifact matches its sources.",
  stale: "Stale: sources changed since this analysis. Re-run analysis before relying on it.",
  missing: "Missing: no analysis exists for this target yet.",
  unsupported: "Unsupported: the diagnostics contract is not supported. No new conclusions are drawn.",
  refused: "Refused: the producer refused to inspect this artifact.",
  unavailable: "Freshness unknown: no analysis package is configured.",
  error: "Freshness unknown: the producer inspection failed.",
};

const VALIDATION_TEXT: Record<AnalysisValidation, string> = {
  valid: "Artifact validated.",
  partial: "Partial: the artifact validates but some recommendation rows do not.",
  malformed: "Malformed: the artifact was refused and is not shown.",
  unsupported_schema: "Unsupported schema: the artifact is not shown.",
  wrong_source: "Wrong source: the artifact does not belong to this source and is not shown.",
  absent: "No local artifact.",
};

/** A producer state outside FRESHNESS_TEXT is shown as "unsupported". */
export function freshnessState(state: string): string {
  return known(FRESHNESS_TEXT, state) === undefined ? "unsupported" : state;
}

export function FreshnessNotice({ detail }: { detail: AnalysisDetailResponse }) {
  const { freshness, summary } = detail;
  const state = freshnessState(freshness.state);
  return (
    <div
      className={state === "current" ? "card" : "empty"}
      data-testid="analysis-freshness"
      data-freshness={state}
      data-validation={summary.validation}
      role="status"
      style={WRAP}
    >
      <p style={{ margin: 0 }}>{FRESHNESS_TEXT[state]}</p>
      {state !== freshness.state ? (
        <p className="muted" style={{ margin: 0 }} data-testid="freshness-unrecognized">
          Unrecognized freshness state: <code style={WRAP}>{freshness.state}</code>
        </p>
      ) : null}
      {freshness.reason ? <p className="muted" style={{ margin: 0 }}>Reason: {freshness.reason}</p> : null}
      <p className="muted" style={{ margin: 0 }}>{known(VALIDATION_TEXT, summary.validation) ?? "Unsupported validation state."}</p>
      {summary.invalid_recommendation_rows > 0 || detail.invalid_recommendation_lines > 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Refused recommendation rows: {summary.invalid_recommendation_rows} in artifact,{" "}
          {detail.invalid_recommendation_lines} in ledger.
        </p>
      ) : null}
    </div>
  );
}

function boolText(v: boolean | null | undefined, yes: string, no: string) {
  if (v === true) return yes;
  if (v === false) return no;
  return "unknown";
}

function Eligibility({ detail }: { detail: AnalysisDetailResponse }) {
  const artifact = detail.summary.artifact_eligible;
  const decision = detail.freshness.decision_eligible;
  return (
    <>
      <dt>Artifact eligible</dt>
      <dd data-testid="artifact-eligible">
        {boolText(detail.summary.artifact_eligible, "yes", "no")}
      </dd>
      <dt>Decision eligible</dt>
      <dd data-testid="decision-eligible">
        {boolText(decision, "yes (producer inspection)", "no")}
      </dd>
      {typeof artifact === "boolean" && typeof decision === "boolean" && artifact !== decision ? (
        <>
          <dt>Why they differ</dt>
          <dd className="muted" data-testid="eligibility-note">
            Artifact eligibility comes from freshness and validation. Decision eligibility is the producer&apos;s
            expected-context check for each recommendation.
          </dd>
        </>
      ) : null}
    </>
  );
}

// ---- run analysis --------------------------------------------------------

const EVIDENCE_PARTS = 11;
const USAGE_METRICS = ["input", "output", "cached", "cost_usd", "duration_ms"] as const;
const ASSESSMENT_KEYS = ["instruction_following", "prompt_efficiency", "workflow", "tool_coverage"];

function Completeness({ value }: { value: unknown }) {
  const c = rec(value);
  if (!c) return <p data-testid="completeness">Evidence completeness: {NOT_REPORTED}</p>;
  const score = num(c.score);
  const present = strs(c.present);
  const missing = strs(c.missing);
  return (
    <div data-testid="completeness" style={WRAP}>
      <p style={{ margin: 0 }}>
        Evidence completeness:{" "}
        {score === undefined ? NOT_REPORTED : <strong data-testid="completeness-score">{score}%</strong>}{" "}
        <span className="muted">
          ({Array.isArray(c.present) ? `${present.length} of ${EVIDENCE_PARTS} evidence parts present` : "present parts not reported"})
        </span>
      </p>
      <p className="muted" style={{ margin: 0 }}>
        This counts which evidence exists. It is not a quality score.
      </p>
      {missing.length > 0 ? (
        <p style={{ margin: 0 }}>
          Missing evidence: {missing.map((m) => <code key={m} style={WRAP}>{m} </code>)}
        </p>
      ) : null}
    </div>
  );
}

function usageValue(usage: Record<string, unknown>, metric: (typeof USAGE_METRICS)[number]) {
  if (metric === "duration_ms") return num(usage.duration_ms);
  return num(rec(usage.tokens)?.[metric]);
}

function Usage({ value }: { value: unknown }) {
  const usage = rec(value);
  if (!usage) return <p data-testid="usage">Usage: {NOT_REPORTED}</p>;
  const availability = rec(usage.availability);
  return (
    <dl className="kv-grid" data-testid="usage">
      {USAGE_METRICS.map((metric) => {
        const legacy = usageValue(usage, metric);
        const entry = rec(availability?.[metric]);
        const state = str(entry?.state);
        let shown: React.ReactNode;
        if (state === "complete" && legacy !== undefined) shown = <code>{legacy}</code>;
        else if (state === "partial" && legacy !== undefined) {
          shown = (
            <>
              <code>{legacy}</code> <span className="muted">(observed subtotal)</span>
            </>
          );
        } else {
          // Legacy or unobserved: the stored total is not a measurement.
          const why = str(entry?.missing_reason) ?? (availability ? "unobserved" : "legacy_unknown");
          shown = (
            <span data-usage-unknown={metric}>
              unknown <span className="muted">({why}{legacy !== undefined ? `; stored total ${legacy} is not a measurement` : ""})</span>
            </span>
          );
        }
        return (
          <Fragment key={metric}>
            <dt>{metric}</dt>
            <dd>{shown}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

function RecommendationRows({
  rows,
  reportedRuns,
  guild,
}: {
  rows: Array<Record<string, unknown>>;
  reportedRuns: readonly string[];
  guild: string;
}) {
  if (rows.length === 0) return <p className="muted">No recommendations reported.</p>;
  return (
    <ul style={{ ...WRAP, paddingLeft: 18 }}>
      {rows.map((row, i) => (
        <li key={str(row.id) ?? i} data-testid="analysis-recommendation" style={WRAP}>
          <code style={WRAP}>{str(row.id) ?? "id not reported"}</code> · status{" "}
          <code>{str(row.status) ?? "not reported"}</code> · confidence{" "}
          {str(row.confidence) ?? "not reported"}
          <div>{str(row.proposed_action) ?? NOT_REPORTED}</div>
          <EvidenceList refs={row.evidence_refs} reportedRuns={reportedRuns} guild={guild} />
        </li>
      ))}
    </ul>
  );
}

function RunAnalysisBody({ detail }: { detail: AnalysisDetailResponse }) {
  const a = detail.artifact ?? {};
  const guild = detail.summary.source_guild;
  const runId = str(a.run_id) ?? detail.summary.id;
  const reported = [runId];
  const identity = rec(a.identity);
  const assessments = rec(a.assessments);
  const keys = [...ASSESSMENT_KEYS, ...Object.keys(assessments ?? {}).filter((k) => !ASSESSMENT_KEYS.includes(k))];
  const findings = Array.isArray(a.findings) ? a.findings.map(rec).filter((f): f is Record<string, unknown> => !!f) : undefined;
  return (
    <>
      <h3>Scope</h3>
      <dl className="kv-grid" data-testid="analysis-scope" style={WRAP}>
        <dt>Run</dt>
        <dd style={WRAP}><code style={WRAP}>{runId}</code></dd>
        <dt>Run scope</dt>
        <dd>{str(identity?.run_scope) ?? NOT_REPORTED}</dd>
        <dt>Initiative</dt>
        <dd style={WRAP}>{str(identity?.initiative_id) ?? NOT_REPORTED}</dd>
        <dt>Independent group</dt>
        <dd style={WRAP}>{str(identity?.independent_group_id) ?? NOT_REPORTED}</dd>
        <dt>Host / phase</dt>
        <dd>
          {str(identity?.host) ?? "host not reported"} / {str(identity?.phase) ?? "phase not reported"}
        </dd>
        <Eligibility detail={detail} />
      </dl>

      <h3>Completeness</h3>
      <Completeness value={a.completeness} />

      <h3>Assessments</h3>
      <ul style={{ ...WRAP, listStyle: "none", padding: 0 }}>
        {keys.map((key) => {
          const entry = rec(assessments?.[key]);
          return (
            <li key={key} data-testid={`assessment-${key}`} style={{ ...WRAP, marginBottom: 8 }}>
              <strong>{key}</strong> <AssessmentStatus status={entry?.status} />
              {entry ? <EvidenceList refs={entry.evidence_refs} reportedRuns={reported} guild={guild} /> : null}
            </li>
          );
        })}
      </ul>

      <h3>Findings</h3>
      {findings === undefined ? (
        <p>{NOT_REPORTED}</p>
      ) : findings.length === 0 ? (
        <p className="muted">No findings reported.</p>
      ) : (
        <ul style={{ ...WRAP, paddingLeft: 18 }}>
          {findings.map((f, i) => (
            <li key={str(f.id) ?? i} data-testid="analysis-finding" style={WRAP}>
              <strong>{str(f.kind) ?? "kind not reported"}</strong> · severity{" "}
              {str(f.severity) ?? "not reported"}
              <div>{str(f.summary) ?? NOT_REPORTED}</div>
              {str(f.signature) ? <code style={WRAP}>{str(f.signature)}</code> : null}
              <EvidenceList refs={f.evidence_refs} reportedRuns={reported} guild={guild} />
            </li>
          ))}
        </ul>
      )}

      <h3>Usage</h3>
      <Usage value={a.usage} />

      <h3>Recommendations</h3>
      <RecommendationRows rows={detail.recommendations} reportedRuns={reported} guild={guild} />
    </>
  );
}

function ComparisonAnalysisBody({ detail }: { detail: AnalysisDetailResponse }) {
  const a = detail.artifact ?? {};
  const guild = detail.summary.source_guild;
  const runIds = strs(a.run_ids);
  const hashes = strs(a.source_hashes);
  const c = rec(a.completeness);
  const signatures = Array.isArray(a.repeated_signatures)
    ? a.repeated_signatures.map(rec).filter((s): s is Record<string, unknown> => !!s)
    : undefined;
  const eligibleRuns = num(c?.eligible_runs);
  const totalRuns = num(c?.total_runs);
  const average = num(c?.average_score);
  return (
    <>
      <h3>Scope</h3>
      <ol data-testid="comparison-runs" style={{ ...WRAP, paddingLeft: 18 }}>
        {runIds.length === 0 ? <li>{NOT_REPORTED}</li> : null}
        {runIds.map((id, i) => (
          <li key={id} style={WRAP}>
            <code style={WRAP}>{id}</code>{" "}
            <span className="muted" style={WRAP}>source hash {hashes[i] ?? "not reported"}</span>
          </li>
        ))}
      </ol>
      <dl className="kv-grid">
        <Eligibility detail={detail} />
      </dl>

      <h3>Completeness</h3>
      <div data-testid="completeness">
        <p style={{ margin: 0 }}>
          Eligible runs:{" "}
          {eligibleRuns === undefined || totalRuns === undefined ? NOT_REPORTED : `${eligibleRuns} of ${totalRuns}`}
        </p>
        <p style={{ margin: 0 }}>
          Average evidence completeness:{" "}
          {average === undefined ? NOT_REPORTED : <strong data-testid="completeness-score">{average}%</strong>}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          This counts which evidence exists. It is not a quality score.
        </p>
      </div>

      <h3>Repeated signatures</h3>
      {signatures === undefined ? (
        <p>{NOT_REPORTED}</p>
      ) : signatures.length === 0 ? (
        <p className="muted">No repeated signatures reported.</p>
      ) : (
        <ul style={{ ...WRAP, paddingLeft: 18 }}>
          {signatures.map((s, i) => (
            <li key={str(s.signature) ?? i} data-testid="analysis-finding" style={WRAP}>
              <code style={WRAP}>{str(s.signature) ?? "signature not reported"}</code> ·{" "}
              {num(s.occurrences) === undefined ? "occurrences not reported" : `${num(s.occurrences)} occurrences`}{" "}
              in {strs(s.runs).map((r) => <code key={r} style={WRAP}>{r} </code>)}
            </li>
          ))}
        </ul>
      )}

      <h3>Recommendations</h3>
      <RecommendationRows rows={detail.recommendations} reportedRuns={runIds} guild={guild} />
    </>
  );
}

const SHOWN_VALIDATION: AnalysisValidation[] = ["valid", "partial"];

/** One analysis artifact detail: freshness first, then the evidence. */
export function AnalysisDetailView({ detail }: { detail: AnalysisDetailResponse }) {
  const shown = SHOWN_VALIDATION.includes(detail.summary.validation) && detail.artifact;
  return (
    <section data-testid="analysis-detail" data-kind={detail.summary.kind} style={WRAP}>
      <p className="muted" style={WRAP}>
        {detail.summary.kind === "run" ? "Run analysis" : "Comparison analysis"}{" "}
        <code style={WRAP}>{detail.summary.analysis_id ?? detail.summary.id}</code> from{" "}
        <code style={WRAP}>{detail.summary.source_guild}</code>
      </p>
      <FreshnessNotice detail={detail} />
      {shown ? (
        detail.summary.kind === "run" ? (
          <RunAnalysisBody detail={detail} />
        ) : (
          <ComparisonAnalysisBody detail={detail} />
        )
      ) : null}
    </section>
  );
}

// ---- exact analysis actions (C-JOBS request shape) -----------------------

export interface AnalysisJobRequestPreview {
  source_guild: string;
  operation: "analyze" | "compare" | "inspect";
  target_kind: "run" | "runs" | "initiative" | "independent" | "comparison";
  ids: string[];
}

export interface AnalysisActionItem {
  key: string;
  label: string;
  request: AnalysisJobRequestPreview | null;
  disabledReason: string | null;
}

const MAX_SELECTED_RUNS = 100;

/** Builds one action; any unsafe or out-of-contract input disables it. */
export function buildAnalysisAction(
  key: string,
  label: string,
  request: AnalysisJobRequestPreview | null,
  missingReason: string,
): AnalysisActionItem {
  if (!request) return { key, label, request: null, disabledReason: missingReason };
  if (!request.source_guild) return { key, label, request, disabledReason: "source guild is unknown" };
  if (request.ids.length === 0) return { key, label, request, disabledReason: "no ids selected" };
  if (request.ids.length > MAX_SELECTED_RUNS) {
    return { key, label, request, disabledReason: `more than ${MAX_SELECTED_RUNS} ids` };
  }
  const unsafe = request.ids.find((id) => !isSafeAnalysisId(id));
  if (unsafe !== undefined) return { key, label, request, disabledReason: `unsupported id: ${unsafe}` };
  return { key, label, request, disabledReason: null };
}

/** Lists actions with their exact job request. Each job action mounts an
 * analysis job panel that can start only when the action is ready. Inspect
 * is not a job: the server runs it on every analysis read. */
export function AnalysisActionList({
  actions,
  blockedReason,
  onJobClosed,
  pollIntervalMs,
}: {
  actions: AnalysisActionItem[];
  blockedReason: string | null;
  onJobClosed?: () => void;
  pollIntervalMs?: number;
}) {
  return (
    <div className="command-list" data-testid="analysis-actions">
      {actions.map((action) => {
        const reason = blockedReason ?? action.disabledReason;
        const request = action.request;
        const job = request && request.operation !== "inspect" ? { ...request, operation: request.operation } : null;
        return (
          <div
            key={action.key}
            className="command-row"
            data-testid={`analysis-action-${action.key}`}
            data-action-state={reason ? "disabled" : "ready"}
            aria-disabled={reason ? true : undefined}
            style={{ ...WRAP, flexWrap: "wrap" }}
          >
            <span>{action.label}</span>
            {action.request ? <code style={WRAP}>{JSON.stringify(action.request)}</code> : null}
            {job ? (
              <div style={{ ...WRAP, flexBasis: "100%" }}>
                <AnalysisJobPanel
                  title={action.label}
                  startLabel={action.label}
                  request={reason ? null : job}
                  contextKey={JSON.stringify(job)}
                  disabledReason={reason}
                  pollIntervalMs={pollIntervalMs}
                  onClosed={onJobClosed}
                />
              </div>
            ) : (
              <span className="muted">
                {reason ? `Disabled: ${reason}` : "Runs when this page reads the analysis. No job is started."}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function analysisBlockedReason(read: AnalysisRead<unknown>): string | null {
  if (read.state === "unconfigured") {
    return `analysis package is not configured${read.hint ? ` (${read.hint})` : ""}`;
  }
  if (read.state === "unavailable") return `analysis is not available here (${read.message})`;
  if (read.state === "malformed") return `analysis response is malformed (${read.message})`;
  if (read.state === "error") return `analysis read failed (${read.message})`;
  if (read.state === "loading" || read.state === "idle") return "analysis state is loading";
  return null;
}

/** Freshness states where the producer can act on this target. */
const ACTIONABLE_FRESHNESS = ["current", "stale", "missing"];
const BLOCKING_VALIDATION: AnalysisValidation[] = ["unsupported_schema", "wrong_source"];

/** A 200 detail still blocks actions when the producer's own freshness or
 * validation says it cannot act (e.g. freshness "unavailable"). */
export function analysisDetailBlockedReason(read: AnalysisRead<AnalysisDetailResponse>): string | null {
  const base = analysisBlockedReason(read);
  if (base !== null || read.state !== "ok") return base;
  const { freshness, summary } = read.data;
  const state = freshnessState(freshness.state);
  if (!ACTIONABLE_FRESHNESS.includes(state)) {
    return `analysis freshness is ${state}${freshness.reason ? ` (${freshness.reason})` : ""}`;
  }
  if (BLOCKING_VALIDATION.includes(summary.validation)) return `analysis artifact is ${summary.validation}`;
  return null;
}

/** The server hint already says "start serve with"; the banner says it once. */
function serveFlag(hint: string | null): string {
  const flag = (hint ?? "").replace(/^start (the )?serve(r)? with\s+/i, "").trim();
  return flag || "--guild-plugin-package <absolute-packaged-plugin-root>";
}

/** Expected input hash for decisions, exactly as the artifact reports it. */
export function analysisInputHash(detail: AnalysisDetailResponse): string | null {
  return str(rec(detail.artifact?.diagnostics)?.input_hash) ?? null;
}

/** Explicit recommendation decisions for one shown analysis artifact. */
export function AnalysisDecisions({
  detail,
  onReread,
  pollIntervalMs,
}: {
  detail: AnalysisDetailResponse;
  onReread: () => void;
  pollIntervalMs?: number;
}) {
  if (!SHOWN_VALIDATION.includes(detail.summary.validation) || !detail.artifact) return null;
  return (
    <RecommendationPanel
      recommendations={detail.recommendations}
      sourceGuild={detail.summary.source_guild}
      sourceKind={detail.summary.kind}
      sourceId={detail.summary.id}
      sourceAnalysisId={detail.summary.analysis_id}
      sourceInputHash={analysisInputHash(detail)}
      decisionEligible={detail.freshness.decision_eligible}
      pollIntervalMs={pollIntervalMs}
      onDecided={onReread}
      onUnverified={onReread}
    />
  );
}

/** Shared state banner for every non-ok read. */
export function AnalysisReadState({ read, emptyLabel }: { read: AnalysisRead<unknown>; emptyLabel: string }) {
  switch (read.state) {
    case "idle":
      return <div className="empty">{emptyLabel}</div>;
    case "loading":
      return <div className="loading">Loading analysis…</div>;
    case "unconfigured":
      return (
        <div className="empty" role="status" data-testid="analysis-unconfigured">
          Analysis is unavailable: no analysis package is configured. Start the server with{" "}
          <code style={WRAP}>{serveFlag(read.hint)}</code>.
          Analysis actions are disabled.
        </div>
      );
    case "unavailable":
      return (
        <div className="empty" role="status" data-testid="analysis-unavailable" style={WRAP}>
          No analysis available: {read.message}
        </div>
      );
    case "malformed":
      return (
        <div className="error" role="alert" data-testid="analysis-malformed" style={WRAP}>
          Analysis response refused: {read.message}. Nothing is shown from it.
        </div>
      );
    case "error":
      return (
        <div className="error" role="alert" data-testid="analysis-error" style={WRAP}>
          Analysis read failed: {read.message}
        </div>
      );
    default:
      return null;
  }
}

function RunDiagnosticSection({ runId, guild }: { runId: string; guild?: string }) {
  const safe = isSafeAnalysisId(runId);
  const [reload, setReload] = useState(0);
  const reread = useCallback(() => setReload((n) => n + 1), []);
  const read = useAnalysisRead(safe ? analysisApi.detail("run", runId, guild) : null, isAnalysisDetailResponse, reload);
  const sourceGuild = read.state === "ok" ? read.data.summary.source_guild : guild ?? "";
  const actions = [
    buildAnalysisAction(
      "analyze-run",
      "Analyze this run",
      { source_guild: sourceGuild, operation: "analyze", target_kind: "run", ids: [runId] },
      "",
    ),
    buildAnalysisAction(
      "inspect-run",
      "Inspect analysis freshness",
      { source_guild: sourceGuild, operation: "inspect", target_kind: "run", ids: [runId] },
      "",
    ),
  ];
  return (
    <section data-testid="run-diagnostics">
      <h2>Diagnostic analysis</h2>
      <p className="muted">
        Evidence from the Guild analysis producer. This is separate from the benchmark score above.
      </p>
      {!safe ? (
        <div className="empty" role="status" data-testid="analysis-unsupported-id" style={WRAP}>
          Unsupported run id for analysis: <code style={WRAP}>{runId}</code>
        </div>
      ) : read.state === "ok" ? (
        <>
          <AnalysisDetailView detail={read.data} />
          <AnalysisDecisions detail={read.data} onReread={reread} />
        </>
      ) : (
        <AnalysisReadState read={read} emptyLabel="No analysis requested." />
      )}
      <h3>Analysis actions</h3>
      <AnalysisActionList
        actions={actions}
        blockedReason={safe ? analysisDetailBlockedReason(read) : "unsupported run id"}
        onJobClosed={reread}
      />
    </section>
  );
}
