// graph-layout.test.tsx — G13 validation gate (pure force-layout logic).
//
// Gate items:
//   1. Overlap metric: force layout on a 200-node fixture is BELOW the fixed
//      threshold; the SAME metric on the OLD ring layout EXCEEDS it (anti-vacuity).
//   2. Interaction is testable: pan/zoom transform reducers change state; a
//      node-drag updates that node's position and pins it (and the pin holds
//      through a simulation step).
//   3. Cross-guild: node colour is a pure function of source_guild, and the two
//      guilds settle into disjoint x-lanes (separated mean-x).

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import KnowledgePage from "../KnowledgePage";
import { installMockFetch } from "../../__tests__/fixtures/mockFetch";
import {
  runForceLayout,
  legacyRingLayout,
  overlapRatio,
  seedPositions,
  stepSimulation,
  assignGuildLanes,
  guildColor,
  pinNode,
  panTransform,
  zoomTransform,
  screenToWorld,
  IDENTITY_TRANSFORM,
  DEFAULT_LAYOUT_OPTIONS,
  type LayoutInputNode,
  type LayoutInputEdge,
} from "../forceLayout";

// ---- Shared 200-node, 2-guild fixture -------------------------------------

const GATE_RADIUS = 24; // node footprint radius used by the overlap metric
const OVERLAP_THRESHOLD = 0.02; // 2% of node pairs (lane gate)

function makeFixture(n = 200): { nodes: LayoutInputNode[]; edges: LayoutInputEdge[] } {
  const guilds = ["alpha", "beta"];
  const nodes: LayoutInputNode[] = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    guild: guilds[i % 2],
  }));
  const edges: LayoutInputEdge[] = [];
  // A spanning-ish chain + some cross links so the spring force has work to do.
  for (let i = 1; i < n; i++) {
    edges.push({ source: `n${i}`, target: `n${Math.max(0, i - 1 - (i % 5))}` });
  }
  for (let i = 0; i < Math.floor(n * 0.4); i++) {
    edges.push({ source: `n${(i * 3) % n}`, target: `n${(i * 7 + 5) % n}` });
  }
  return { nodes, edges };
}

describe("G13 gate 1 — overlap metric (force good, ring bad)", () => {
  const { nodes, edges } = makeFixture(200);

  it("force layout converges below the overlap threshold on 200 nodes", () => {
    const laid = runForceLayout(nodes, edges);
    const ratio = overlapRatio(laid, GATE_RADIUS);
    expect(ratio).toBeLessThan(OVERLAP_THRESHOLD);
  });

  it("anti-vacuity: the OLD ring layout EXCEEDS the threshold on the same 200 nodes", () => {
    const ring = legacyRingLayout(nodes);
    const ratio = overlapRatio(ring, GATE_RADIUS);
    expect(ratio).toBeGreaterThan(OVERLAP_THRESHOLD);
  });

  it("the metric actually distinguishes the two (force strictly better than ring)", () => {
    const force = overlapRatio(runForceLayout(nodes, edges), GATE_RADIUS);
    const ring = overlapRatio(legacyRingLayout(nodes), GATE_RADIUS);
    expect(force).toBeLessThan(ring);
  });

  it("is deterministic — identical input yields identical layout", () => {
    const a = runForceLayout(nodes, edges);
    const b = runForceLayout(nodes, edges);
    expect(a.map((n) => [Math.round(n.x), Math.round(n.y)])).toEqual(
      b.map((n) => [Math.round(n.x), Math.round(n.y)]),
    );
  });

  it("overlapRatio handles <2 nodes without divide-by-zero", () => {
    expect(overlapRatio([], 10)).toBe(0);
    expect(overlapRatio([{ x: 1, y: 1 }], 10)).toBe(0);
  });
});

describe("G13 gate 2 — interaction reducers are testable", () => {
  it("pan updates the transform translation", () => {
    const t = panTransform(IDENTITY_TRANSFORM, 40, -25);
    expect(t).toEqual({ x: 40, y: -25, k: 1 });
  });

  it("zoom changes scale and keeps the anchor point fixed in world space", () => {
    const before = screenToWorld(IDENTITY_TRANSFORM, 300, 200);
    const zoomed = zoomTransform(IDENTITY_TRANSFORM, 2, 300, 200);
    expect(zoomed.k).toBe(2);
    const after = screenToWorld(zoomed, 300, 200);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("zoom clamps scale to the configured bounds", () => {
    expect(zoomTransform(IDENTITY_TRANSFORM, 100, 0, 0).k).toBe(4); // maxK
    expect(zoomTransform(IDENTITY_TRANSFORM, 0.0001, 0, 0).k).toBe(0.2); // minK
  });

  it("node-drag updates that node's position and pins it", () => {
    const { nodes, edges } = makeFixture(12);
    const laid = seedPositions(nodes, DEFAULT_LAYOUT_OPTIONS);
    const target = laid[3].id;

    const dragged = pinNode(laid, target, 123, 456);
    const node = dragged.find((n) => n.id === target)!;
    expect(node.x).toBe(123);
    expect(node.y).toBe(456);
    expect(node.pinned).toBe(true);

    // The pin must hold through a simulation step (pinned node does not move,
    // while at least one un-pinned node does).
    const before = dragged.map((n) => ({ id: n.id, x: n.x, y: n.y }));
    const lanes = assignGuildLanes(nodes.map((n) => n.guild ?? ""), DEFAULT_LAYOUT_OPTIONS.width);
    stepSimulation(dragged, edges, lanes, DEFAULT_LAYOUT_OPTIONS, 1);
    const pinnedAfter = dragged.find((n) => n.id === target)!;
    expect(pinnedAfter.x).toBe(123);
    expect(pinnedAfter.y).toBe(456);
    const someMoved = dragged.some((n) => {
      const b = before.find((p) => p.id === n.id)!;
      return n.id !== target && (n.x !== b.x || n.y !== b.y);
    });
    expect(someMoved).toBe(true);
  });
});

describe("G13 gate 3 — cross-guild colour + lane separation", () => {
  it("node colour is a pure function of source_guild", () => {
    expect(guildColor("alpha")).toBe(guildColor("alpha"));
    expect(guildColor("beta")).toBe(guildColor("beta"));
    expect(guildColor("alpha")).not.toBe(guildColor("beta"));
    // Empty guild is stable too (maps like "project").
    expect(guildColor("")).toBe(guildColor("project"));
  });

  it("assignGuildLanes maps distinct guilds to evenly spaced, sorted lanes", () => {
    const lanes = assignGuildLanes(["beta", "alpha", "alpha"], 1200);
    expect([...lanes.keys()]).toEqual(["alpha", "beta"]); // sorted
    expect(lanes.get("alpha")).toBe(400);
    expect(lanes.get("beta")).toBe(800);
  });

  it("a single guild lands in the middle lane", () => {
    const lanes = assignGuildLanes(["solo", "solo"], 1000);
    expect(lanes.get("solo")).toBe(500);
  });

  it("two guilds settle into disjoint x-lanes (separated mean-x)", () => {
    const { nodes, edges } = makeFixture(200);
    const laid = runForceLayout(nodes, edges);
    const xs: Record<string, number[]> = { alpha: [], beta: [] };
    for (const n of laid) xs[n.guild].push(n.x);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mAlpha = mean(xs.alpha);
    const mBeta = mean(xs.beta);
    // Lanes are at 400 / 800; means must land on opposite sides of centre and
    // be clearly separated (disjoint regions).
    expect(mBeta - mAlpha).toBeGreaterThan(200);
    expect(mAlpha).toBeLessThan(DEFAULT_LAYOUT_OPTIONS.width / 2);
    expect(mBeta).toBeGreaterThan(DEFAULT_LAYOUT_OPTIONS.width / 2);
  });

  it("colours every guild in a fixture deterministically", () => {
    const { nodes } = makeFixture(20);
    const colors = new Map(nodes.map((n) => [n.guild!, guildColor(n.guild!)]));
    for (const n of nodes) {
      expect(guildColor(n.guild!)).toBe(colors.get(n.guild!));
    }
  });
});

// ---- Component-level canvas wiring (legend, colour, interaction) -----------

function workspaceGraph(n: number) {
  const guilds = ["alpha", "beta"];
  return {
    nodes: Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      type: i % 4 === 0 ? "module" : "file",
      name: `node ${i}`,
      source_guild: guilds[i % 2],
    })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({
      source: `n${i + 1}`,
      target: `n${i}`,
      type: "uses",
      source_guild: guilds[i % 2],
    })),
    sources: [
      { guild: "alpha", path: "/ws/alpha/.guild/indexes/knowledge-graph.json" },
      { guild: "beta", path: "/ws/beta/.guild/indexes/knowledge-graph.json" },
    ],
  };
}

function mount(graph: unknown) {
  const handle = installMockFetch({
    override: (url) =>
      url.includes("/api/project/knowledge-graph")
        ? new Response(JSON.stringify(graph), {
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

describe("KnowledgePage canvas — G13 wiring", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;
  afterEach(() => handle?.reset());

  it("renders the guild legend and colours nodes by source_guild in workspace mode", async () => {
    handle = mount(workspaceGraph(20)); // > SMALL_GRAPH_MAX → force layout path
    const legend = await screen.findByTestId("knowledge-graph-legend");
    expect(within(legend).getByText("alpha")).toBeInTheDocument();
    expect(within(legend).getByText("beta")).toBeInTheDocument();

    // Every node circle is filled with its guild's deterministic colour.
    const canvas = screen.getByTestId("knowledge-graph-canvas");
    const alphaNode = canvas.querySelector('g[data-guild="alpha"] circle');
    const betaNode = canvas.querySelector('g[data-guild="beta"] circle');
    expect(alphaNode?.getAttribute("fill")).toBe(guildColor("alpha"));
    expect(betaNode?.getAttribute("fill")).toBe(guildColor("beta"));
  });

  it("wheel zoom, pan and node drag update the canvas without throwing", async () => {
    handle = mount(workspaceGraph(20));
    const canvas = await screen.findByTestId("knowledge-graph-canvas");

    // Wheel zoom in, then background pan.
    fireEvent.wheel(canvas, { deltaY: -120, clientX: 200, clientY: 150 });
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { clientX: 160, clientY: 130 });
    fireEvent.pointerUp(canvas, { clientX: 160, clientY: 130 });

    // Drag a node (pointer down on the node, move, up) — should not throw and
    // keeps the canvas mounted.
    const node = canvas.querySelector('g[data-guild="alpha"]')!;
    fireEvent.pointerDown(node, { clientX: 120, clientY: 120 });
    fireEvent.pointerMove(canvas, { clientX: 220, clientY: 220 });
    fireEvent.pointerUp(node, { clientX: 220, clientY: 220 });

    expect(screen.getByTestId("knowledge-graph-canvas")).toBeInTheDocument();

    // Reset view button is present and clickable.
    fireEvent.click(screen.getByTestId("knowledge-graph-reset"));
    expect(screen.getByTestId("knowledge-graph-canvas")).toBeInTheDocument();
  });

  it("tiny graphs use the static fallback (no force) and still render", async () => {
    handle = mount(workspaceGraph(3)); // <= SMALL_GRAPH_MAX
    const canvas = await screen.findByTestId("knowledge-graph-canvas");
    expect(canvas.getAttribute("viewBox")).toBe("0 0 920 560");
    // Footer notes the static layout.
    expect(screen.getByText(/static layout/i)).toBeInTheDocument();
  });

  it("clicking a node selects it (cross-link preserved)", async () => {
    handle = mount(workspaceGraph(20));
    const canvas = await screen.findByTestId("knowledge-graph-canvas");
    const node = canvas.querySelector('g[data-guild="beta"]')!;
    fireEvent.click(node);
    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(selected).toBeInTheDocument();
  });
});
