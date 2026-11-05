import { useState } from "react";
import type {
  KnowledgeCandidatesView,
  KnowledgeChannelName,
  KnowledgeChannelState,
  KnowledgeEntityRef,
  KnowledgeGenerationSource,
  KnowledgeGenerationView,
  KnowledgeGenerationsResponse,
  KnowledgeLayerResponse,
} from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// Read-only view over GET /api/project/knowledge-generations
// (src/knowledge-generations.ts): C13 generations, per-channel freshness,
// decision propagation and pending candidates. Nothing here derives a value
// the reader did not return.

const STATE_LABEL: Record<KnowledgeChannelState, string> = {
  current_for_basis: "current for basis",
  pending: "pending",
  stale: "stale",
  unknown: "unknown",
};

// Reuses the vendored status tokens through the shared .pill styles.
const STATE_PILL: Record<KnowledgeChannelState, string> = {
  current_for_basis: "pass",
  pending: "timeout",
  stale: "fail",
  unknown: "errored",
};

const CANONICAL: readonly KnowledgeChannelName[] = ["wiki", "project_memory"];
const LAYER_CHANNELS: readonly KnowledgeChannelName[] = ["structural_graph", "semantic_graph", "recall"];

const short = (h: string | null) => (h ? h.replace(/^sha256:/, "").slice(0, 12) : "unknown");

function cause(state: KnowledgeChannelState, reason: string | null): string {
  if (reason) return reason;
  return state === "stale" || state === "unknown" || state === "pending" ? "cause not recorded" : "—";
}

function EntityList({ items, empty, testId }: { items: KnowledgeEntityRef[]; empty: string; testId: string }) {
  if (items.length === 0) return <p className="muted" data-testid={testId}>{empty}</p>;
  return (
    <ul data-testid={testId}>
      {items.map((e) => (
        <li key={`${e.source_id}:${e.id}:${e.revision}`}>
          <code>{e.id}</code> <span className="muted">({e.kind}, {e.source_id}, rev {short(e.revision)})</span>
        </li>
      ))}
    </ul>
  );
}

function Coexistence({ g }: { g: KnowledgeGenerationView }) {
  const canonical = g.channels.filter((c) => CANONICAL.includes(c.channel) && c.state === "current_for_basis").map((c) => c.channel);
  const derived = g.channels.filter((c) => !CANONICAL.includes(c.channel) && c.state === "pending").map((c) => c.channel);
  if (canonical.length === 0 || derived.length === 0) return null;
  return (
    <p data-testid="coexistence">
      Canonical current: {canonical.join(", ")}. Derived pending: {derived.join(", ")}.
    </p>
  );
}

function LayerDrilldown({ source, generation, channel }: { source: string; generation: string; channel: KnowledgeChannelName }) {
  const { data, error, status } = useFetch<KnowledgeLayerResponse>(api.projectKnowledgeLayer(source, generation, channel));
  return (
    <div className="card" data-testid="layer-drilldown" aria-live="polite">
      <h3>
        {channel} in generation <code>{short(generation)}</code>
      </h3>
      {status === "loading" ? <div className="loading">Loading layer...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          Could not load layer: {error?.message ?? "unknown error"}
        </div>
      ) : null}
      {status === "success" && data && data.status !== "verified" ? (
        <div className={data.status === "not_in_generation" ? "empty" : "error"} role={data.status === "not_in_generation" ? undefined : "alert"}>
          {data.reason ?? "no reason recorded"}
        </div>
      ) : null}
      {status === "success" && data && data.status === "verified" ? (
        <>
          <dl className="kv-grid">
            <dt>Artifact</dt>
            <dd>
              <code>{data.artifact}</code> ({data.bytes} bytes, <code>{short(data.sha256)}</code>)
            </dd>
            <dt>Layer / basis</dt>
            <dd>
              <code>{short(data.layer_hash)}</code> / <code>{short(data.basis_hash)}</code>
            </dd>
            {data.unknown_reason ? (
              <>
                <dt>Provenance</dt>
                <dd>unknown: {data.unknown_reason}</dd>
              </>
            ) : null}
          </dl>
          {data.top_level.length === 0 ? (
            <p className="muted">The artifact has no top-level keys.</p>
          ) : (
            <ul data-testid="layer-top-level">
              {data.top_level.map((k) => (
                <li key={k.key}>
                  <code>{k.key}</code> {k.kind}
                  {k.length !== null ? `, ${k.length} items` : ""}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}

function GenerationDetail({ g, source }: { g: KnowledgeGenerationView; source: string }) {
  const [drill, setDrill] = useState<KnowledgeChannelName | null>(null);
  if (g.status !== "verified") {
    return (
      <div className="error" role="alert">
        Generation {short(g.generation)} is {g.status}: {g.reason ?? "no reason recorded"}. Its channel state is not shown.
      </div>
    );
  }
  return (
    <>
      <dl className="kv-grid">
        <dt>Worktree</dt>
        <dd>
          <code>{g.source_worktree_id}</code>
        </dd>
        <dt>Owner / scope</dt>
        <dd>
          <code>{g.durable_owner_source_id}</code> / <code>{g.publication_scope_source_id}</code>
        </dd>
        <dt>Basis</dt>
        <dd>
          commit <code>{g.basis_commit ?? "unknown"}</code>, tree <code>{short(g.basis_tree)}</code>, hash <code>{short(g.source_basis_hash)}</code>
        </dd>
        <dt>Basis verified</dt>
        <dd data-testid="basis-verified-at">{g.basis_verified_at ?? "unknown"}</dd>
        <dt>Previous</dt>
        <dd>{g.previous_generation ? <code>{short(g.previous_generation)}</code> : "none (first generation)"}</dd>
      </dl>
      <Coexistence g={g} />
      <div className="table-scroll">
        <table aria-label="Channels">
          <thead>
            <tr>
              <th>Channel</th>
              <th>State</th>
              <th>Cause</th>
              <th>Observed</th>
              <th>Basis</th>
              <th>Layer</th>
              <th>Drilldown</th>
            </tr>
          </thead>
          <tbody>
            {g.channels.map((c) => (
              <tr key={c.channel}>
                <td>
                  <code>{c.channel}</code>
                  <div className="muted">{CANONICAL.includes(c.channel) ? "canonical" : "derived"}</div>
                </td>
                <td>
                  <span className="pill" data-status={STATE_PILL[c.state]} aria-label={`freshness: ${STATE_LABEL[c.state]}`}>
                    {STATE_LABEL[c.state]}
                  </span>
                </td>
                <td>{cause(c.state, c.reason)}</td>
                <td data-testid="observed-at">{c.observed_at ?? "unknown"}</td>
                <td>{c.basis_matches ? "matches generation" : <span>differs ({short(c.basis_hash)})</span>}</td>
                <td>
                  <code>{short(c.layer_hash)}</code>
                  {c.output_path ? <div className="muted"><code>{c.output_path}</code></div> : null}
                </td>
                <td>
                  {LAYER_CHANNELS.includes(c.channel) ? (
                    <button type="button" aria-pressed={drill === c.channel} onClick={() => setDrill(drill === c.channel ? null : c.channel)}>
                      Inspect {c.channel}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {drill ? <LayerDrilldown source={source} generation={g.generation} channel={drill} /> : null}
      {g.unpublished_channels.length > 0 ? (
        <p className="muted" data-testid="unpublished">
          Not published in this generation: {g.unpublished_channels.join(", ")}
        </p>
      ) : null}
      <h3>Decisions</h3>
      <EntityList items={g.decision_refs} empty="No decisions recorded." testId="decision-refs" />
      <h3>Dependent plans to replan</h3>
      <EntityList items={g.replan_required} empty="No replans recorded." testId="replan-required" />
    </>
  );
}

function Candidates({ c }: { c: KnowledgeCandidatesView | null }) {
  if (c === null) return <p className="muted">No candidate manifest.</p>;
  if (c.status !== "read") {
    return (
      <div className="error" role="alert">
        Candidate manifest unreadable: {c.reason ?? "no reason recorded"}
      </div>
    );
  }
  return (
    <>
      <p className="muted">
        Owner <code>{c.owner_source_id ?? "unknown"}</code>, autopromote {c.autopromote === null ? "unknown" : String(c.autopromote)}, generated{" "}
        <span data-testid="candidates-generated-at">{c.generated_at ?? "unknown"}</span>
      </p>
      {c.entries.length === 0 ? (
        <p className="muted">No candidates in the manifest.</p>
      ) : (
        <div className="table-scroll">
          <table aria-label="Candidates">
            <thead>
              <tr>
                <th>Path</th>
                <th>Revision</th>
                <th>State</th>
                <th>Decision</th>
                <th>Conflicts</th>
              </tr>
            </thead>
            <tbody>
              {c.entries.map((e) => (
                <tr key={`${e.path}:${e.candidate_revision}`}>
                  <td>
                    <code>{e.path}</code>
                  </td>
                  <td>
                    <code>{short(e.candidate_revision)}</code>
                  </td>
                  <td>{e.state}</td>
                  <td>{e.decision_id ?? "—"}</td>
                  <td>{e.conflict_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SourceCard({ s, index }: { s: KnowledgeGenerationSource; index: number }) {
  const [selected, setSelected] = useState<string | null>(s.tip);
  const g = s.generations.find((x) => x.generation === selected) ?? s.generations[0];
  const selectId = `generation-${index}`;
  return (
    <section className="card">
      <h2>{s.source_guild}</h2>
      {s.status === "none" ? <div className="empty">{s.reason ?? "No knowledge publication."}</div> : null}
      {s.status === "unreadable" ? (
        <div className="error" role="alert">
          Publication unreadable: {s.reason ?? "no reason recorded"}
        </div>
      ) : null}
      {g ? (
        <>
          <div className="field field-compact">
            <label htmlFor={selectId}>Generation</label>
            <select id={selectId} value={g.generation} onChange={(e) => setSelected(e.target.value)}>
              {s.generations.map((x) => (
                <option key={x.generation} value={x.generation}>
                  {short(x.generation)}
                  {x.generation === s.tip ? " (tip)" : ""}
                  {x.status !== "verified" ? ` [${x.status}]` : ""}
                </option>
              ))}
            </select>
          </div>
          {s.history_truncated ? <p className="muted">Older generations exist beyond the listed history.</p> : null}
          <GenerationDetail key={g.generation} g={g} source={s.source_guild} />
        </>
      ) : null}
      <h3>Candidates</h3>
      <Candidates c={s.candidates} />
    </section>
  );
}

export default function FreshnessPage() {
  const { data, error, status } = useFetch<KnowledgeGenerationsResponse>(api.projectKnowledgeGenerations());
  return (
    <section>
      <h1>Knowledge freshness</h1>
      <p className="muted">
        Published knowledge generations per source, each channel's freshness against its source basis, and decision propagation. Read-only.
      </p>
      {status === "loading" ? <div className="loading">Loading generations...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {/no project root configured|404/i.test(error?.message ?? "")
            ? "Start the server with --project-root to read knowledge generations."
            : `Could not load knowledge generations: ${error?.message ?? "unknown error"}`}
        </div>
      ) : null}
      {status === "success" && data && data.sources.length === 0 ? <div className="empty">No sources found under the project root.</div> : null}
      {status === "success" && data ? data.sources.map((s, i) => <SourceCard key={`${i}:${s.source_guild}`} s={s} index={i} />) : null}
    </section>
  );
}
