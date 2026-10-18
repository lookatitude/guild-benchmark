import { useSearchParams } from "react-router-dom";
import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  Comparison,
  ProjectAnalysisResponse,
  ProjectComparisonResponse,
  ProjectComparisonTarget,
  ProjectComparisonTargetsResponse,
} from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { analyzeProjectTarget, api } from "../lib/api";
import { DeltaChart } from "../components/DeltaChart";
import { DeltaTable } from "../components/DeltaTable";
import { ReflectionBadge } from "../components/ReflectionBadge";
import {
  AnalysisActionList,
  AnalysisDetailView,
  AnalysisReadState,
  analysisApi,
  analysisBlockedReason,
  buildAnalysisAction,
  isAnalysisDetailResponse,
  isAnalysisListResponse,
  isSafeAnalysisId,
  useAnalysisRead,
  WRAP,
  type AnalysisJobRequestPreview,
  type AnalysisSummary,
} from "./RunDetailPage";

export default function ComparePage() {
  // Cross-route state lives in URL search params per p2-ui-architecture.md §3.3.
  const [params, setParams] = useSearchParams();
  const baseline = params.get("baseline") ?? "";
  const candidate = params.get("candidate") ?? "";
  const [analysis, setAnalysis] = useState<ProjectAnalysisResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<"idle" | "loading">("idle");

  const targets = useFetch<ProjectComparisonTargetsResponse>(api.projectComparisonTargets());
  const liveMode = targets.status === "success";
  const liveTargets = useMemo(
    () => targets.data?.targets.filter((target) => target.comparison_eligible) ?? [],
    [targets.data],
  );
  const baselineTarget = liveTargets.find((target) => target.id === baseline);
  const candidateOptions = baselineTarget
    ? liveTargets.filter((target) => target.kind === baselineTarget.kind)
    : liveTargets;
  const candidateTarget = candidateOptions.find((target) => target.id === candidate);

  const projectComparison = useFetch<ProjectComparisonResponse>(
    liveMode && baseline && candidate ? api.projectComparison(baseline, candidate) : null,
  );
  const legacyComparison = useFetch<Comparison>(
    targets.status === "error" && baseline && candidate
      ? api.comparison(baseline, candidate)
      : null,
  );

  useEffect(() => {
    if (!liveMode || !baselineTarget) return;
    if (candidate && !candidateOptions.some((target) => target.id === candidate)) {
      update("candidate", "");
    }
  }, [baselineTarget, candidate, candidateOptions, liveMode]);

  function update(field: "baseline" | "candidate", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(field, value);
    else next.delete(field);
    setParams(next);
  }

  function updateBaseline(value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set("baseline", value);
    else next.delete("baseline");
    next.delete("candidate");
    setParams(next);
  }

  async function analyze(target: ProjectComparisonTarget) {
    setAnalysisStatus("loading");
    setAnalysisError(null);
    try {
      const result = await analyzeProjectTarget({
        target_kind: target.kind,
        target_id: target.id,
        source_guild: target.source_guild,
      });
      setAnalysis(result);
    } catch (err) {
      setAnalysis(null);
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalysisStatus("idle");
    }
  }

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Evaluation</p>
          <h1>Compare</h1>
          <p className="muted">
            Compare eligible runs or complete initiatives, then hand off learning to Guild commands.
          </p>
        </div>
      </header>

      {targets.status === "loading" ? (
        <div className="loading">Loading eligible comparison targets...</div>
      ) : null}

      {liveMode ? (
        liveTargets.length === 0 ? (
          <div className="empty">
            No eligible runs or initiatives were found. Runs need trace events and a run manifest or provenance.
          </div>
        ) : (
          <form
            className="compare-selection-grid"
            onSubmit={(e) => e.preventDefault()}
            aria-label="Comparison target selection"
          >
            <div className="field">
              <label htmlFor="compare-baseline">Baseline</label>
              <select
                id="compare-baseline"
                name="compare-baseline"
                value={baseline}
                onChange={(e) => {
                  updateBaseline(e.target.value);
                  setAnalysis(null);
                }}
              >
                <option value="">Select a run or initiative</option>
                {renderTargetOptions(liveTargets)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="compare-candidate">Candidate</label>
              <select
                id="compare-candidate"
                name="compare-candidate"
                value={candidateTarget ? candidate : ""}
                onChange={(e) => {
                  update("candidate", e.target.value);
                  setAnalysis(null);
                }}
                disabled={!baselineTarget}
              >
                <option value="">
                  {baselineTarget ? "Select a matching target" : "Select baseline first"}
                </option>
                {renderTargetOptions(candidateOptions)}
              </select>
            </div>
            <div className="compare-actions">
              <button
                type="button"
                className="button-secondary"
                disabled={!baselineTarget || analysisStatus === "loading"}
                onClick={() => baselineTarget && analyze(baselineTarget)}
              >
                Analyze baseline
              </button>
              <button
                type="button"
                className="button-secondary"
                disabled={!candidateTarget || analysisStatus === "loading"}
                onClick={() => candidateTarget && analyze(candidateTarget)}
              >
                Analyze candidate
              </button>
            </div>
          </form>
        )
      ) : targets.status === "error" ? (
        <form
          className="compare-selection-grid"
          onSubmit={(e) => e.preventDefault()}
          aria-label="Trial set selection"
        >
          <div className="field">
            <label htmlFor="legacy-baseline">Baseline set id</label>
            <input
              id="legacy-baseline"
              name="legacy-baseline"
              value={baseline}
              onChange={(e) => update("baseline", e.target.value)}
              placeholder="e.g. demo-url-shortener-build-abcdef1-h0001"
            />
          </div>
          <div className="field">
            <label htmlFor="legacy-candidate">Candidate set id</label>
            <input
              id="legacy-candidate"
              name="legacy-candidate"
              value={candidate}
              onChange={(e) => update("candidate", e.target.value)}
              placeholder="e.g. demo-url-shortener-build-newcommit-h0001"
            />
          </div>
        </form>
      ) : null}

      {liveMode && analysis ? <AnalysisPanel analysis={analysis} /> : null}
      {liveMode ? (
        <DiagnosticSection baseline={baselineTarget} candidate={candidateTarget} />
      ) : null}
      {analysisError ? (
        <div className="error" role="alert">
          {analysisError}
        </div>
      ) : null}

      {!baseline || !candidate ? (
        <div className="empty">
          Select a baseline and candidate. The comparison URL is deep-linkable:{" "}
          <code>/compare?baseline=&lt;id&gt;&amp;candidate=&lt;id&gt;</code>.
        </div>
      ) : null}

      {projectComparison.status === "loading" || legacyComparison.status === "loading" ? (
        <div className="loading">Computing comparison…</div>
      ) : null}
      {projectComparison.status === "error" || legacyComparison.status === "error" ? (
        <div className="error" role="alert">
          {projectComparison.error?.message ??
            legacyComparison.error?.message ??
            "failed to load comparison"}
        </div>
      ) : null}

      {projectComparison.status === "success" && projectComparison.data ? (
        <ProjectComparisonSummary data={projectComparison.data} />
      ) : null}

      {legacyComparison.status === "success" && legacyComparison.data ? (
        <LegacyComparisonSummary data={legacyComparison.data} />
      ) : null}
    </section>
  );
}

function renderTargetOptions(targets: ProjectComparisonTarget[]) {
  const initiatives = targets.filter((target) => target.kind === "initiative");
  const runs = targets.filter((target) => target.kind === "run");
  return (
    <>
      {initiatives.length > 0 ? (
        <optgroup label="Initiatives">
          {initiatives.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label} ({target.run_count} runs)
            </option>
          ))}
        </optgroup>
      ) : null}
      {runs.length > 0 ? (
        <optgroup label="Runs">
          {runs.map((target) => (
            <option key={target.id} value={target.id}>
              {target.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

function AnalysisPanel({ analysis }: { analysis: ProjectAnalysisResponse }) {
  return (
    <section className="analysis-panel" data-testid="analysis-panel">
      <div>
        <p className="eyebrow">Analysis handoff</p>
        <h2>{analysis.target.label}</h2>
      </div>
      <ul>
        {analysis.signals.map((signal) => (
          <li key={signal}>{signal}</li>
        ))}
      </ul>
      <div className="command-list">
        {analysis.actions.map((action) => (
          <div key={`${action.intent}-${action.command}`} className="command-row">
            <span>{action.label}</span>
            <code>{action.command}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProjectComparisonSummary({ data }: { data: ProjectComparisonResponse }) {
  const eventDelta = data.candidate.total_events - data.baseline.total_events;
  return (
    <>
      <div className="card">
        <h2>Summary</h2>
        <div className="row" style={{ gap: 24 }}>
          <div>
            <div className="muted">Baseline runs</div>
            <div className="score-num" style={{ fontSize: 28, fontWeight: 700 }}>
              {data.baseline.target.run_count}
            </div>
            <div className="muted">{data.baseline.target.source_guild}</div>
          </div>
          <div>
            <div className="muted">Candidate runs</div>
            <div className="score-num" style={{ fontSize: 28, fontWeight: 700 }}>
              {data.candidate.target.run_count}
            </div>
            <div className="muted">{data.candidate.target.source_guild}</div>
          </div>
          <div>
            <div className="muted">Trace event delta</div>
            <div
              className="score-num"
              style={{
                fontSize: 28,
                fontWeight: 700,
                color:
                  eventDelta > 0
                    ? "var(--status-pass-fg)"
                    : eventDelta < 0
                      ? "var(--status-fail-fg)"
                      : undefined,
              }}
            >
              {eventDelta >= 0 ? "+" : ""}
              {eventDelta}
            </div>
          </div>
          <div>
            <div className="muted">Status</div>
            <div>
              <code>{data.status}</code>
            </div>
          </div>
        </div>
      </div>
      <section>
        <h2>Run status mix</h2>
        <div className="compare-status-grid">
          <StatusCounts title="Baseline" counts={data.baseline.status_counts} />
          <StatusCounts title="Candidate" counts={data.candidate.status_counts} />
        </div>
      </section>
      {data.notes.length > 0 ? (
        <section>
          <h2>Notes</h2>
          <ul>
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function StatusCounts({ title, counts }: { title: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts);
  return (
    <div className="card">
      <h3>{title}</h3>
      {entries.length === 0 ? (
        <p className="muted">No status records.</p>
      ) : (
        <dl className="kv-grid">
          {entries.map(([status, count]) => (
            <Fragment key={status}>
              <dt>{status}</dt>
              <dd>{count}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function LegacyComparisonSummary({ data }: { data: Comparison }) {
  return (
        <>
          <div className="card">
            <h2>Summary</h2>
            <div className="row" style={{ gap: 24 }}>
              <div>
                <div className="muted">Baseline mean</div>
                <div className="score-num" style={{ fontSize: 28, fontWeight: 700 }}>
                  {data.baseline.mean_guild_score.toFixed(2)}
                </div>
                <div className="muted">{data.baseline.run_count} runs</div>
              </div>
              <div>
                <div className="muted">Candidate mean</div>
                <div className="score-num" style={{ fontSize: 28, fontWeight: 700 }}>
                  {data.candidate.mean_guild_score.toFixed(2)}
                </div>
                <div className="muted">{data.candidate.run_count} runs</div>
              </div>
              <div>
                <div className="muted">Δ guild_score</div>
                <div
                  className="score-num"
                  style={{
                    fontSize: 28,
                    fontWeight: 700,
                    color:
                      data.guild_score_delta.delta > 0
                        ? "var(--status-pass-fg)"
                        : data.guild_score_delta.delta < 0
                          ? "var(--status-fail-fg)"
                          : undefined,
                  }}
                >
                  {data.guild_score_delta.delta >= 0 ? "+" : ""}
                  {data.guild_score_delta.delta.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="muted">Status</div>
                <div>
                  <code>{data.status}</code>
                </div>
              </div>
            </div>
          </div>

          {data.reflection_applied ? (
            <ReflectionBadge reflection={data.reflection_applied} />
          ) : null}

          <section>
            <h2>Per-component delta</h2>
            <DeltaChart comparison={data} />
            <DeltaTable comparison={data} />
          </section>

          {data.excluded_runs.length > 0 ? (
            <section>
              <h2>Excluded runs</h2>
              <p className="muted">
                Runs filtered out for non-determinism (mismatched plugin_ref or
                model_ref).
              </p>
              <ul>
                {data.excluded_runs.map((er) => (
                  <li key={`${er.side}-${er.run_id}`}>
                    <code>{er.run_id}</code> ({er.side}) — {er.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
  );
}

// ---- E01 — diagnostic analysis selection (C-ANALYSIS / C-JOBS) -----------
//
// Separate from the trace/score comparison above: it lists plugin-produced
// analysis artifacts, renders one with its evidence, and states the exact
// job request for the selected run, initiative or independent group.

type DiagnosticScope = "targets" | "independent";

/** Exact C-JOBS ids for a live target: run targets carry run ids; an
 * initiative target id is `initiative:<guild>:<initiative-id>`. */
function targetRequest(target: ProjectComparisonTarget): AnalysisJobRequestPreview {
  if (target.kind === "initiative") {
    const initiativeId = target.id.split(":").slice(2).join(":");
    return {
      source_guild: target.source_guild,
      operation: "analyze",
      target_kind: "initiative",
      ids: [initiativeId],
    };
  }
  return { source_guild: target.source_guild, operation: "analyze", target_kind: "run", ids: target.run_ids };
}

function compareRequest(
  baseline: ProjectComparisonTarget | undefined,
  candidate: ProjectComparisonTarget | undefined,
): { request: AnalysisJobRequestPreview | null; reason: string | null } {
  if (!baseline || !candidate) return { request: null, reason: "select a baseline and a candidate" };
  if (baseline.source_guild !== candidate.source_guild) {
    return { request: null, reason: "unsupported: baseline and candidate come from different sources" };
  }
  const ids = [...new Set([...baseline.run_ids, ...candidate.run_ids])].sort();
  if (ids.length < 2) return { request: null, reason: "a comparison needs at least 2 distinct runs" };
  return {
    request: { source_guild: baseline.source_guild, operation: "compare", target_kind: "runs", ids },
    reason: null,
  };
}

function artifactKey(a: Pick<AnalysisSummary, "kind" | "source_guild" | "id">) {
  return `${a.kind}|${a.source_guild}|${a.id}`;
}

function DiagnosticSection({
  baseline,
  candidate,
}: {
  baseline: ProjectComparisonTarget | undefined;
  candidate: ProjectComparisonTarget | undefined;
}) {
  const list = useAnalysisRead(analysisApi.list(), isAnalysisListResponse);
  const [scope, setScope] = useState<DiagnosticScope>("targets");
  const [groupId, setGroupId] = useState("");
  const [groupGuild, setGroupGuild] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  const artifacts = list.state === "ok" ? list.data.artifacts : [];
  const selected = artifacts.find((a) => artifactKey(a) === selectedKey);
  const detail = useAnalysisRead(
    selected ? analysisApi.detail(selected.kind, selected.id, selected.source_guild) : null,
    isAnalysisDetailResponse,
  );
  const guilds = [
    ...new Set(
      [baseline?.source_guild, candidate?.source_guild, ...artifacts.map((a) => a.source_guild)].filter(
        (g): g is string => !!g,
      ),
    ),
  ];
  const effectiveGroupGuild = groupGuild || guilds[0] || "";

  const actions =
    scope === "targets"
      ? (() => {
          const cmp = compareRequest(baseline, candidate);
          return [
            buildAnalysisAction(
              "analyze-baseline",
              "Analyze baseline",
              baseline ? targetRequest(baseline) : null,
              "select a baseline",
            ),
            buildAnalysisAction(
              "analyze-candidate",
              "Analyze candidate",
              candidate ? targetRequest(candidate) : null,
              "select a candidate",
            ),
            buildAnalysisAction("compare-runs", "Compare selected runs", cmp.request, cmp.reason ?? ""),
          ];
        })()
      : [
          buildAnalysisAction(
            "analyze-independent",
            "Analyze independent group",
            groupId
              ? { source_guild: effectiveGroupGuild, operation: "analyze", target_kind: "independent", ids: [groupId] }
              : null,
            "enter an independent group id",
          ),
        ];

  const runArtifacts = artifacts.filter((a) => a.kind === "run");
  const comparisonArtifacts = artifacts.filter((a) => a.kind === "comparison");

  return (
    <section data-testid="diagnostic-section" style={WRAP}>
      <h2>Diagnostic evidence</h2>
      <p className="muted">
        Analysis artifacts from the Guild producer. Evidence completeness counts which evidence exists; it is not a
        quality score and is not part of the trace comparison above.
      </p>

      <form className="compare-selection-grid" onSubmit={(e) => e.preventDefault()} aria-label="Diagnostic scope">
        <div className="field">
          <label htmlFor="diag-scope">Analysis scope</label>
          <select id="diag-scope" value={scope} onChange={(e) => setScope(e.target.value as DiagnosticScope)}>
            <option value="targets">Selected run or initiative</option>
            <option value="independent">Independent group</option>
          </select>
        </div>
        {scope === "independent" ? (
          <>
            <div className="field">
              <label htmlFor="diag-group">Independent group id</label>
              <input
                id="diag-group"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value.trim())}
                aria-invalid={groupId !== "" && !isSafeAnalysisId(groupId)}
              />
            </div>
            <div className="field">
              <label htmlFor="diag-group-guild">Group source</label>
              <select
                id="diag-group-guild"
                value={effectiveGroupGuild}
                onChange={(e) => setGroupGuild(e.target.value)}
                disabled={guilds.length === 0}
              >
                {guilds.length === 0 ? <option value="">No sources found</option> : null}
                {guilds.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
      </form>

      <h3>Analysis actions</h3>
      <AnalysisActionList actions={actions} blockedReason={analysisBlockedReason(list)} />

      <h3>Analysis artifacts</h3>
      {list.state !== "ok" ? (
        <AnalysisReadState read={list} emptyLabel="No analysis requested." />
      ) : artifacts.length === 0 ? (
        <div className="empty" data-testid="analysis-artifacts-empty">
          No analysis artifacts yet. Analyze a run, initiative or independent group first.
        </div>
      ) : (
        <div className="field">
          <label htmlFor="diag-artifact">Analysis artifact</label>
          <select id="diag-artifact" value={selectedKey} onChange={(e) => setSelectedKey(e.target.value)}>
            <option value="">Select an analysis artifact</option>
            {runArtifacts.length > 0 ? (
              <optgroup label="Run analyses">
                {runArtifacts.map((a) => (
                  <option key={artifactKey(a)} value={artifactKey(a)}>
                    {a.source_guild} · {a.id} ({a.validation})
                  </option>
                ))}
              </optgroup>
            ) : null}
            {comparisonArtifacts.length > 0 ? (
              <optgroup label="Comparison analyses">
                {comparisonArtifacts.map((a) => (
                  <option key={artifactKey(a)} value={artifactKey(a)}>
                    {a.source_guild} · {a.id} ({a.validation})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </div>
      )}

      {selected ? (
        detail.state === "ok" ? (
          <AnalysisDetailView detail={detail.data} />
        ) : (
          <AnalysisReadState read={detail} emptyLabel="Select an analysis artifact." />
        )
      ) : null}
    </section>
  );
}
