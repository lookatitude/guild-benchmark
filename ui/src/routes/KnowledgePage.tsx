import { useCallback, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ProjectKnowledgeGraphResponse } from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";
import {
  runForceLayout,
  guildColor,
  panTransform,
  zoomTransform,
  screenToWorld,
  IDENTITY_TRANSFORM,
  DEFAULT_LAYOUT_OPTIONS,
  SMALL_GRAPH_MAX,
  type ViewTransform,
} from "./forceLayout";
import {
  buildImportanceScale,
  buildImportanceLegend,
  importanceRadius,
  importanceBucket,
  importanceColor,
  isDegenerate,
  MAX_RADIUS,
  type ImportanceScale,
} from "./architecture";

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

// Federated graphs reuse the same raw id across `source_guild`s, so EVERY graph
// join + the whole selection round-trip key on the composite (source_guild, id).
// `JSON.stringify` gives a reversible, NUL-free, collision-free key (a raw id
// can never equal a JSON-array string), so `git` still treats the file as text.
function compositeKey(guild: string, id: string): string {
  return JSON.stringify([guild, id]);
}

/** Composite key of a node from its own `source_guild` + id. */
function nodeKey(n: KgRecord): string {
  return compositeKey(str(n, "source_guild"), nodeId(n));
}

/** Composite key of an edge endpoint, assuming it lives in the edge's own guild. */
function edgeEndKey(e: KgRecord, which: "source" | "target"): string {
  return compositeKey(str(e, "source_guild"), str(e, which));
}

/** raw id → all nodes carrying it (to detect cross-guild uniqueness). */
function buildRawIdIndex(nodes: KgRecord[]): Map<string, KgRecord[]> {
  const m = new Map<string, KgRecord[]>();
  for (const n of nodes) {
    const id = nodeId(n);
    if (!id) continue;
    const list = m.get(id) ?? [];
    list.push(n);
    m.set(id, list);
  }
  return m;
}

/**
 * Resolve an edge endpoint to a concrete node's composite key. Intra-guild edges
 * (the common + federated-safe case) resolve in the edge's own guild; a genuine
 * cross-guild edge (endpoint lives in a different guild) resolves to the unique
 * node bearing that raw id. Only when the raw id is ambiguous (present in several
 * guilds but none is the edge's) do we fall back to the synthetic edge-guild key.
 */
function resolveEndpointKey(
  e: KgRecord,
  which: "source" | "target",
  nodesByKey: Map<string, KgRecord>,
  rawIdIndex: Map<string, KgRecord[]>,
): string {
  const k = edgeEndKey(e, which);
  if (nodesByKey.has(k)) return k;
  const candidates = rawIdIndex.get(str(e, which));
  if (candidates && candidates.length === 1) return nodeKey(candidates[0]);
  return k;
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
  guild: string;
  /** From the `flow_step` edge `weight` — monotonically encodes step order. */
  weight: number;
}

interface DomainFlowGroup {
  id: string;
  label: string;
  guild: string;
  steps: DomainFlowStep[];
}

interface DomainGroup {
  id: string;
  label: string;
  guild: string;
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

// FIX-G11 finding 2 / round-2 finding 4 — federated joins key on the composite
// (guild, id). Delegates to the shared NUL-free `compositeKey`.
function guildKey(guild: string, id: string): string {
  return compositeKey(guild, id);
}

const IMPORTANCE_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Stable ordering rank for a domain/flow node: higher `importance` then higher
 * numeric `weight` first, with the id as the deterministic final tiebreak. This
 * is what makes the FULL output (domain order, flow order, step order)
 * shuffle-invariant — not just step order (FIX-G11 finding 1).
 */
function orderCompare(a: KgRecord, b: KgRecord): number {
  const rankA = (IMPORTANCE_RANK[str(a, "importance").toLowerCase()] ?? 0) * 1e6 + num(a, "weight");
  const rankB = (IMPORTANCE_RANK[str(b, "importance").toLowerCase()] ?? 0) * 1e6 + num(b, "weight");
  if (rankB !== rankA) return rankB - rankA;
  const idA = nodeId(a);
  const idB = nodeId(b);
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * Group `domain` nodes → their business `flow` nodes (via `contains_flow`
 * edges, domain→flow) → ordered `step` nodes (via `flow_step` edges, flow→step).
 *
 * Determinism (FIX-G11): the ENTIRE output is a pure function of the graph
 * content, independent of input array order — domains and flows are sorted by a
 * stable key (importance/weight, then id) and steps by `flow_step` `weight`
 * (then id). Joins are keyed by the composite (source_guild, id) so same-id
 * nodes from different guilds never collapse. Lenient: any field may be absent;
 * returns `[]` when there are no domains.
 */
function buildDomainFlows(nodes: KgRecord[], edges: KgRecord[]): DomainGroup[] {
  const nodesByKey = new Map<string, KgRecord>();
  for (const n of nodes) {
    const id = nodeId(n);
    if (id) nodesByKey.set(guildKey(str(n, "source_guild"), id), n);
  }

  const domainNodes = nodes.filter((n) => nodeType(n) === "domain" && nodeId(n));
  if (domainNodes.length === 0) return [];

  // domain key → flow {guild,id}[] (contains_flow: source = domain, target = flow,
  // resolved within the edge's own source_guild).
  const flowsOf = new Map<string, Array<{ guild: string; id: string }>>();
  for (const e of edges) {
    if (str(e, "type") !== "contains_flow") continue;
    const guild = str(e, "source_guild");
    const domain = str(e, "source");
    const flow = str(e, "target");
    if (!domain || !flow) continue;
    const dk = guildKey(guild, domain);
    const list = flowsOf.get(dk) ?? [];
    list.push({ guild, id: flow });
    flowsOf.set(dk, list);
  }

  // flow key → steps (flow_step: source = flow, target = step), ordered by weight.
  const stepsOf = new Map<string, DomainFlowStep[]>();
  for (const e of edges) {
    if (str(e, "type") !== "flow_step") continue;
    const guild = str(e, "source_guild");
    const flow = str(e, "source");
    const step = str(e, "target");
    if (!flow || !step) continue;
    const fk = guildKey(guild, flow);
    const sn = nodesByKey.get(guildKey(guild, step));
    const list = stepsOf.get(fk) ?? [];
    list.push({ id: step, label: sn ? nodeLabel(sn) : step, guild, weight: num(e, "weight") });
    stepsOf.set(fk, list);
  }
  // Order steps by weight, then id — independent of input edge order.
  for (const list of stepsOf.values()) {
    list.sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // Domains in a stable order (not input order).
  const sortedDomains = [...domainNodes].sort(orderCompare);

  return sortedDomains.map((dn) => {
    const guild = str(dn, "source_guild");
    const id = nodeId(dn);
    const flowRefs = flowsOf.get(guildKey(guild, id)) ?? [];
    // Resolve flow nodes, then order flows by the same stable key. A flow with
    // no node falls back to a synthetic record so ordering stays deterministic.
    const flows = flowRefs
      .map((ref) => {
        const fk = guildKey(ref.guild, ref.id);
        const fn = nodesByKey.get(fk);
        const rec: KgRecord = fn ?? { id: ref.id, source_guild: ref.guild };
        return {
          rec,
          group: {
            id: ref.id,
            label: fn ? nodeLabel(fn) : ref.id,
            guild: ref.guild,
            steps: stepsOf.get(fk) ?? [],
          } as DomainFlowGroup,
        };
      })
      .sort((a, b) => orderCompare(a.rec, b.rec))
      .map((f) => f.group);
    return {
      id,
      label: nodeLabel(dn),
      guild,
      flows,
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
        <div
          key={`${domain.guild} ${domain.id}`}
          className="domain-group"
          data-domain-id={domain.id}
          data-guild={domain.guild || "project"}
        >
          <h4>
            {domain.label} <span className="muted">domain</span>
          </h4>
          {domain.flows.length === 0 ? (
            <p className="muted">No business flows in this domain.</p>
          ) : (
            domain.flows.map((flow) => (
              <div
                key={`${flow.guild} ${flow.id}`}
                className="domain-flow"
                data-flow-id={flow.id}
              >
                <h5>
                  {flow.label} <span className="muted">flow</span>
                </h5>
                {flow.steps.length === 0 ? (
                  <p className="muted">No steps recorded for this flow.</p>
                ) : (
                  <ol className="domain-flow-steps">
                    {flow.steps.map((step) => {
                      // FIX round-2 #1 — select via the composite (guild,id) key,
                      // not the raw id, so federated same-id steps pick the right node.
                      const selKey = compositeKey(step.guild, step.id);
                      return (
                        <li key={selKey} data-step-id={step.id} data-step-key={selKey}>
                          <button
                            onClick={() => onSelect(selKey)}
                            aria-pressed={selectedId === selKey}
                            style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
                          >
                            <code>{step.label}</code>
                          </button>
                        </li>
                      );
                    })}
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

// ---- Architecture & importance helpers (G12) ------------------------------

/** Fields, in priority order, that a structural/architecture pass may use to
 *  group a node into a layer / component / cluster. First present wins. */
const LAYER_FIELDS = ["layer", "component", "cluster"] as const;

/** The layer/cluster a node belongs to, or null if it carries none. */
function nodeLayer(n: KgRecord): { field: string; value: string } | null {
  for (const f of LAYER_FIELDS) {
    const v = str(n, f);
    if (v) return { field: f, value: v };
  }
  return null;
}

/**
 * Degree-centrality per node, keyed by the composite (source_guild, id). Edge
 * endpoints resolve via the same `resolveEndpointKey` the canvas uses, so
 * federated same-id nodes never share a degree count, and an endpoint that
 * resolves to a real node is credited even when the OTHER endpoint is a phantom.
 */
function computeNodeDegrees(nodes: KgRecord[], edges: KgRecord[]): Map<string, number> {
  const nodesByKey = new Map<string, KgRecord>();
  for (const n of nodes) {
    if (nodeId(n)) nodesByKey.set(nodeKey(n), n);
  }
  const rawIdIndex = buildRawIdIndex(nodes);
  const degree = new Map<string, number>();
  for (const e of edges) {
    const s = resolveEndpointKey(e, "source", nodesByKey, rawIdIndex);
    const t = resolveEndpointKey(e, "target", nodesByKey, rawIdIndex);
    if (nodesByKey.has(s)) degree.set(s, (degree.get(s) ?? 0) + 1);
    if (nodesByKey.has(t)) degree.set(t, (degree.get(t) ?? 0) + 1);
  }
  return degree;
}

/**
 * A node's importance value. Degree-centrality is the always-available,
 * deterministic base signal; a numeric `importance_score` (author/structural
 * pass provided) OVERRIDES it when present so an explicitly-scored node is not
 * capped by its raw degree. Monotonic in both inputs. Lenient: any field absent.
 */
function nodeImportanceValue(n: KgRecord, degree: number): number {
  const raw = n["importance_score"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const p = parseFloat(raw);
    if (!Number.isNaN(p)) return p;
  }
  return degree;
}

interface ArchNodeView {
  /** Composite (source_guild, id) selection key. */
  key: string;
  id: string;
  label: string;
  type: string;
  guild: string;
  degree: number;
  value: number;
  bucket: number;
  radius: number;
}

interface ArchLayer {
  /** Composite (guild, field, layer-value) group key — distinct per guild AND
   *  per source field, so same-value groups from different fields never merge. */
  id: string;
  /** The layer/cluster value (the rendered group heading). */
  label: string;
  /** Which field supplied the grouping (`layer` / `component` / `cluster`). */
  field: string;
  guild: string;
  nodes: ArchNodeView[];
}

interface ArchitectureModel {
  layers: ArchLayer[];
  scale: ImportanceScale;
}

/**
 * Group nodes carrying a `layer`/`component`/`cluster` field into architecture
 * layers and attach the importance encoding (radius + colour bucket) to each.
 *
 * Determinism: the importance SCALE is built over ALL nodes' values (so the
 * encoding is comparable across layers), layers sort by a stable
 * (guild, label) key, and members sort by importance desc then id — the whole
 * output is a pure function of graph content, independent of input order.
 * Federation: degree + layer joins key on the composite (source_guild, id); a
 * layer value shared across guilds yields one group PER guild (no collapse).
 * Lenient: any field may be absent; returns `{ layers: [], scale }` (empty
 * architecture) when no node carries a layer/cluster field.
 */
function buildArchitecture(nodes: KgRecord[], edges: KgRecord[]): ArchitectureModel {
  const degrees = computeNodeDegrees(nodes, edges);

  // Scale over EVERY node's importance value (not just grouped ones) so leaves
  // and hubs share one comparable scale.
  const values: number[] = [];
  for (const n of nodes) {
    if (!nodeId(n)) continue;
    values.push(nodeImportanceValue(n, degrees.get(nodeKey(n)) ?? 0));
  }
  const scale = buildImportanceScale(values);

  const groups = new Map<string, ArchLayer>();
  for (const n of nodes) {
    const id = nodeId(n);
    if (!id) continue;
    const layer = nodeLayer(n);
    if (!layer) continue;
    const guild = str(n, "source_guild");
    // Key the group by (guild, FIELD, value) — not just (guild, value) — so a
    // `component:"core"` node and a `cluster:"core"` node in the SAME guild form
    // two distinct groups instead of collapsing (and being mislabelled by the
    // field that happened to appear first). NUL-free reversible JSON key.
    const gkey = JSON.stringify([guild, layer.field, layer.value]);
    const key = nodeKey(n);
    const degree = degrees.get(key) ?? 0;
    const value = nodeImportanceValue(n, degree);
    const view: ArchNodeView = {
      key,
      id,
      label: nodeLabel(n),
      type: nodeType(n),
      guild,
      degree,
      value,
      bucket: importanceBucket(value, scale),
      radius: importanceRadius(value, scale),
    };
    const existing = groups.get(gkey);
    if (existing) existing.nodes.push(view);
    else groups.set(gkey, { id: gkey, label: layer.value, field: layer.field, guild, nodes: [view] });
  }

  // Sort by the FULL group key (guild, label, field) — label alone is not a
  // stable key: two fields can yield the same label in one guild, so `field`
  // breaks the tie and the order stays input-independent.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const layers = [...groups.values()].sort(
    (a, b) => cmp(a.guild, b.guild) || cmp(a.label, b.label) || cmp(a.field, b.field),
  );
  for (const layer of layers) {
    layer.nodes.sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { layers, scale };
}

/** Importance legend — colour swatch + value range per bucket. */
function ImportanceLegend({ scale }: { scale: ImportanceScale }) {
  const entries = buildImportanceLegend(scale);
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  return (
    <div
      className="importance-legend"
      data-testid="knowledge-importance-legend"
      data-degenerate={isDegenerate(scale) ? "true" : "false"}
      aria-label="Importance scale legend"
    >
      <span className="muted">Importance (degree / score):</span>
      {entries.map((e) => (
        <span key={e.bucket} className="importance-legend-item" data-bucket={e.bucket}>
          <span
            className="importance-legend-swatch"
            style={{
              background: e.color,
              display: "inline-block",
              width: 10,
              height: 10,
              borderRadius: "50%",
            }}
          />{" "}
          {fmt(e.lo)}{e.hi !== e.lo ? `–${fmt(e.hi)}` : ""}
        </span>
      ))}
    </div>
  );
}

/** Architecture layers + importance heatmap (per-node size/colour encoding). */
function ArchitectureView({
  model,
  selectedId,
  onSelect,
  workspaceMode,
}: {
  model: ArchitectureModel;
  selectedId: string;
  onSelect: (key: string) => void;
  workspaceMode: boolean;
}) {
  const diameter = MAX_RADIUS * 2;
  return (
    <div className="architecture-layers" data-testid="knowledge-architecture-layers">
      {model.layers.map((layer) => (
        <div
          key={layer.id}
          className="architecture-layer"
          data-layer-id={layer.id}
          data-layer={layer.label}
          data-field={layer.field}
          data-guild={layer.guild || "project"}
        >
          <h4>
            {layer.label}{" "}
            <span className="muted">
              {layer.field} · {layer.nodes.length}
            </span>
            {workspaceMode && layer.guild ? (
              <span className="badge-source" style={{ marginLeft: 8 }}>
                {layer.guild}
              </span>
            ) : null}
          </h4>
          <ul className="architecture-layer-nodes">
            {layer.nodes.map((n) => (
              <li
                key={n.key}
                data-node-id={n.id}
                data-node-key={n.key}
                data-importance-bucket={n.bucket}
                data-degree={n.degree}
                data-radius={n.radius.toFixed(2)}
              >
                <button
                  onClick={() => onSelect(n.key)}
                  aria-pressed={selectedId === n.key}
                  title={`degree ${n.degree} · importance ${n.value}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    background: "none",
                    border: 0,
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  <svg width={diameter} height={diameter} aria-hidden="true">
                    <circle
                      cx={MAX_RADIUS}
                      cy={MAX_RADIUS}
                      r={n.radius}
                      fill={importanceColor(n.bucket, model.scale.buckets)}
                    />
                  </svg>
                  <code>{n.label}</code> <span className="muted">{n.type}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export { buildArchitecture };
export type { ArchitectureModel, ArchLayer, ArchNodeView };

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
  const [showLabels, setShowLabels] = useState(true);
  // G13 — zoom/pan transform + user-dragged (pinned) node positions.
  const [transform, setTransform] = useState<ViewTransform>(IDENTITY_TRANSFORM);
  const [pins, setPins] = useState<Map<string, { x: number; y: number }>>(
    () => new Map(),
  );

  // FIX round-2 — keyed by the composite (source_guild, id); `selectedId` is a
  // composite key everywhere, so federated same-id nodes never collapse.
  const nodesByKey = useMemo(() => {
    const map = new Map<string, KgRecord>();
    for (const n of data?.nodes ?? []) {
      if (nodeId(n)) map.set(nodeKey(n), n);
    }
    return map;
  }, [data]);

  // raw id → nodes, to resolve cross-guild edge endpoints unambiguously.
  const nodesByRawId = useMemo(() => buildRawIdIndex(data?.nodes ?? []), [data]);

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

  // G13 — force-directed positions. Tiny graphs keep the static ring layout
  // (fallback, no regression); larger graphs run the physics simulation, with
  // user-dragged nodes pinned. The layout space matches the canvas viewBox.
  const useForce = graph.nodes.length > SMALL_GRAPH_MAX;
  const viewW = useForce ? DEFAULT_LAYOUT_OPTIONS.width : 920;
  const viewH = useForce ? DEFAULT_LAYOUT_OPTIONS.height : 560;

  const layoutNodes = useMemo<PositionedNode[]>(() => {
    if (!useForce) {
      // Static fallback: honor any pins, otherwise keep ring positions.
      return graph.nodes.map((n) => {
        const pin = pins.get(n.id);
        return pin ? { ...n, x: pin.x, y: pin.y } : n;
      });
    }
    const laid = runForceLayout(
      graph.nodes.map((n) => ({ id: n.id, guild: n.sourceGuild })),
      graph.edges.map((e) => ({ source: e.source, target: e.target })),
      { pins },
    );
    const posById = new Map(laid.map((n) => [n.id, n]));
    return graph.nodes.map((n) => {
      const p = posById.get(n.id);
      return p ? { ...n, x: p.x, y: p.y } : n;
    });
  }, [graph, pins, useForce]);

  // Distinct guilds present in the rendered layout → legend (workspace only).
  const guildLegend = useMemo(() => {
    const guilds = new Set<string>();
    for (const n of layoutNodes) guilds.add(n.sourceGuild || "project");
    return [...guilds].sort().map((g) => ({ guild: g, color: guildColor(g) }));
  }, [layoutNodes]);

  const selected = selectedId ? nodesByKey.get(selectedId) : undefined;

  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return (data?.edges ?? []).filter(
      (e) =>
        resolveEndpointKey(e, "source", nodesByKey, nodesByRawId) === selectedId ||
        resolveEndpointKey(e, "target", nodesByKey, nodesByRawId) === selectedId,
    );
  }, [data, selectedId, nodesByKey, nodesByRawId]);

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

  // G12 — architecture layers + importance heatmap (degree-centrality / score).
  const architecture = useMemo(
    () => (data ? buildArchitecture(data.nodes, data.edges) : { layers: [], scale: buildImportanceScale([]) }),
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
                  nodes={layoutNodes}
                  edges={graph.edges}
                  selectedId={selectedId}
                  showLabels={showLabels}
                  viewW={viewW}
                  viewH={viewH}
                  transform={transform}
                  setTransform={setTransform}
                  setPins={setPins}
                  colorByGuild={workspaceMode}
                  onSelect={(id) => {
                    setSelectedId(id);
                    if (graphMode === "overview") setGraphMode("neighborhood");
                  }}
                />

                <div className="graph-footer">
                  <span className="muted">
                    Showing {graph.nodes.length} of {data.nodes.length} nodes, {graph.edges.length} edges
                    {useForce ? " · force layout" : " · static layout"}.
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
                      min={20}
                      max={400}
                      value={Math.round(transform.k * 100)}
                      onChange={(e) =>
                        setTransform((t) =>
                          zoomTransform(t, Number(e.target.value) / 100 / t.k, viewW / 2, viewH / 2),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="button-secondary"
                    data-testid="knowledge-graph-reset"
                    onClick={() => {
                      setTransform(IDENTITY_TRANSFORM);
                      setPins(new Map());
                    }}
                  >
                    Reset view
                  </button>
                </div>
                {colorLegend(workspaceMode, guildLegend)}
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
                  const key = nodeKey(n);
                  return (
                    <li key={`${id}-${i}`}>
                      <button
                        onClick={() => setSelectedId(key)}
                        aria-pressed={selectedId === key}
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
                        const srcKey = resolveEndpointKey(e, "source", nodesByKey, nodesByRawId);
                        const tgtKey = resolveEndpointKey(e, "target", nodesByKey, nodesByRawId);
                        const neighborKey = srcKey === selectedId ? tgtKey : srcKey;
                        const neighbor = nodesByKey.get(neighborKey);
                        const arrow = srcKey === selectedId ? "→" : "←";
                        return (
                          <li key={`${neighborKey}-${i}`}>
                            <span className="muted">{arrow}</span>{" "}
                            <button
                              onClick={() => setSelectedId(neighborKey)}
                              style={{
                                background: "none",
                                border: 0,
                                padding: 0,
                                cursor: "pointer",
                              }}
                            >
                              <code>
                                {neighbor ? nodeLabel(neighbor) : str(e, srcKey === selectedId ? "target" : "source") || "(unknown)"}
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

          {/* G12 — Architecture & importance. Always rendered when the graph
              has nodes; the legend reflects the importance scale (one bucket
              when degenerate) and the layered view shows an empty-state when no
              node carries a layer/component/cluster field. */}
          {data.nodes.length > 0 && (
            <div className="card" data-testid="knowledge-architecture">
              <h3>
                Architecture &amp; importance{" "}
                <span className="muted">(layer · degree-centrality)</span>
              </h3>
              <ImportanceLegend scale={architecture.scale} />
              {architecture.layers.length === 0 ? (
                <div className="empty" data-testid="knowledge-architecture-empty">
                  No architecture layers in this graph (no node carries a
                  layer/component/cluster field).
                </div>
              ) : (
                <ArchitectureView
                  model={architecture}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  workspaceMode={workspaceMode}
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
                        onClick={() => setSelectedId(nodeKey(n))}
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
                  const srcNode = nodesByKey.get(resolveEndpointKey(e, "source", nodesByKey, nodesByRawId));
                  const tgtNode = nodesByKey.get(resolveEndpointKey(e, "target", nodesByKey, nodesByRawId));
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

/** Guild → colour legend (workspace mode only). */
function colorLegend(
  workspaceMode: boolean,
  legend: { guild: string; color: string }[],
) {
  if (!workspaceMode || legend.length === 0) return null;
  return (
    <div className="graph-legend" data-testid="knowledge-graph-legend" aria-label="Guild colour legend">
      {legend.map(({ guild, color }) => (
        <span key={guild} className="graph-legend-item" data-guild={guild}>
          <span
            className="graph-legend-swatch"
            style={{ background: color, display: "inline-block", width: 10, height: 10, borderRadius: 2 }}
          />{" "}
          {guild}
        </span>
      ))}
    </div>
  );
}

interface DragState {
  id: string;
  moved: boolean;
  // pointer offset (world) from node centre at grab time
  startX: number;
  startY: number;
}

function GraphCanvas({
  nodes,
  edges,
  selectedId,
  showLabels,
  viewW,
  viewH,
  transform,
  setTransform,
  setPins,
  colorByGuild,
  onSelect,
}: {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  selectedId: string;
  showLabels: boolean;
  viewW: number;
  viewH: number;
  transform: ViewTransform;
  setTransform: Dispatch<SetStateAction<ViewTransform>>;
  setPins: Dispatch<SetStateAction<Map<string, { x: number; y: number }>>>;
  colorByGuild: boolean;
  onSelect: (id: string) => void;
}) {
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodeDrag = useRef<DragState | null>(null);
  const panDrag = useRef<{ x: number; y: number } | null>(null);

  // Map a pointer event to viewBox (pre-transform) coordinates.
  const toView = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const r = svg.getBoundingClientRect();
      // Guard against non-finite rects (jsdom/happy-dom return zeros/NaN) so a
      // NaN never leaks into the transform and onto SVG coordinates.
      const left = Number.isFinite(r.left) ? r.left : 0;
      const top = Number.isFinite(r.top) ? r.top : 0;
      const w = Number.isFinite(r.width) && r.width > 0 ? r.width : 1;
      const h = Number.isFinite(r.height) && r.height > 0 ? r.height : 1;
      const px = Number.isFinite(clientX) ? clientX : 0;
      const py = Number.isFinite(clientY) ? clientY : 0;
      return { x: ((px - left) / w) * viewW, y: ((py - top) / h) * viewH };
    },
    [viewW, viewH],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      const v = toView(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setTransform((t) => zoomTransform(t, factor, v.x, v.y));
    },
    [setTransform, toView],
  );

  const onPointerDownBackground = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (nodeDrag.current) return; // a node grab takes precedence
      panDrag.current = {
        x: Number.isFinite(e.clientX) ? e.clientX : 0,
        y: Number.isFinite(e.clientY) ? e.clientY : 0,
      };
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (nodeDrag.current) {
        const v = toView(e.clientX, e.clientY);
        const world = screenToWorld(transform, v.x, v.y);
        const id = nodeDrag.current.id;
        nodeDrag.current.moved = true;
        setPins((prev) => {
          const next = new Map(prev);
          next.set(id, { x: world.x, y: world.y });
          return next;
        });
        return;
      }
      if (panDrag.current) {
        const ex = Number.isFinite(e.clientX) ? e.clientX : panDrag.current.x;
        const ey = Number.isFinite(e.clientY) ? e.clientY : panDrag.current.y;
        const dxScreen = ex - panDrag.current.x;
        const dyScreen = ey - panDrag.current.y;
        panDrag.current = { x: ex, y: ey };
        const svg = svgRef.current;
        const r = svg?.getBoundingClientRect();
        const rw = r && Number.isFinite(r.width) && r.width > 0 ? r.width : 0;
        const rh = r && Number.isFinite(r.height) && r.height > 0 ? r.height : 0;
        const sx = rw ? (dxScreen / rw) * viewW : dxScreen;
        const sy = rh ? (dyScreen / rh) * viewH : dyScreen;
        setTransform((t) => panTransform(t, sx, sy));
      }
    },
    [setPins, setTransform, toView, transform, viewW, viewH],
  );

  const endDrag = useCallback(() => {
    panDrag.current = null;
    nodeDrag.current = null;
  }, []);

  return (
    <>
      <svg
        ref={svgRef}
        className="knowledge-graph-canvas"
        viewBox={`0 0 ${viewW} ${viewH}`}
        role="img"
        aria-label="Interactive knowledge graph"
        data-testid="knowledge-graph-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDownBackground}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        style={{ touchAction: "none", cursor: panDrag.current ? "grabbing" : "grab" }}
      >
        <defs>
          <radialGradient id="graph-node-module" cx="45%" cy="35%" r="75%">
            <stop offset="0%" stopColor="var(--color-cyan)" />
            <stop offset="100%" stopColor="var(--color-accent-strong)" />
          </radialGradient>
          <radialGradient id="graph-node-file" cx="40%" cy="35%" r="80%">
            <stop offset="0%" stopColor="var(--color-fg)" stopOpacity="0.95" />
            <stop offset="100%" stopColor="var(--color-fg-muted)" stopOpacity="0.8" />
          </radialGradient>
        </defs>
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
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
            const guildFill = colorByGuild ? guildColor(node.sourceGuild || "project") : undefined;
            return (
              <g
                key={node.id}
                className={selected ? "graph-node graph-node-selected" : "graph-node"}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}, ${node.type}`}
                data-guild={node.sourceGuild || "project"}
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  nodeDrag.current = { id: node.id, moved: false, startX: node.x, startY: node.y };
                }}
                onPointerUp={(e) => {
                  // A grab that never moved is a click → select.
                  if (nodeDrag.current && !nodeDrag.current.moved) {
                    onSelect(node.id);
                  }
                  e.stopPropagation();
                  endDrag();
                }}
                onClick={() => onSelect(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(node.id);
                }}
              >
                <circle
                  r={radius}
                  fill={
                    guildFill ??
                    (node.type === "module" ? "url(#graph-node-module)" : "url(#graph-node-file)")
                  }
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
    </>
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
  // FIX round-2 #2 — the canvas joins (byId, edges, degree, neighborhood) and
  // PositionedNode.id all key on the composite (source_guild, id). The raw id
  // stays available for display via the resolved node record.
  const q = search.trim().toLowerCase();
  const byId = new Map<string, KgRecord>();
  for (const node of nodes) {
    if (nodeId(node)) byId.set(nodeKey(node), node);
  }
  const rawIdIndex = buildRawIdIndex(nodes);
  const graphEdges = edges
    .map((edge, index) => {
      const source = resolveEndpointKey(edge, "source", byId, rawIdIndex);
      const target = resolveEndpointKey(edge, "target", byId, rawIdIndex);
      return {
        id: str(edge, "id") || `${source}-${target}-${index}`,
        source,
        target,
        type: edgeType(edge),
      };
    })
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
  let ids = nodes.filter((n) => matchesFilter(n) && nodeId(n)).map(nodeKey);
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
