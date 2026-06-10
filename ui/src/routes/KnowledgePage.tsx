import { useMemo, useState } from "react";
import type { ProjectKnowledgeGraphResponse } from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// SC-12 / G-18 — Knowledge view: type-grouped node/edge explorer over
// GET /api/project/knowledge-graph. List-based rendering on purpose — no
// graph library (repo posture: no new runtime deps for this view).
//
// The KG shape is lenient pass-through (nodes/edges keep unknown fields), so
// every field read goes through a defensive string accessor.

type KgRecord = Record<string, unknown>;

function str(rec: KgRecord, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : "";
}

function nodeId(n: KgRecord): string {
  return str(n, "id") || str(n, "name");
}

function nodeLabel(n: KgRecord): string {
  return str(n, "name") || str(n, "id") || "(unnamed)";
}

function nodeType(n: KgRecord): string {
  return str(n, "type") || "(untyped)";
}

function edgeType(e: KgRecord): string {
  return str(e, "type") || "(untyped)";
}

export default function KnowledgePage() {
  const { data, error, status } = useFetch<ProjectKnowledgeGraphResponse>(
    api.projectKnowledgeGraph(),
  );
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");

  const nodesById = useMemo(() => {
    const map = new Map<string, KgRecord>();
    for (const n of data?.nodes ?? []) {
      const id = nodeId(n);
      if (id) map.set(id, n);
    }
    return map;
  }, [data]);

  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of data?.nodes ?? []) {
      const t = nodeType(n);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  }, [data]);

  const workspaceMode = (data?.sources.length ?? 0) > 1;

  const visibleNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = (data?.nodes ?? []).filter((n) => {
      if (typeFilter && nodeType(n) !== typeFilter) return false;
      if (!q) return true;
      const hay = `${nodeId(n)} ${nodeLabel(n)} ${str(n, "source_guild")}`.toLowerCase();
      return hay.includes(q);
    });
    return out.slice(0, 200);
  }, [data, search, typeFilter]);

  const selected = selectedId ? nodesById.get(selectedId) : undefined;

  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return (data?.edges ?? []).filter(
      (e) => str(e, "source") === selectedId || str(e, "target") === selectedId,
    );
  }, [data, selectedId]);

  const edgesByType = useMemo(() => {
    const groups = new Map<string, KgRecord[]>();
    for (const e of selectedEdges) {
      const t = edgeType(e);
      const list = groups.get(t) ?? [];
      list.push(e);
      groups.set(t, list);
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [selectedEdges]);

  const isNoProjectRoot =
    status === "error" && /no project root configured/i.test(error?.message ?? "");

  return (
    <section>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <h1>Knowledge</h1>
      </header>
      {status === "loading" ? (
        <div className="loading">Loading knowledge graph…</div>
      ) : null}
      {isNoProjectRoot ? (
        <div className="empty" data-testid="knowledge-no-project-root">
          Live-project mode is off. Restart the server with{" "}
          <code>npm run benchmark -- serve --project-root &lt;abs-path&gt;</code> to
          browse the project&apos;s knowledge graph.
        </div>
      ) : status === "error" ? (
        <div className="error" role="alert">
          {error?.message ?? "failed to load knowledge graph"}
        </div>
      ) : null}
      {status === "success" && data ? (
        <>
          <p className="muted">
            {data.nodes.length} node{data.nodes.length === 1 ? "" : "s"} ·{" "}
            {data.edges.length} edge{data.edges.length === 1 ? "" : "s"} ·{" "}
            {data.sources.length} source{data.sources.length === 1 ? "" : "s"}
            {workspaceMode
              ? ` (workspace: ${data.sources.map((s) => s.guild).join(", ")})`
              : ""}
          </p>

          <div className="card">
            <h3>Nodes by type</h3>
            <div className="row" data-testid="knowledge-type-counts">
              <button
                className={typeFilter === "" ? "badge-source badge-source-active" : "badge-source"}
                onClick={() => setTypeFilter("")}
              >
                all ({data.nodes.length})
              </button>
              {typeCounts.map(([type, count]) => (
                <button
                  key={type}
                  className={
                    typeFilter === type
                      ? "badge-source badge-source-active"
                      : "badge-source"
                  }
                  onClick={() => setTypeFilter(typeFilter === type ? "" : type)}
                  aria-pressed={typeFilter === type}
                >
                  {type} ({count})
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>Node explorer</h3>
            <input
              type="search"
              placeholder="Search nodes by id / name…"
              aria-label="Search nodes"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ width: "100%", marginBottom: "var(--space-3)" }}
            />
            {visibleNodes.length === 0 ? (
              <div className="empty">No nodes match the current filter.</div>
            ) : (
              <ul className="knowledge-node-list" data-testid="knowledge-node-list">
                {visibleNodes.map((n, i) => {
                  const id = nodeId(n) || `#${i}`;
                  return (
                    <li key={`${id}-${i}`}>
                      <button
                        onClick={() => setSelectedId(nodeId(n))}
                        aria-pressed={selectedId === nodeId(n)}
                        style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                      >
                        <code>{nodeLabel(n)}</code>
                      </button>{" "}
                      <span className="muted">{nodeType(n)}</span>{" "}
                      {workspaceMode ? (
                        <span className="badge-source">{str(n, "source_guild")}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {selected ? (
            <div className="card" data-testid="knowledge-selected-node">
              <h3>
                <code>{nodeLabel(selected)}</code>{" "}
                <span className="muted">{nodeType(selected)}</span>{" "}
                {workspaceMode ? (
                  <span className="badge-source">{str(selected, "source_guild")}</span>
                ) : null}
              </h3>
              {selectedEdges.length === 0 ? (
                <p className="muted">No edges touch this node.</p>
              ) : (
                edgesByType.map(([type, edges]) => (
                  <div key={type}>
                    <h4>
                      {type} <span className="muted">({edges.length})</span>
                    </h4>
                    <ul>
                      {edges.map((e, i) => {
                        const src = str(e, "source");
                        const tgt = str(e, "target");
                        const neighborId = src === selectedId ? tgt : src;
                        const neighbor = nodesById.get(neighborId);
                        const arrow = src === selectedId ? "→" : "←";
                        return (
                          <li key={`${neighborId}-${i}`}>
                            <span className="muted">{arrow}</span>{" "}
                            <button
                              onClick={() => setSelectedId(neighborId)}
                              style={{
                                background: "none",
                                border: 0,
                                padding: 0,
                                cursor: "pointer",
                              }}
                            >
                              <code>
                                {neighbor ? nodeLabel(neighbor) : neighborId || "(unknown)"}
                              </code>
                            </button>{" "}
                            {neighbor ? (
                              <span className="muted">{nodeType(neighbor)}</span>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
