// domains-view.test.tsx — G11 validation gate
//
// Covers the LANE G11 gate for the Domains & Flows view:
//   1. buildDomainFlows groups 2 domains × 3 flows with ordered steps, and the
//      step order follows the `flow_step` edge `weight` — NOT the input edge
//      order (anti-vacuity: shuffling the edges leaves the output unchanged).
//   2. A graph with no domain nodes → helper returns [] and the view renders
//      its empty-state without throwing.
//   3. Cross-link: clicking a flow step sets the shared selected-node id so the
//      existing selection panel reflects the chosen node.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import KnowledgePage, { buildDomainFlows } from "../KnowledgePage";
import { installMockFetch } from "../../__tests__/fixtures/mockFetch";

type Rec = Record<string, unknown>;

// A graph with 2 domains, each owning 3 flows, each flow having 3 ordered steps.
// flow_step edges carry a `weight` that encodes order; we deliberately push the
// edges in a SHUFFLED order so a vacuous "preserve input order" impl would fail.
function buildFixture(): { nodes: Rec[]; edges: Rec[] } {
  const nodes: Rec[] = [];
  const edges: Rec[] = [];

  for (let d = 1; d <= 2; d++) {
    const domainId = `domain:d${d}`;
    nodes.push({ id: domainId, type: "domain", name: `Domain ${d}` });
    for (let f = 1; f <= 3; f++) {
      const flowId = `flow:d${d}f${f}`;
      nodes.push({ id: flowId, type: "flow", name: `Flow ${d}.${f}` });
      edges.push({ source: domainId, target: flowId, type: "contains_flow" });
      for (let s = 1; s <= 3; s++) {
        const stepId = `step:d${d}f${f}s${s}`;
        nodes.push({ id: stepId, type: "step", name: `Step ${d}.${f}.${s}` });
        // weight encodes the intended order (s=1 → 0.1, s=2 → 0.2, s=3 → 0.3)
        edges.push({
          source: flowId,
          target: stepId,
          type: "flow_step",
          weight: s / 10,
        });
      }
    }
  }
  return { nodes, edges };
}

// Deterministic shuffle (index-based, no Math.random) so the input edge order
// differs from the desired output order.
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7 + 3) % out.length;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function stepLabels(group: ReturnType<typeof buildDomainFlows>[number], flowIdx: number): string[] {
  return group.flows[flowIdx].steps.map((s) => s.label);
}

describe("buildDomainFlows — G11 gate 1 (grouping + ordering)", () => {
  it("groups 2 domains × 3 flows with steps in the correct order", () => {
    const { nodes, edges } = buildFixture();
    const groups = buildDomainFlows(nodes, edges);

    // 2 domain groups.
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.label)).toEqual(["Domain 1", "Domain 2"]);

    // 3 flows under each domain.
    for (const g of groups) {
      expect(g.flows).toHaveLength(3);
    }

    // Steps in weight order under the first flow of domain 1.
    expect(stepLabels(groups[0], 0)).toEqual([
      "Step 1.1.1",
      "Step 1.1.2",
      "Step 1.1.3",
    ]);
    // And under a flow of domain 2.
    expect(stepLabels(groups[1], 2)).toEqual([
      "Step 2.3.1",
      "Step 2.3.2",
      "Step 2.3.3",
    ]);
  });

  it("orders steps by flow_step weight, NOT input edge order (anti-vacuity)", () => {
    const { nodes, edges } = buildFixture();
    const baseline = buildDomainFlows(nodes, edges);

    // Shuffle both node and edge order; the weight-based ordering must hold.
    const shuffled = buildDomainFlows(shuffle(nodes), shuffle(edges));

    // Every flow's step order is identical to the unshuffled baseline.
    for (let d = 0; d < baseline.length; d++) {
      const bDomain = baseline[d];
      const sDomain = shuffled.find((g) => g.id === bDomain.id);
      expect(sDomain).toBeDefined();
      if (!sDomain) continue;
      for (const bFlow of bDomain.flows) {
        const sFlow = sDomain.flows.find((f) => f.id === bFlow.id);
        expect(sFlow).toBeDefined();
        if (!sFlow) continue;
        expect(sFlow.steps.map((s) => s.id)).toEqual(bFlow.steps.map((s) => s.id));
        // Weights strictly ascending → real ordering, not coincidence.
        const weights = sFlow.steps.map((s) => s.weight);
        const sortedWeights = [...weights].sort((a, b) => a - b);
        expect(weights).toEqual(sortedWeights);
      }
    }
  });

  it("is lenient: missing fields and a flow with no steps do not throw", () => {
    const nodes: Rec[] = [
      { id: "domain:x", type: "domain" }, // no name
      { id: "flow:x", type: "flow", name: "Flow X" },
    ];
    const edges: Rec[] = [
      { source: "domain:x", target: "flow:x", type: "contains_flow" },
      { type: "flow_step" }, // junk edge, no source/target
    ];
    const groups = buildDomainFlows(nodes, edges);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("domain:x"); // falls back to id
    expect(groups[0].flows[0].steps).toEqual([]);
  });
});

describe("buildDomainFlows — G11 gate 2 (no domains → empty)", () => {
  it("returns [] when the graph has no domain nodes", () => {
    const nodes: Rec[] = [
      { id: "src/server.ts", type: "file", name: "server.ts" },
      { id: "createApp", type: "function", name: "createApp" },
    ];
    const edges: Rec[] = [
      { source: "src/server.ts", target: "createApp", type: "declares" },
    ];
    expect(buildDomainFlows(nodes, edges)).toEqual([]);
  });
});

// ---- Component tests -------------------------------------------------------

function apiResponse(graph: { nodes: Rec[]; edges: Rec[] }) {
  return {
    nodes: graph.nodes.map((n) => ({ ...n, source_guild: "project" })),
    edges: graph.edges.map((e) => ({ ...e, source_guild: "project" })),
    sources: [
      {
        guild: "project",
        path: "/project/.guild/indexes/knowledge-graph.json",
        kind: "knowledge-graph",
      },
    ],
  };
}

function mount(graph: { nodes: Rec[]; edges: Rec[] }) {
  const handle = installMockFetch({
    override: (url) => {
      if (!url.includes("/api/project/knowledge-graph")) return undefined;
      return new Response(JSON.stringify(apiResponse(graph)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <KnowledgePage />
    </MemoryRouter>,
  );
  return handle;
}

describe("KnowledgePage — Domains & Flows view", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("G11 gate 2: renders the empty-state when the graph has no domains (no throw)", async () => {
    handle = mount({
      nodes: [
        { id: "src/server.ts", type: "file", name: "server.ts" },
        { id: "createApp", type: "function", name: "createApp" },
      ],
      edges: [{ source: "src/server.ts", target: "createApp", type: "declares" }],
    });
    const panel = await screen.findByTestId("knowledge-domains-flows");
    expect(within(panel).getByTestId("knowledge-domains-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("knowledge-domain-flows-list")).toBeNull();
  });

  it("renders domains → flows → ordered steps", async () => {
    handle = mount(buildFixture());
    const list = await screen.findByTestId("knowledge-domain-flows-list");
    // Both domains present.
    expect(within(list).getByText("Domain 1")).toBeInTheDocument();
    expect(within(list).getByText("Domain 2")).toBeInTheDocument();
    // Steps under domain 1 / flow 1 render in order in a single <ol>.
    const flow = list.querySelector('[data-flow-id="flow:d1f1"]');
    expect(flow).not.toBeNull();
    const stepIds = Array.from(
      flow!.querySelectorAll<HTMLElement>("li[data-step-id]"),
    ).map((li) => li.getAttribute("data-step-id"));
    expect(stepIds).toEqual(["step:d1f1s1", "step:d1f1s2", "step:d1f1s3"]);
  });

  it("renders per-level empty-states for a domain with no flows and a flow with no steps", async () => {
    handle = mount({
      nodes: [
        { id: "domain:empty", type: "domain", name: "Empty Domain" },
        { id: "domain:withflow", type: "domain", name: "Flowy Domain" },
        { id: "flow:nosteps", type: "flow", name: "Stepless Flow" },
      ],
      edges: [
        { source: "domain:withflow", target: "flow:nosteps", type: "contains_flow" },
      ],
    });
    const list = await screen.findByTestId("knowledge-domain-flows-list");
    expect(within(list).getByText("No business flows in this domain.")).toBeInTheDocument();
    expect(within(list).getByText("No steps recorded for this flow.")).toBeInTheDocument();
  });

  it("G11 gate 3: clicking a flow step selects the shared node id", async () => {
    handle = mount(buildFixture());
    const list = await screen.findByTestId("knowledge-domain-flows-list");
    const stepButton = within(list).getByText("Step 1.2.2");

    const user = userEvent.setup();
    await user.click(stepButton);

    // The step button reflects the shared selection state…
    await waitFor(() => expect(stepButton.closest("button")).toHaveAttribute("aria-pressed", "true"));

    // …and the existing selection panel now shows the chosen node.
    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(within(selected).getByText("Step 1.2.2")).toBeInTheDocument();
  });
});
