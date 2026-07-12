// arch-importance-view.test.tsx — T12.1 / Goal G12 validation gate.
//
// Gate items (non-vacuous, numeric where the goal demands it):
//   1. MEASURABLE importance encoding: the size/colour MAPPING FUNCTION is
//      monotonic in degree/importance — a degree-20 node maps to a strictly
//      larger radius AND a strictly higher colour bucket than a degree-2 node.
//      Anti-vacuity: swapping the two nodes' degrees flips the assertion (proven
//      on the real `buildArchitecture` path, not just the scalar helper).
//   2. Layer/cluster grouping: a fixture with 2 distinct `layer`/cluster values
//      renders 2 groups; group membership equals the field (asserted). Clear
//      empty-state when no node carries a layer/component/cluster field.
//   3. Legend present; a degenerate (all-equal) graph renders with ONE bucket
//      (no divide-by-zero / NaN radius — explicit test).
//   + Federation: a layer value shared across guilds yields one group PER guild
//      (composite (source_guild,id) keying — anti-vacuity vs raw-id collapse).
//   + Real path: rendering the page and CLICKING an architecture node selects it.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import KnowledgePage, { buildArchitecture } from "../KnowledgePage";
import {
  buildImportanceScale,
  buildImportanceLegend,
  importanceRadius,
  importanceBucket,
  importanceColor,
  importanceFraction,
  isDegenerate,
} from "../architecture";
import { installMockFetch } from "../../__tests__/fixtures/mockFetch";

type Rec = Record<string, unknown>;

// A node with `deg` distinct leaf neighbours → degree-centrality === deg.
// `hubLayer` puts the hub in an architecture layer; leaves stay un-grouped.
function hubWithDegree(hubId: string, deg: number, layer: string): { nodes: Rec[]; edges: Rec[] } {
  const nodes: Rec[] = [{ id: hubId, type: "module", name: hubId, layer }];
  const edges: Rec[] = [];
  for (let i = 0; i < deg; i++) {
    const leaf = `${hubId}-leaf${i}`;
    nodes.push({ id: leaf, type: "file", name: leaf });
    edges.push({ source: hubId, target: leaf, type: "imports" });
  }
  return { nodes, edges };
}

function merge(...parts: Array<{ nodes: Rec[]; edges: Rec[] }>): { nodes: Rec[]; edges: Rec[] } {
  return {
    nodes: parts.flatMap((p) => p.nodes),
    edges: parts.flatMap((p) => p.edges),
  };
}

function archNode(model: ReturnType<typeof buildArchitecture>, id: string) {
  for (const layer of model.layers) {
    const n = layer.nodes.find((x) => x.id === id);
    if (n) return n;
  }
  throw new Error(`arch node ${id} not found`);
}

// ---- Gate 1: measurable, monotonic importance encoding --------------------

describe("G12 gate 1 — importance encoding is monotonic (scalar helper)", () => {
  const scale = buildImportanceScale([2, 20]);

  it("higher value → strictly larger radius and higher colour bucket", () => {
    expect(importanceRadius(20, scale)).toBeGreaterThan(importanceRadius(2, scale));
    expect(importanceBucket(20, scale)).toBeGreaterThan(importanceBucket(2, scale));
  });

  it("anti-vacuity: swapping the values flips both assertions", () => {
    // Same scale, swapped query values → strictly the opposite ordering.
    expect(importanceRadius(2, scale)).toBeLessThan(importanceRadius(20, scale));
    expect(importanceBucket(2, scale)).toBeLessThan(importanceBucket(20, scale));
  });

  it("is monotonic non-decreasing across the whole span", () => {
    let prevR = -Infinity;
    let prevB = -1;
    for (let v = 2; v <= 20; v++) {
      const r = importanceRadius(v, scale);
      const b = importanceBucket(v, scale);
      expect(r).toBeGreaterThanOrEqual(prevR);
      expect(b).toBeGreaterThanOrEqual(prevB);
      prevR = r;
      prevB = b;
    }
  });
});

describe("G12 gate 1 — encoding on the REAL buildArchitecture path", () => {
  it("a degree-20 hub encodes strictly larger + higher-bucket than a degree-2 hub", () => {
    const graph = merge(
      hubWithDegree("hub20", 20, "core"),
      hubWithDegree("hub2", 2, "core"),
    );
    const model = buildArchitecture(graph.nodes, graph.edges);
    const big = archNode(model, "hub20");
    const small = archNode(model, "hub2");
    expect(big.degree).toBe(20);
    expect(small.degree).toBe(2);
    expect(big.radius).toBeGreaterThan(small.radius);
    expect(big.bucket).toBeGreaterThan(small.bucket);
  });

  it("anti-vacuity: swapping the SAME hubs' DEGREES flips the ordering (identity-based impl fails)", () => {
    // Keep the two identities FIXED (`hubX`, `hubY`); only their DEGREE (edge
    // count) swaps between the two scenarios. An impl that encoded size/colour
    // from the node id/name instead of its degree would map hubX vs hubY the
    // same way in both models and so could not satisfy BOTH orderings — only a
    // genuinely degree-driven encoding flips when the degrees flip.
    const scenario = (hiId: string, loId: string) =>
      merge(hubWithDegree(hiId, 20, "core"), hubWithDegree(loId, 2, "core"));

    // Scenario 1: hubX = degree 20, hubY = degree 2.
    const s1 = scenario("hubX", "hubY");
    const m1 = buildArchitecture(s1.nodes, s1.edges);
    expect(archNode(m1, "hubX").degree).toBe(20);
    expect(archNode(m1, "hubY").degree).toBe(2);
    expect(archNode(m1, "hubX").radius).toBeGreaterThan(archNode(m1, "hubY").radius);
    expect(archNode(m1, "hubX").bucket).toBeGreaterThan(archNode(m1, "hubY").bucket);

    // Scenario 2: SAME ids, DEGREES swapped — hubX = 2, hubY = 20.
    const s2 = scenario("hubY", "hubX");
    const m2 = buildArchitecture(s2.nodes, s2.edges);
    expect(archNode(m2, "hubX").degree).toBe(2);
    expect(archNode(m2, "hubY").degree).toBe(20);
    // The ordering for the SAME ids flips — proves size/colour follows degree.
    expect(archNode(m2, "hubX").radius).toBeLessThan(archNode(m2, "hubY").radius);
    expect(archNode(m2, "hubX").bucket).toBeLessThan(archNode(m2, "hubY").bucket);
  });

  it("a numeric importance_score overrides degree (monotonic in the score)", () => {
    const nodes: Rec[] = [
      { id: "scored-hi", type: "module", name: "scored-hi", layer: "core", importance_score: 9 },
      { id: "scored-lo", type: "module", name: "scored-lo", layer: "core", importance_score: 1 },
    ];
    const model = buildArchitecture(nodes, []);
    const hi = archNode(model, "scored-hi");
    const lo = archNode(model, "scored-lo");
    expect(hi.value).toBe(9); // score, not degree (0)
    expect(lo.value).toBe(1);
    expect(hi.radius).toBeGreaterThan(lo.radius);
    expect(hi.bucket).toBeGreaterThan(lo.bucket);
  });
});

// ---- Gate 2: layer / cluster grouping -------------------------------------

describe("G12 gate 2 — layer/cluster grouping", () => {
  it("2 distinct layer values → 2 groups; membership equals the field", () => {
    const nodes: Rec[] = [
      { id: "a1", type: "file", name: "a1", layer: "api" },
      { id: "a2", type: "file", name: "a2", layer: "api" },
      { id: "d1", type: "file", name: "d1", layer: "data" },
      { id: "u1", type: "file", name: "u1" }, // no layer → ungrouped
    ];
    const model = buildArchitecture(nodes, []);
    expect(model.layers.map((l) => l.label).sort()).toEqual(["api", "data"]);
    const api = model.layers.find((l) => l.label === "api")!;
    const data = model.layers.find((l) => l.label === "data")!;
    expect(api.nodes.map((n) => n.id).sort()).toEqual(["a1", "a2"]);
    expect(data.nodes.map((n) => n.id)).toEqual(["d1"]);
    // The ungrouped node appears in NO layer.
    expect(model.layers.flatMap((l) => l.nodes.map((n) => n.id))).not.toContain("u1");
  });

  it("falls back to `component` then `cluster` when `layer` is absent", () => {
    const nodes: Rec[] = [
      { id: "c1", type: "file", name: "c1", component: "billing" },
      { id: "k1", type: "file", name: "k1", cluster: "auth" },
    ];
    const model = buildArchitecture(nodes, []);
    const billing = model.layers.find((l) => l.label === "billing")!;
    const auth = model.layers.find((l) => l.label === "auth")!;
    expect(billing.field).toBe("component");
    expect(auth.field).toBe("cluster");
  });

  it("same VALUE from different FIELDS in one guild → two distinct groups (no collapse)", () => {
    // `component:"core"` and `cluster:"core"` share the value "core" but come
    // from different fields. Keying by (guild, value) alone would collapse them
    // into ONE group mislabelled by whichever field appeared first; keying by
    // (guild, FIELD, value) keeps them separate, each labelled by its own field.
    const nodes: Rec[] = [
      { id: "cmp", type: "file", name: "cmp", component: "core" },
      { id: "clu", type: "file", name: "clu", cluster: "core" },
    ];
    const model = buildArchitecture(nodes, []);
    expect(model.layers).toHaveLength(2);
    // Both labelled "core" but each carries its OWN field (no first-wins mixing).
    expect(model.layers.map((l) => l.label)).toEqual(["core", "core"]);
    expect(model.layers.map((l) => l.field).sort()).toEqual(["cluster", "component"]);
    const byField = (f: string) => model.layers.find((l) => l.field === f)!;
    expect(byField("component").nodes.map((n) => n.id)).toEqual(["cmp"]);
    expect(byField("cluster").nodes.map((n) => n.id)).toEqual(["clu"]);
    // The group keys are distinct (the two groups never share a data-layer-id).
    expect(byField("component").id).not.toBe(byField("cluster").id);
  });

  it("reversed input yields identical grouping (field-keyed determinism)", () => {
    // Reverse the ACTUAL consumed structure (graph.nodes) — a partial-key impl
    // would mis-merge or re-order; the full (guild, field, value) key does not.
    const nodes: Rec[] = [
      { id: "cmp", type: "file", name: "cmp", component: "core" },
      { id: "clu", type: "file", name: "clu", cluster: "core" },
    ];
    const shape = (m: ReturnType<typeof buildArchitecture>) =>
      m.layers.map((l) => ({ field: l.field, label: l.label, ids: l.nodes.map((n) => n.id) }));
    expect(shape(buildArchitecture(nodes, []))).toEqual(
      shape(buildArchitecture([...nodes].reverse(), [])),
    );
  });

  it("output is order-independent (shuffle-invariant layers + members)", () => {
    const nodes: Rec[] = [
      { id: "z", type: "file", name: "z", layer: "api" },
      { id: "a", type: "file", name: "a", layer: "api" },
      { id: "m", type: "file", name: "m", layer: "data" },
    ];
    const fwd = buildArchitecture(nodes, []);
    const rev = buildArchitecture([...nodes].reverse(), []);
    const shape = (m: ReturnType<typeof buildArchitecture>) =>
      m.layers.map((l) => ({ label: l.label, ids: l.nodes.map((n) => n.id) }));
    expect(shape(fwd)).toEqual(shape(rev));
    // Members sort by value desc then id (equal degree → id asc).
    expect(shape(fwd)).toEqual([
      { label: "api", ids: ["a", "z"] },
      { label: "data", ids: ["m"] },
    ]);
  });

  it("returns no layers when no node carries a layer/component/cluster field", () => {
    const nodes: Rec[] = [
      { id: "x", type: "file", name: "x" },
      { id: "y", type: "function", name: "y" },
    ];
    const model = buildArchitecture(nodes, [{ source: "x", target: "y", type: "declares" }]);
    expect(model.layers).toEqual([]);
  });
});

// ---- Gate 3: legend + degenerate (all-equal) ------------------------------

describe("G12 gate 3 — legend + degenerate scale", () => {
  it("an all-equal graph collapses to a single legend bucket (no NaN)", () => {
    // Every node has identical degree (1) and no score → degenerate scale.
    const nodes: Rec[] = [
      { id: "p", type: "file", name: "p", layer: "core" },
      { id: "q", type: "file", name: "q", layer: "core" },
    ];
    const edges: Rec[] = [{ source: "p", target: "q", type: "imports" }];
    const model = buildArchitecture(nodes, edges);
    expect(isDegenerate(model.scale)).toBe(true);
    const legend = buildImportanceLegend(model.scale);
    expect(legend).toHaveLength(1);
    // Radii are finite (no divide-by-zero), every node lands in bucket 0.
    for (const layer of model.layers) {
      for (const n of layer.nodes) {
        expect(Number.isFinite(n.radius)).toBe(true);
        expect(n.bucket).toBe(0);
      }
    }
  });

  it("non-degenerate scale produces `buckets` legend rows with monotone colours", () => {
    const scale = buildImportanceScale([0, 10]);
    const legend = buildImportanceLegend(scale);
    expect(legend).toHaveLength(scale.buckets);
    expect(legend.map((e) => e.bucket)).toEqual([0, 1, 2, 3, 4]);
    // Colours differ across buckets (the heatmap actually varies).
    expect(new Set(legend.map((e) => e.color)).size).toBe(scale.buckets);
  });

  it("importanceFraction never returns NaN on a degenerate scale", () => {
    const scale = buildImportanceScale([5, 5]);
    expect(importanceFraction(5, scale)).toBe(0);
    expect(Number.isFinite(importanceRadius(5, scale))).toBe(true);
    expect(importanceColor(0, scale.buckets)).toMatch(/^hsl\(/);
  });
});

// ---- Federation: composite (source_guild, id) keying ----------------------

describe("G12 federation — composite (source_guild,id) keying", () => {
  it("a layer value shared across guilds yields one group PER guild (no collapse)", () => {
    const nodes: Rec[] = [
      { id: "svc", type: "module", name: "Alpha Svc", layer: "core", source_guild: "alpha" },
      { id: "svc", type: "module", name: "Beta Svc", layer: "core", source_guild: "beta" },
    ];
    const model = buildArchitecture(nodes, []);
    // Raw-layer keying would collapse to ONE "core" group; composite keying → two.
    expect(model.layers).toHaveLength(2);
    expect(model.layers.map((l) => l.guild).sort()).toEqual(["alpha", "beta"]);
    const alpha = model.layers.find((l) => l.guild === "alpha")!;
    const beta = model.layers.find((l) => l.guild === "beta")!;
    expect(alpha.nodes.map((n) => n.label)).toEqual(["Alpha Svc"]);
    expect(beta.nodes.map((n) => n.label)).toEqual(["Beta Svc"]);
    // Each node's selection key carries its own guild (no cross-guild bleed).
    expect(alpha.nodes[0].key).not.toBe(beta.nodes[0].key);
  });

  it("degree-centrality is keyed per guild (same-id nodes do not share degree)", () => {
    // `svc`@alpha has 2 leaves; `svc`@beta has 0. Raw-id keying would give both 2.
    const nodes: Rec[] = [
      { id: "svc", type: "module", name: "Alpha Svc", layer: "core", source_guild: "alpha" },
      { id: "l1", type: "file", name: "l1", source_guild: "alpha" },
      { id: "l2", type: "file", name: "l2", source_guild: "alpha" },
      { id: "svc", type: "module", name: "Beta Svc", layer: "core", source_guild: "beta" },
    ];
    const edges: Rec[] = [
      { source: "svc", target: "l1", type: "imports", source_guild: "alpha" },
      { source: "svc", target: "l2", type: "imports", source_guild: "alpha" },
    ];
    const model = buildArchitecture(nodes, edges);
    const alpha = model.layers.find((l) => l.guild === "alpha")!;
    const beta = model.layers.find((l) => l.guild === "beta")!;
    expect(alpha.nodes[0].degree).toBe(2);
    expect(beta.nodes[0].degree).toBe(0);
  });
});

// ---- Component tests (REAL render + click path) ---------------------------

function apiResponse(graph: { nodes: Rec[]; edges: Rec[] }, federated = false) {
  return {
    nodes: federated ? graph.nodes : graph.nodes.map((n) => ({ source_guild: "project", ...n })),
    edges: federated ? graph.edges : graph.edges.map((e) => ({ source_guild: "project", ...e })),
    sources: federated
      ? [
          { guild: "alpha", path: "/ws/alpha/.guild/indexes/knowledge-graph.json" },
          { guild: "beta", path: "/ws/beta/.guild/indexes/knowledge-graph.json" },
        ]
      : [{ guild: "project", path: "/project/.guild/indexes/knowledge-graph.json", kind: "knowledge-graph" }],
  };
}

function mount(graph: { nodes: Rec[]; edges: Rec[] }, federated = false) {
  const handle = installMockFetch({
    override: (url) =>
      url.includes("/api/project/knowledge-graph")
        ? new Response(JSON.stringify(apiResponse(graph, federated)), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : undefined,
  });
  render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <KnowledgePage />
    </MemoryRouter>,
  );
  return handle;
}

describe("KnowledgePage — Architecture & importance view", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;
  afterEach(() => handle?.reset());

  it("renders the legend + 2 layer groups for a 2-layer graph", async () => {
    handle = mount({
      nodes: [
        { id: "a1", type: "file", name: "a1", layer: "api" },
        { id: "d1", type: "file", name: "d1", layer: "data" },
      ],
      edges: [{ source: "a1", target: "d1", type: "imports" }],
    });
    const card = await screen.findByTestId("knowledge-architecture");
    expect(within(card).getByTestId("knowledge-importance-legend")).toBeInTheDocument();
    const layers = within(card).getByTestId("knowledge-architecture-layers");
    const groups = layers.querySelectorAll("[data-layer-id]");
    expect(groups).toHaveLength(2);
    expect(
      Array.from(groups).map((g) => g.getAttribute("data-layer")).sort(),
    ).toEqual(["api", "data"]);
  });

  it("encodes the bigger-degree node with a strictly larger rendered radius", async () => {
    handle = mount(
      merge(hubWithDegree("hub20", 20, "core"), hubWithDegree("hub2", 2, "core")),
    );
    const card = await screen.findByTestId("knowledge-architecture");
    const big = card.querySelector('[data-node-id="hub20"]')!;
    const small = card.querySelector('[data-node-id="hub2"]')!;
    const rBig = Number(big.getAttribute("data-radius"));
    const rSmall = Number(small.getAttribute("data-radius"));
    expect(rBig).toBeGreaterThan(rSmall);
    expect(Number(big.getAttribute("data-importance-bucket"))).toBeGreaterThan(
      Number(small.getAttribute("data-importance-bucket")),
    );
    // The rendered <circle r> matches the encoded radius (no eyeball).
    const circle = big.querySelector("circle")!;
    expect(Number(circle.getAttribute("r"))).toBeCloseTo(rBig, 1);
  });

  it("shows the empty-state when no node carries a layer field (no crash)", async () => {
    handle = mount({
      nodes: [
        { id: "x", type: "file", name: "x" },
        { id: "y", type: "function", name: "y" },
      ],
      edges: [{ source: "x", target: "y", type: "declares" }],
    });
    const card = await screen.findByTestId("knowledge-architecture");
    expect(within(card).getByTestId("knowledge-architecture-empty")).toBeInTheDocument();
    // Legend still renders (the scale exists even with no layers).
    expect(within(card).getByTestId("knowledge-importance-legend")).toBeInTheDocument();
    expect(within(card).queryByTestId("knowledge-architecture-layers")).toBeNull();
  });

  it("a degenerate (all-equal) graph renders one legend bucket", async () => {
    handle = mount({
      nodes: [
        { id: "p", type: "file", name: "p", layer: "core" },
        { id: "q", type: "file", name: "q", layer: "core" },
      ],
      edges: [{ source: "p", target: "q", type: "imports" }],
    });
    const legend = await screen.findByTestId("knowledge-importance-legend");
    expect(legend.getAttribute("data-degenerate")).toBe("true");
    expect(legend.querySelectorAll("[data-bucket]")).toHaveLength(1);
  });

  it("clicking an architecture node selects it (cross-link to the selection panel)", async () => {
    handle = mount({
      nodes: [
        { id: "svc", type: "module", name: "PaymentService", layer: "core" },
        { id: "leaf", type: "file", name: "leaf" },
      ],
      edges: [{ source: "svc", target: "leaf", type: "imports" }],
    });
    const card = await screen.findByTestId("knowledge-architecture");
    const btn = within(card).getByText("PaymentService").closest("button")!;
    await userEvent.setup().click(btn);
    await waitFor(() => expect(btn).toHaveAttribute("aria-pressed", "true"));
    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(within(selected).getByText("PaymentService")).toBeInTheDocument();
  });

  it("federated: clicking the alpha same-id node selects ALPHA, not beta", async () => {
    handle = mount(
      {
        nodes: [
          { id: "svc", type: "module", name: "Alpha Svc", layer: "core", source_guild: "alpha" },
          { id: "svc", type: "module", name: "Beta Svc", layer: "core", source_guild: "beta" },
        ],
        edges: [],
      },
      true,
    );
    const card = await screen.findByTestId("knowledge-architecture");
    const alphaGroup = card.querySelector('[data-guild="alpha"]')!;
    const alphaBtn = within(alphaGroup as HTMLElement).getByText("Alpha Svc").closest("button")!;
    await userEvent.setup().click(alphaBtn);
    await waitFor(() => expect(alphaBtn).toHaveAttribute("aria-pressed", "true"));
    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(within(selected).getByText("Alpha Svc")).toBeInTheDocument();
    expect(within(selected).queryByText("Beta Svc")).toBeNull();
  });
});
