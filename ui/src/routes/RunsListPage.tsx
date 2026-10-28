import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type {
  ProjectOverviewResponse,
  ProjectRunListRow,
  ProjectRunsListResponse,
  RunsListResponse,
  RunsListRow,
} from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";
import { StatusPill } from "../components/StatusPill";

type DashboardRow = {
  run_id: string;
  source: "project" | "benchmark";
  source_guild?: string;
  case_slug?: string;
  plugin_ref?: string;
  status?: string;
  guild_score?: number;
  started_at?: string;
  command?: string;
  run_class?: string;
  benchmark_eligible?: boolean;
  has_trace?: boolean;
  auth_identity_hash?: string;
};

type SortKey = "started_at" | "guild_score" | "case_slug" | "status" | "run_id" | "plugin_ref";

interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

function sortRows(rows: DashboardRow[], sort: SortState): DashboardRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    const av = a[sort.key] ?? "";
    const bv = b[sort.key] ?? "";
    if (av === bv) return 0;
    const cmp = av > bv ? 1 : -1;
    return sort.dir === "asc" ? cmp : -cmp;
  });
  return out;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "run_id", label: "Run id" },
  { key: "status", label: "Status" },
  { key: "case_slug", label: "Case" },
  { key: "plugin_ref", label: "Plugin ref" },
  { key: "guild_score", label: "Score" },
  { key: "started_at", label: "Started" },
];

export default function RunsListPage() {
  const benchmark = useFetch<RunsListResponse>(api.runs());
  const projectRuns = useFetch<ProjectRunsListResponse>(api.projectRuns());
  const overview = useFetch<ProjectOverviewResponse>(api.projectOverview());
  const [sort, setSort] = useState<SortState>({ key: "started_at", dir: "desc" });
  const [searchParams] = useSearchParams();
  // F4 (v1.3): forensic-only display filter. URL-driven only — sourced from
  // the 7-char prefix badge on RunDetailPage. No <input> by design (the
  // forensic-only contract forbids arbitrary-text search over the field).
  const authPrefix = (searchParams.get("auth") ?? "").trim();

  const hasProjectRuns =
    projectRuns.status === "success" &&
    Boolean(projectRuns.data) &&
    Array.isArray(projectRuns.data?.sources);
  const activeRows: DashboardRow[] = hasProjectRuns
    ? (projectRuns.data?.runs ?? []).map(projectRowToDashboardRow)
    : (benchmark.data?.runs ?? []).map(benchmarkRowToDashboardRow);
  const activeStatus = hasProjectRuns ? projectRuns.status : benchmark.status;
  const activeError = hasProjectRuns ? projectRuns.error : benchmark.error;
  const activeTotal = hasProjectRuns ? projectRuns.data?.total ?? 0 : benchmark.data?.total ?? 0;
  const activeLabel = hasProjectRuns ? "workspace" : "benchmark";

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Guild control plane</p>
          <h1>Runs</h1>
          <p className="muted">
            {hasProjectRuns
              ? "Live project runs from the configured workspace root."
              : "Benchmark-local runs. Start the server with --project-root for live workspace runs."}
          </p>
        </div>
        <button
          onClick={() => {
            benchmark.refetch();
            projectRuns.refetch();
            overview.refetch();
          }}
          aria-label="Refresh runs"
        >
          Refresh
        </button>
      </header>

      {overview.status === "success" && overview.data?.totals ? (
        <div className="metric-grid" data-testid="project-overview">
          <div className="metric-card">
            <span className="metric-label">Mode</span>
            <strong>{overview.data.mode}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Runs</span>
            <strong>{overview.data.totals.runs}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Knowledge pages</span>
            <strong>{overview.data.totals.wiki_pages}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Graph nodes</span>
            <strong>{overview.data.totals.graph_nodes}</strong>
          </div>
        </div>
      ) : null}

      {activeStatus === "loading" ? <div className="loading">Loading runs...</div> : null}
      {activeStatus === "error" && !hasProjectRuns ? (
        <div className="error" role="alert">
          {activeError?.message ?? "failed to load runs"}
        </div>
      ) : null}
      {activeStatus === "success" || hasProjectRuns ? (
        activeRows.length === 0 ? (
          <div className="empty">
            No runs found. Score a run with{" "}
            <code>npm run benchmark -- score --run-id &lt;id&gt;</code>.
          </div>
        ) : (
          (() => {
            const filteredRows = authPrefix
              ? activeRows.filter((r) =>
                  (r.auth_identity_hash ?? "").startsWith(authPrefix),
                )
              : activeRows;
            const visibleRows = sortRows(filteredRows, sort);
            // Empty-state-with-filter: data has runs but none match the
            // active prefix. Distinct from the global "No runs found" state.
            if (authPrefix && filteredRows.length === 0) {
              return (
                <>
                  <p className="muted" data-testid="runs-filter-indicator">
                    Showing 0 of {activeTotal} run{activeTotal === 1 ? "" : "s"}{" "}
                    (filtered by auth=<code>{authPrefix}</code>) ·{" "}
                    <Link to="/runs">clear</Link>
                  </p>
                  <div className="empty">
                    No runs match auth=<code>{authPrefix}</code>.{" "}
                    <Link to="/runs">Clear filter</Link>.
                  </div>
                </>
              );
            }
            return (
              <>
                {authPrefix ? (
                  <p className="muted" data-testid="runs-filter-indicator">
                    Showing {filteredRows.length} of {activeTotal} run
                    {activeTotal === 1 ? "" : "s"} (filtered by auth=
                    <code>{authPrefix}</code>) · <Link to="/runs">clear</Link>
                  </p>
                ) : (
                  <p className="muted">
                    Showing {activeTotal} run{activeTotal === 1 ? "" : "s"}{" "}
                    ({activeLabel}; no status filter).
                  </p>
                )}
                <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {COLUMNS.map((col) => (
                        <th
                          key={col.key}
                          aria-sort={
                            sort.key === col.key
                              ? sort.dir === "asc"
                                ? "ascending"
                                : "descending"
                              : "none"
                          }
                        >
                          <button
                            style={{ background: "none", border: 0, padding: 0, fontWeight: 600 }}
                            onClick={() =>
                              setSort((s) =>
                                s.key === col.key
                                  ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
                                  : { key: col.key, dir: "desc" },
                              )
                            }
                          >
                            {col.label}
                            {sort.key === col.key
                              ? sort.dir === "asc"
                                ? " ▲"
                                : " ▼"
                              : ""}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr key={`${row.source}:${row.source_guild ?? "benchmark"}:${row.run_id}`}>
                        <td>
                          <Link
                            to={
                              row.source === "benchmark"
                                ? `/runs/${encodeURIComponent(row.run_id)}`
                                : `/project-runs/${encodeURIComponent(row.run_id)}${
                                    row.source_guild
                                      ? `?guild=${encodeURIComponent(row.source_guild)}`
                                      : ""
                                  }`
                            }
                          >
                            <code>{row.run_id}</code>
                          </Link>
                          {row.source_guild ? (
                            <span className="badge-source">{row.source_guild}</span>
                          ) : null}
                        </td>
                        <td>{renderStatus(row.status)}</td>
                        <td>{row.case_slug}</td>
                        <td>
                          {row.plugin_ref ? <code>{row.plugin_ref}</code> : row.command}
                        </td>
                        <td className="score-num">
                          {typeof row.guild_score === "number" ? (
                            <strong>{row.guild_score.toFixed(2)}</strong>
                          ) : row.benchmark_eligible ? (
                            <span className="badge-source badge-source-active">eligible</span>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td className="muted">{row.started_at}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </>
            );
          })()
        )
      ) : null}
    </section>
  );
}

function benchmarkRowToDashboardRow(row: RunsListRow): DashboardRow {
  return {
    run_id: row.run_id,
    source: "benchmark",
    case_slug: row.case_slug,
    plugin_ref: row.plugin_ref,
    status: row.status,
    guild_score: row.guild_score,
    started_at: row.started_at,
    auth_identity_hash: row.auth_identity_hash,
  };
}

function projectRowToDashboardRow(row: ProjectRunListRow): DashboardRow {
  return {
    run_id: row.run_id,
    source: "project",
    source_guild: row.source_guild,
    case_slug: row.run_class,
    plugin_ref: row.target_kind,
    status: row.status,
    started_at: row.started_at ?? row.closed_at,
    command: row.command,
    run_class: row.run_class,
    benchmark_eligible: row.benchmark_eligible,
    has_trace: row.has_trace,
  };
}

function renderStatus(status: string | undefined) {
  if (
    status === "pass" ||
    status === "fail" ||
    status === "timeout" ||
    status === "errored"
  ) {
    return <StatusPill status={status} />;
  }
  return <span className="badge-source">{status ?? "recorded"}</span>;
}
