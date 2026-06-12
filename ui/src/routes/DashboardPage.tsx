import { Link } from "react-router-dom";
import type {
  ProjectComparisonTargetsResponse,
  ProjectOverviewResponse,
  ProjectRunsListResponse,
} from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

export default function DashboardPage() {
  const overview = useFetch<ProjectOverviewResponse>(api.projectOverview());
  const projectRuns = useFetch<ProjectRunsListResponse>(api.projectRuns());
  const targets = useFetch<ProjectComparisonTargetsResponse>(api.projectComparisonTargets());

  const projectRunCount =
    projectRuns.status === "success" ? projectRuns.data?.total ?? 0 : undefined;
  const eligibleTargetCount =
    targets.status === "success"
      ? targets.data?.targets.filter((target) => target.comparison_eligible).length ?? 0
      : undefined;
  const workspaceSources =
    overview.status === "success" && overview.data ? overview.data.sources : [];

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Guild control plane</p>
          <h1>Dashboard</h1>
          <p className="muted">
            Workspace summary for runs, initiatives, knowledge, and comparison readiness.
          </p>
        </div>
        <Link className="button-secondary" to="/runs">
          Manage runs
        </Link>
      </header>

      {overview.status === "loading" ? (
        <div className="loading">Loading workspace overview...</div>
      ) : null}

      {overview.status === "error" ? (
        <div className="error" role="alert">
          Start the server with <code>--project-root</code> to load live workspace data.
        </div>
      ) : null}

      <div className="metric-grid">
        <div className="metric-card">
          <span className="metric-label">Mode</span>
          <strong>{overview.data?.mode ?? "benchmark"}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Runs</span>
          <strong>{projectRunCount ?? overview.data?.totals.runs ?? "..."}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Initiatives</span>
          <strong>{overview.data?.totals.initiatives ?? "..."}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Eligible comparisons</span>
          <strong>{eligibleTargetCount ?? "..."}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Wiki pages</span>
          <strong>{overview.data?.totals.wiki_pages ?? "..."}</strong>
        </div>
        <div className="metric-card">
          <span className="metric-label">Graph nodes</span>
          <strong>{overview.data?.totals.graph_nodes ?? "..."}</strong>
        </div>
      </div>

      <section className="dashboard-grid">
        <div className="card">
          <h2>Run Operations</h2>
          <p className="muted">
            Inspect live workspace runs, open traces, sort by status, and jump into run
            detail pages.
          </p>
          <Link to="/runs">Open runs</Link>
        </div>
        <div className="card">
          <h2>Compare</h2>
          <p className="muted">
            Compare only eligible runs or full initiatives, then generate analysis handoffs.
          </p>
          <Link to="/compare">Open compare</Link>
        </div>
        <div className="card">
          <h2>Knowledge</h2>
          <p className="muted">
            Review workspace and project knowledge graphs before turning run findings into
            learning.
          </p>
          <Link to="/knowledge">Open graph</Link>
        </div>
        <div className="card">
          <h2>Wiki</h2>
          <p className="muted">
            Browse the workspace wiki first, then switch into project-local documentation.
          </p>
          <Link to="/wiki">Open wiki</Link>
        </div>
      </section>

      {workspaceSources.length > 0 ? (
        <section>
          <h2>Workspace Sources</h2>
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Runs</th>
                <th>Initiatives</th>
                <th>Wiki</th>
                <th>Graph</th>
              </tr>
            </thead>
            <tbody>
              {workspaceSources.map((source) => (
                <tr key={source.guild}>
                  <td>
                    <strong>{source.guild}</strong>
                    <div className="muted">{source.root}</div>
                  </td>
                  <td>{source.run_count}</td>
                  <td>{source.initiative_count ?? 0}</td>
                  <td>{source.wiki_count}</td>
                  <td>{source.has_graph ? source.graph_kind ?? "available" : "missing"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </section>
  );
}
