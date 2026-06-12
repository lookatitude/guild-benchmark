import { Link, useParams, useSearchParams } from "react-router-dom";
import type { ProjectRunDetailResponse } from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

export default function ProjectRunDetailPage() {
  const params = useParams<{ run_id: string }>();
  const [searchParams] = useSearchParams();
  const runId = params.run_id;
  const guild = searchParams.get("guild") ?? undefined;
  const { data, error, status } = useFetch<ProjectRunDetailResponse>(
    runId ? api.projectRunDetail(runId, guild) : null,
  );

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Live workspace run</p>
          <h1>
            Run <code>{runId}</code>
          </h1>
        </div>
        <Link to="/runs">All runs</Link>
      </header>

      {status === "loading" ? <div className="loading">Loading run...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {error?.message ?? "failed to load run"}
        </div>
      ) : null}
      {status === "success" && data ? (
        <>
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Source</span>
              <strong>{data.run.source_guild}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Trace events</span>
              <strong>{data.event_count}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Benchmark</span>
              <strong>{data.run.benchmark_eligible ? "eligible" : "not set"}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Artifacts</span>
              <strong>
                {[data.run.has_run_yaml ? "run.yaml" : "", data.run.has_provenance ? "provenance" : ""]
                  .filter(Boolean)
                  .join(", ") || "trace only"}
              </strong>
            </div>
          </div>

          <div className="card">
            <h2>Metadata</h2>
            <dl className="kv-grid">
              <dt>Command</dt>
              <dd>{data.run.command ?? <span className="muted">unknown</span>}</dd>
              <dt>Run class</dt>
              <dd>{data.run.run_class ?? <span className="muted">unknown</span>}</dd>
              <dt>Target</dt>
              <dd>{data.run.target_kind ?? <span className="muted">unknown</span>}</dd>
              <dt>Started</dt>
              <dd>{data.run.started_at ?? <span className="muted">unknown</span>}</dd>
              <dt>Closed</dt>
              <dd>{data.run.closed_at ?? <span className="muted">unknown</span>}</dd>
              <dt>Path</dt>
              <dd>
                <code>{data.run.path}</code>
              </dd>
            </dl>
          </div>

          <div className="card">
            <h2>Trace Preview</h2>
            {data.trace_preview.length === 0 ? (
              <p className="muted">No trace preview is available for this run.</p>
            ) : (
              <pre className="wiki-content">
                {JSON.stringify(data.trace_preview.slice(0, 20), null, 2)}
              </pre>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
