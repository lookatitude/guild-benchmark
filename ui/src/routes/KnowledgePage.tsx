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
type GraphMode = "overview" | "neighborhood";

interface PositionedNode {
  id: string;
  label: string;
  type: string;
  sourceGuild: string;
  x: number;
  y: number;
  degree: number;
  raw: KgRecord;
}

interface PositionedEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}

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

// v2 knowledge tier — SC-10 node-type sets used by cross-modal edge detection.
const DOC_NODE_TYPES = new Set(["wiki_page", "claim", "diagram", "concept"]);
const CODE_NODE_TYPES = new Set(["function", "file", "class", "method"]);

// ---- Subtopic tree helpers ------------------------------------------------

interface SubtopicTreeNode {
  id: string;
  label: string;
  depth: number;
  children: SubtopicTreeNode[];
}

/** Build a forest from `subtopic_of` edges (child → parent). */
function buildSubtopicTree(nodes: KgRecord[], edges: KgRecord[]): SubtopicTreeNode[] {
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of edges) {
    if (str(e, "type") !== "subtopic_of") continue;
    const child = str(e, "source");
    const parent = str(e, "target");
    if (!child || !parent) continue;
    hasParent.add(child);
    const list = childrenOf.get(parent) ?? [];
    list.push(child);
    childrenOf.set(parent, list);
  }
  const nodesById = new Map<string, KgRecord>();
  for (const n of nodes) {
    const id = nodeId(n);
    if (id) nodesById.set(id, n);
  }
  const roots = [...childrenOf.keys()].filter((id) => !hasParent.has(id));
  function buildNode(id: string, depth: number): SubtopicTreeNode {
    const n = nodesById.get(id);
    return {
      id,
      label: n ? nodeLabel(n) : id,
      depth,
      children: (childrenOf.get(id) ?? []).map((childId) => buildNode(childId, depth + 1)),
    };
  }
  return roots.map((id) => buildNode(id, 0));
}

/** Max depth across all nodes in the forest (0 = single root, no children). */
function subtopicMaxDepth(nodes: SubtopicTreeNode[]): number {
  let max = 0;
  for (const n of nodes) {
    max = Math.max(max, n.depth, subtopicMaxDepth(n.children));
  }
  return max;
}

// ---- Domain / business-flow helpers ---------------------------------------

interface DomainFlowStep {
  id: string;
  label: string;
  /** From the `flow_step` edge `weight` — monotonically encodes step order. */
  weight: number;
}

interface DomainFlowGroup {
  id: string;
  label: string;
  steps: DomainFlowStep[];
}

interface DomainGroup {
  id: string;
  label: string;
  flows: DomainFlowGroup[];
}

/** Lenient numeric accessor: number, numeric string, or 0. */
function num(rec: KgRecord, key: string): number {
  const v = rec[key];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const p = parseFloat(v);
    return Number.isNaN(p) ? 0 : p;
  }
  return 0;
}

/**
 * Group `domain` nodes → their business `flow` nodes (via `contains_flow`
 * edges, domain→flow) → ordered `step` nodes (via `flow_step` edges, flow→step).
 *
 * Step order comes from the `flow_step` edge `weight`, which monotonically
 * encodes step order (0.1 → 1.0) — NOT from input edge order. Pure + lenient:
 * any node/edge field may be absent; returns `[]` when there are no domains.
 */
function buildDomainFlows(nodes: KgRecord[], edges: KgRecord[]): DomainGroup[] {
  const nodesById = new Map<string, KgRecord>();
  for (const n of nodes) {
    const id = nodeId(n);
    if (id) nodesById.set(id, n);
  }
  const domainIds = nodes
    .filter((n) => nodeType(n) === "domain")
    .map(nodeId)
    .filter(Boolean);
  if (domainIds.length === 0) return [];

  // domain id → flow ids (contains_flow: source = domain, target = flow)
  const flowsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (str(e, "type") !== "contains_flow") continue;
    const domain = str(e, "source");
    const flow = str(e, "target");
    if (!domain || !flow) continue;
    const list = flowsOf.get(domain) ?? [];
    list.push(flow);
    flowsOf.set(domain, list);
  }

  // flow id → steps (flow_step: source = flow, target = step), ordered by weight
  const stepsOf = new Map<string, DomainFlowStep[]>();
  for (const e of edges) {
    if (str(e, "type") !== "flow_step") continue;
    const flow = str(e, "source");
    const step = str(e, "target");
    if (!flow || !step) continue;
    const list = stepsOf.get(flow) ?? [];
    const n = nodesById.get(step);
    list.push({ id: step, label: n ? nodeLabel(n) : step, weight: num(e, "weight") });
    stepsOf.set(flow, list);
  }
  // Sort each flow's steps by edge weight — this is what makes ordering
  // independent of the input edge order (anti-vacuity).
  for (const list of stepsOf.values()) {
    list.sort((a, b) => a.weight - b.weight);
  }

  return domainIds.map((domainId) => {
    const dn = nodesById.get(domainId);
    const flowIds = flowsOf.get(domainId) ?? [];
    return {
      id: domainId,
      label: dn ? nodeLabel(dn) : domainId,
      flows: flowIds.map((flowId) => {
        const fn = nodesById.get(flowId);
        return {
          id: flowId,
          label: fn ? nodeLabel(fn) : flowId,
          steps: stepsOf.get(flowId) ?? [],
        };
      }),
    };
  });
}

function DomainFlowsView({
  domains,
  selectedId,
  onSelect,
}: {
  domains: DomainGroup[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="domain-flows" data-testid="knowledge-domain-flows-list">
      {domains.map((domain) => (
        <div key={domain.id} className="domain-group" data-domain-id={domain.id}>
          <h4>
            {domain.label} <span className="muted">domain</span>
          </h4>
          {domain.flows.length === 0 ? (
            <p className="muted">No business flows in this domain.</p>
          ) : (
            domain.flows.map((flow) => (
              <div key={flow.id} className="domain-flow" data-flow-id={flow.id}>
                <h5>
                  {flow.label} <span className="muted">flow</span>
                </h5>
                {flow.steps.length === 0 ? (
                  <p className="muted">No steps recorded for this flow.</p>
                ) : (
                  <ol className="domain-flow-steps">
                    {flow.steps.map((step) => (
                      <li key={step.id} data-step-id={step.id}>
                        <button
                          onClick={() => onSelect(step.id)}
                          aria-pressed={selectedId === step.id}
                          style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                        >
                          <code>{step.label}</code>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

export { buildDomainFlows };
export type { DomainGroup, DomainFlowGroup, DomainFlowStep };

function SubtopicTreeView({ tree }: { tree: SubtopicTreeNode[] }) {
  if (tree.length === 0) return null;

  function renderNode(node: SubtopicTreeNode) {
    return (
      <li key={node.id} data-depth={node.depth}>
        <span className="muted" style={{ marginLeft: node.depth * 16 }}>
          {node.label}
        </span>
        {node.children.length > 0 && <ul>{node.children.map(renderNode)}</ul>}
      </li>
    );
  }

  return (
    <ul className="knowledge-subtopic-tree" data-testid="knowledge-subtopic-tree-list">
      {tree.map(renderNode)}
    </ul>
  );
}

export default function KnowledgePage() {
  const { data, error, status } = useFetch<ProjectKnowledgeGraphResponse>(
    api.projectKnowledgeGraph(),
  );
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [graphMode, setGraphMode] = useState<GraphMode>("overview");
  const [graphLimit, setGraphLimit] = useState(160);
  const [graphDepth, setGraphDepth] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [showLabels, setShowLabels] = useState(true);

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

  const workspaceMode = (data?.sources ?? []).some((source) => source.guild !== "project");

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

  const graph = useMemo(
    () =>
      buildGraphLayout({
        nodes: data?.nodes ?? [],
        edges: data?.edges ?? [],
        selectedId,
        graphMode,
        graphDepth,
        graphLimit,
        search,
        typeFilter,
      }),
    [data, graphDepth, graphLimit, graphMode, search, selectedId, typeFilter],
  );

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

  // v2 knowledge tier — SC-10 computed views
  const subtopicTree = useMemo(
    () => (data ? buildSubtopicTree(data.nodes, data.edges) : []),
    [data],
  );

  const subtopicDepth = useMemo(() => subtopicMaxDepth(subtopicTree), [subtopicTree]);

  // G11 — domains & business-flows view (consumes domain/flow/step nodes +
  // contains_flow/flow_step edges; independent of the v2 knowledge tier).
  const domainFlows = useMemo(
    () => (data ? buildDomainFlows(data.nodes, data.edges) : []),
    [data],
  );

  const wikiPageNodes = useMemo(
    () => (data?.nodes ?? []).filter((n) => nodeType(n) === "wiki_page"),
    [data],
  );

  const crossModalEdges = useMemo(() => {
    const docIds = new Set(
      (data?.nodes ?? [])
        .filter((n) => DOC_NODE_TYPES.has(nodeType(n)))
        .map(nodeId)
        .filter(Boolean),
    );
    const codeIds = new Set(
      (data?.nodes ?? [])
        .filter((n) => CODE_NODE_TYPES.has(nodeType(n)))
        .map(nodeId)
        .filter(Boolean),
    );
    return (data?.edges ?? []).filter((e) => {
      if (str(e, "type") !== "evidenced_by") return false;
      const src = str(e, "source");
      const tgt = str(e, "target");
      return docIds.has(src) && codeIds.has(tgt);
    });
  }, [data]);

  const isNoProjectRoot =
    status === "error" && /no project root configured/i.test(error?.message ?? "");

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Workspace intelligence</p>
          <h1>Knowledge</h1>
          <p className="muted">Graph and codebase-map data from the configured project root.</p>
        </div>
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
          <div className="metric-grid">
            <div className="metric-card">
              <span className="metric-label">Nodes</span>
              <strong>{data.nodes.length}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Edges</span>
              <strong>{data.edges.length}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Sources</span>
              <strong>{data.sources.length}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Mode</span>
              <strong>{workspaceMode ? "workspace" : "project"}</strong>
            </div>
          </div>
          <p className="muted">
            {data.nodes.length} node{data.nodes.length === 1 ? "" : "s"} ·{" "}
            {data.edges.length} edge{data.edges.length === 1 ? "" : "s"} ·{" "}
            {data.sources.length} source{data.sources.length === 1 ? "" : "s"}
            {workspaceMode
              ? ` (workspace: ${data.sources.map((s) => s.guild).join(", ")})`
              : ""}
          </p>

          {data.empty_reason ? (
            <div className="empty" data-testid="knowledge-empty-graph">
              {data.empty_reason}
            </div>
          ) : null}

          {data.nodes.length > 0 ? (
            <div className="knowledge-workbench">
              <div className="knowledge-graph-panel">
                <div className="graph-toolbar">
                  <div className="field field-search">
                    <label htmlFor="knowledge-search">Search</label>
                    <input
                      id="knowledge-search"
                      name="knowledge-search"
                      type="search"
                      placeholder="Find nodes by id, name, source..."
                      aria-label="Search nodes"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="field field-compact">
                    <label htmlFor="knowledge-limit">Nodes</label>
                    <select
                      id="knowledge-limit"
                      name="knowledge-limit"
                      value={graphLimit}
                      onChange={(e) => setGraphLimit(Number(e.target.value))}
                    >
                      <option value={80}>80</option>
                      <option value={160}>160</option>
                      <option value={320}>320</option>
                      <option value={800}>All</option>
                    </select>
                  </div>
                  <div className="field field-compact">
                    <label htmlFor="knowledge-depth">Depth</label>
                    <select
                      id="knowledge-depth"
                      name="knowledge-depth"
                      value={graphDepth}
                      onChange={(e) => setGraphDepth(Number(e.target.value))}
                    >
                      <option value={1}>1 hop</option>
                      <option value={2}>2 hops</option>
                    </select>
                  </div>
                  <div className="segmented" aria-label="Graph mode">
                    <button
                      className={graphMode === "overview" ? "active" : ""}
                      onClick={() => setGraphMode("overview")}
                    >
                      Overview
                    </button>
                    <button
                      className={graphMode === "neighborhood" ? "active" : ""}
                      onClick={() => setGraphMode("neighborhood")}
                      disabled={!selectedId}
                    >
                      Neighborhood
                    </button>
                  </div>
                </div>

                <GraphCanvas
                  nodes={graph.nodes}
                  edges={graph.edges}
                  selectedId={selectedId}
                  zoom={zoom}
                  showLabels={showLabels}
                  onSelect={(id) => {
                    setSelectedId(id);
                    if (graphMode === "overview") setGraphMode("neighborhood");
                  }}
                />

                <div className="graph-footer">
                  <span className="muted">
                    Showing {graph.nodes.length} of {data.nodes.length} nodes, {graph.edges.length} edges.
                  </span>
                  <label className="toggle-control">
                    <input
                      id="knowledge-show-labels"
                      name="knowledge-show-labels"
                      type="checkbox"
                      checked={showLabels}
                      onChange={(e) => setShowLabels(e.target.checked)}
                    />
                    Labels
                  </label>
                  <label className="range-control" htmlFor="knowledge-zoom">
                    <span>Zoom</span>
                    <input
                      id="knowledge-zoom"
                      name="knowledge-zoom"
                      type="range"
                      min={70}
                      max={180}
                      value={zoom}
                      onChange={(e) => setZoom(Number(e.target.value))}
                    />
                  </label>
                </div>
              </div>

              <aside className="knowledge-side-panel">
                <h3>Selection</h3>
                {selected ? (
                  <>
                    <p>
                      <code>{nodeLabel(selected)}</code>
                    </p>
                    <dl className="kv-grid">
                      <dt>Type</dt>
                      <dd>{nodeType(selected)}</dd>
                      <dt>Source</dt>
                      <dd>{str(selected, "source_guild") || "project"}</dd>
                      <dt>Edges</dt>
                      <dd>{selectedEdges.length}</dd>
                      {str(selected, "path") ? (
                        <>
                          <dt>Path</dt>
                          <dd>
                            <code>{str(selected, "path")}</code>
                          </dd>
                        </>
                      ) : null}
                    </dl>
                    <button className="button-secondary" onClick={() => setGraphMode("neighborhood")}>
                      Focus neighborhood
                    </button>
                  </>
                ) : (
                  <p className="muted">Select a node in the graph or list to inspect its links.</p>
                )}
              </aside>
            </div>
          ) : null}

          {data.nodes.length > 0 ? (
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
          ) : null}

          {data.nodes.length > 0 ? (
          <div className="card">
            <h3>Node explorer</h3>
            <input
              id="knowledge-node-list-search"
              name="knowledge-node-list-search"
              type="search"
              placeholder="Search nodes by id / name…"
              aria-label="Search nodes list"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
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
          ) : null}

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

          {/* G11 — Domains & business flows. Always rendered when the graph
              has nodes; shows an empty-state when no domain nodes exist. */}
          {data.nodes.length > 0 && (
            <div className="card" data-testid="knowledge-domains-flows">
              <h3>
                Domains &amp; flows{" "}
                <span className="muted">(contains_flow · flow_step)</span>
              </h3>
              {domainFlows.length === 0 ? (
                <div className="empty" data-testid="knowledge-domains-empty">
                  No business domains in this graph.
                </div>
              ) : (
                <DomainFlowsView
                  domains={domainFlows}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                />
              )}
            </div>
          )}

          {/* v2 knowledge tier — SC-10 panels (conditional on v2 data presence) */}

          {subtopicTree.length > 0 && (
            <div className="card" data-testid="knowledge-v2-subtopic-tree">
              <h3>
                Topic tree <span className="muted">(subtopic_of)</span>
                {subtopicDepth >= 3 && (
                  <span className="badge-source" style={{ marginLeft: 8 }}>
                    depth {subtopicDepth + 1}
                  </span>
                )}
              </h3>
              <SubtopicTreeView tree={subtopicTree} />
            </div>
          )}

          {wikiPageNodes.length > 0 && (
            <div className="card" data-testid="knowledge-v2-wiki-clusters">
              <h3>Wiki pages</h3>
              <ul className="knowledge-node-list">
                {wikiPageNodes.map((n, i) => {
                  const id = nodeId(n) || `#${i}`;
                  const cat = str(n, "category");
                  const imp = str(n, "importance");
                  const rawLabels = n["labels"];
                  const labels = Array.isArray(rawLabels)
                    ? rawLabels.filter((l): l is string => typeof l === "string")
                    : [];
                  return (
                    <li key={`wp-${id}`} data-wiki-page-id={id}>
                      <button
                        onClick={() => setSelectedId(nodeId(n))}
                        style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                      >
                        <code>{nodeLabel(n)}</code>
                      </button>
                      {cat && (
                        <span className="badge-source" data-category={cat}>
                          {cat}
                        </span>
                      )}
                      {imp && (
                        <span className="badge-source" data-importance={imp}>
                          {imp}
                        </span>
                      )}
                      {labels.map((label) => (
                        <span key={label} className="badge-source" data-label={label}>
                          {label}
                        </span>
                      ))}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {crossModalEdges.length > 0 && (
            <div className="card" data-testid="knowledge-v2-cross-modal-edges">
              <h3>
                Cross-modal evidence <span className="muted">(evidenced_by)</span>
              </h3>
              <ul className="knowledge-node-list">
                {crossModalEdges.map((e, i) => {
                  const src = str(e, "source");
                  const tgt = str(e, "target");
                  const srcNode = nodesById.get(src);
                  const tgtNode = nodesById.get(tgt);
                  return (
                    <li key={`cm-${i}`} data-source={src} data-target={tgt}>
                      <span className="muted">{srcNode ? nodeType(srcNode) : "?"}</span>{" "}
                      <code>{srcNode ? nodeLabel(srcNode) : src}</code>
                      {" → "}
                      <span className="muted">{tgtNode ? nodeType(tgtNode) : "?"}</span>{" "}
                      <code>{tgtNode ? nodeLabel(tgtNode) : tgt}</code>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function GraphCanvas({
  nodes,
  edges,
  selectedId,
  zoom,
  showLabels,
  onSelect,
}: {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  selectedId: string;
  zoom: number;
  showLabels: boolean;
  onSelect: (id: string) => void;
}) {
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const scale = zoom / 100;
  return (
    <svg
      className="knowledge-graph-canvas"
      viewBox="0 0 920 560"
      role="img"
      aria-label="Interactive knowledge graph"
      data-testid="knowledge-graph-canvas"
    >
      <defs>
        <radialGradient id="graph-node-module" cx="45%" cy="35%" r="75%">
          <stop offset="0%" stopColor="#11CFF3" />
          <stop offset="100%" stopColor="#0B7DFF" />
        </radialGradient>
        <radialGradient id="graph-node-file" cx="40%" cy="35%" r="80%">
          <stop offset="0%" stopColor="#F7F8FF" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#A6ABB8" stopOpacity="0.8" />
        </radialGradient>
      </defs>
      <g transform={`translate(${460 - 460 * scale} ${280 - 280 * scale}) scale(${scale})`}>
        {edges.map((edge) => {
          const source = nodeById.get(edge.source);
          const target = nodeById.get(edge.target);
          if (!source || !target) return null;
          const active = selectedId && (edge.source === selectedId || edge.target === selectedId);
          return (
            <line
              key={edge.id}
              className={active ? "graph-edge graph-edge-active" : "graph-edge"}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
            />
          );
        })}
        {nodes.map((node) => {
          const selected = node.id === selectedId;
          const radius = node.type === "module" ? 9 : Math.min(8, 4.5 + node.degree * 0.35);
          return (
            <g
              key={node.id}
              className={selected ? "graph-node graph-node-selected" : "graph-node"}
              role="button"
              tabIndex={0}
              aria-label={`${node.label}, ${node.type}`}
              transform={`translate(${node.x} ${node.y})`}
              onClick={() => onSelect(node.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") onSelect(node.id);
              }}
            >
              <circle
                r={radius}
                fill={node.type === "module" ? "url(#graph-node-module)" : "url(#graph-node-file)"}
              />
              {showLabels || selected ? (
                <text x={radius + 7} y="4">
                  {truncateLabel(node.label, selected ? 34 : 20)}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function buildGraphLayout({
  nodes,
  edges,
  selectedId,
  graphMode,
  graphDepth,
  graphLimit,
  search,
  typeFilter,
}: {
  nodes: KgRecord[];
  edges: KgRecord[];
  selectedId: string;
  graphMode: GraphMode;
  graphDepth: number;
  graphLimit: number;
  search: string;
  typeFilter: string;
}): { nodes: PositionedNode[]; edges: PositionedEdge[] } {
  const q = search.trim().toLowerCase();
  const byId = new Map<string, KgRecord>();
  for (const node of nodes) {
    const id = nodeId(node);
    if (id) byId.set(id, node);
  }
  const graphEdges = edges
    .map((edge, index) => ({
      id: str(edge, "id") || `${str(edge, "source")}-${str(edge, "target")}-${index}`,
      source: str(edge, "source"),
      target: str(edge, "target"),
      type: edgeType(edge),
    }))
    .filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graphEdges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  const matchesFilter = (node: KgRecord) => {
    if (typeFilter && nodeType(node) !== typeFilter) return false;
    if (!q) return true;
    return `${nodeId(node)} ${nodeLabel(node)} ${nodeType(node)} ${str(node, "source_guild")} ${str(node, "path")}`
      .toLowerCase()
      .includes(q);
  };
  let ids = nodes.filter(matchesFilter).map(nodeId).filter(Boolean);
  if (graphMode === "neighborhood" && selectedId && byId.has(selectedId)) {
    ids = neighborhoodIds(selectedId, adjacency, graphDepth).filter((id) => {
      const node = byId.get(id);
      return node ? matchesFilter(node) || id === selectedId : false;
    });
  }
  const degree = new Map<string, number>();
  for (const edge of graphEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  ids = ids
    .sort((a, b) => {
      const nodeA = byId.get(a)!;
      const nodeB = byId.get(b)!;
      const typeRankA = nodeType(nodeA) === "module" ? 0 : 1;
      const typeRankB = nodeType(nodeB) === "module" ? 0 : 1;
      if (typeRankA !== typeRankB) return typeRankA - typeRankB;
      return (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b);
    })
    .slice(0, graphLimit);
  const idSet = new Set(ids);
  const modules = ids.filter((id) => nodeType(byId.get(id)!) === "module");
  const others = ids.filter((id) => nodeType(byId.get(id)!) !== "module");
  const positioned = new Map<string, PositionedNode>();
  const center = { x: 460, y: 280 };
  for (const [index, id] of modules.entries()) {
    const node = byId.get(id)!;
    const angle = (Math.PI * 2 * index) / Math.max(modules.length, 1) - Math.PI / 2;
    positioned.set(id, toPositionedNode(node, id, center.x + Math.cos(angle) * 120, center.y + Math.sin(angle) * 95, degree));
  }
  const rings = Math.max(1, Math.ceil(others.length / 72));
  for (const [index, id] of others.entries()) {
    const node = byId.get(id)!;
    const ring = Math.floor((index / Math.max(others.length, 1)) * rings);
    const localIndex = index - Math.floor((others.length / rings) * ring);
    const ringCount = Math.max(1, Math.ceil(others.length / rings));
    const angle = (Math.PI * 2 * localIndex) / ringCount + ring * 0.34;
    const rx = 225 + ring * 76;
    const ry = 140 + ring * 48;
    positioned.set(id, toPositionedNode(node, id, center.x + Math.cos(angle) * rx, center.y + Math.sin(angle) * ry, degree));
  }
  const visibleEdges = graphEdges.filter((edge) => idSet.has(edge.source) && idSet.has(edge.target));
  return { nodes: [...positioned.values()], edges: visibleEdges };
}

function toPositionedNode(
  node: KgRecord,
  id: string,
  x: number,
  y: number,
  degree: Map<string, number>,
): PositionedNode {
  return {
    id,
    label: nodeLabel(node),
    type: nodeType(node),
    sourceGuild: str(node, "source_guild"),
    x,
    y,
    degree: degree.get(id) ?? 0,
    raw: node,
  };
}

function neighborhoodIds(
  startId: string,
  adjacency: Map<string, Set<string>>,
  depth: number,
): string[] {
  const seen = new Set([startId]);
  let frontier = [startId];
  for (let i = 0; i < depth; i++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (seen.has(neighbor)) continue;
        seen.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return [...seen];
}

function truncateLabel(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}
