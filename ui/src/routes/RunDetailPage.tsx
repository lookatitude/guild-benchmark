import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRunStatus } from "../hooks/useRunStatus";
import { useFetch } from "../hooks/useFetch";
import { StageGraph } from "../components/StageGraph";
import { ArtifactList } from "../components/ArtifactList";
import { MetricBreakdown } from "../components/MetricBreakdown";
import { ScoreCard } from "../components/ScoreCard";
import { LifecycleTimeline } from "../components/LifecycleTimeline";
import { api } from "../lib/api";
import type { LifecycleRunRecord, MetricsJson } from "../../../src/types";

export default function RunDetailPage() {
  const params = useParams<{ run_id: string }>();
  const runId = params.run_id;
  const { data, error, status, isPolling } = useRunStatus(runId);
  const [selectedStage, setSelectedStage] = useState<string | undefined>(undefined);

  // SC-9: fetch the lifecycle record once the run is terminal (not polling).
  // 404 is expected for standard benchmark runs — the component hides the
  // section in that case. Deferring until terminal keeps polling-contract
  // tests predictable (no extra fetch during the non-terminal phase).
  const lifecycleUrl =
    runId && !isPolling && status === "success" ? api.lifecycleRecord(runId) : null;
  const { data: lifecycleRecord } = useFetch<LifecycleRunRecord>(lifecycleUrl);

  return (
    <section>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <h1>
          Run <code>{runId}</code>
        </h1>
        <Link to="/">← all runs</Link>
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
