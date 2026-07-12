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
// CRUCIAL (FIX-G11): domains/flows/steps are pushed in a deliberately REVERSED
// (non-sorted) order, and step weights are inserted out of order — so any impl
// that preserves input order produces the WRONG full output. A correct impl
// sorts domains+flows by stable key and steps by weight.
function buildFixture(): { nodes: Rec[]; edges: Rec[] } {
  const nodes: Rec[] = [];
  const edges: Rec[] = [];

  for (let d = 2; d >= 1; d--) {
    const domainId = `domain:d${d}`;
    nodes.push({ id: domainId, type: "domain", name: `Domain ${d}` });
    for (let f = 3; f >= 1; f--) {
      const flowId = `flow:d${d}f${f}`;
      nodes.push({ id: flowId, type: "flow", name: `Flow ${d}.${f}` });
      edges.push({ source: domainId, target: flowId, type: "contains_flow" });
      for (let s = 3; s >= 1; s--) {
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

// Deterministic shuffle (index-based, no Math.random) so the input order
// differs from the desired output order.
function shuffle<T>(seed: number, arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * seed + 3) % out.length;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Collapse the full output into a comparable plain structure (domain → flow →
// step ids, in order) so we can assert the ENTIRE ordered output, not just steps.
function structure(groups: ReturnType<typeof buildDomainFlows>) {
  return groups.map((d) => ({
    id: d.id,
    guild: d.guild,
    flows: d.flows.map((f) => ({ id: f.id, steps: f.steps.map((s) => s.id) })),
  }));
}

function stepLabels(group: ReturnType<typeof buildDomainFlows>[number], flowIdx: number): string[] {
  return group.flows[flowIdx].steps.map((s) => s.label);
}

// The canonical (sorted) output the helper must always produce, regardless of
// input order.
const CANONICAL = [
  {
    id: "domain:d1",
    guild: "",
    flows: [
      { id: "flow:d1f1", steps: ["step:d1f1s1", "step:d1f1s2", "step:d1f1s3"] },
      { id: "flow:d1f2", steps: ["step:d1f2s1", "step:d1f2s2", "step:d1f2s3"] },
      { id: "flow:d1f3", steps: ["step:d1f3s1", "step:d1f3s2", "step:d1f3s3"] },
    ],
  },
  {
    id: "domain:d2",
    guild: "",
    flows: [
      { id: "flow:d2f1", steps: ["step:d2f1s1", "step:d2f1s2", "step:d2f1s3"] },
      { id: "flow:d2f2", steps: ["step:d2f2s1", "step:d2f2s2", "step:d2f2s3"] },
      { id: "flow:d2f3", steps: ["step:d2f3s1", "step:d2f3s2", "step:d2f3s3"] },
    ],
  },
];

describe("buildDomainFlows — G11 gate 1 (grouping + ordering)", () => {
  it("groups 2 domains × 3 flows with steps in the correct order", () => {
    const { nodes, edges } = buildFixture();
    const groups = buildDomainFlows(nodes, edges);

    // 2 domain groups, sorted by id even though input is reversed.
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
    expect(stepLabels(groups[1], 2)).toEqual([
      "Step 2.3.1",
      "Step 2.3.2",
      "Step 2.3.3",
    ]);
  });

  it("FULL output is shuffle-invariant — domains, flows AND steps (anti-vacuity)", () => {
    const { nodes, edges } = buildFixture();

    // The unshuffled (already-reversed-input) output must equal the canonical
    // sorted structure. An input-order impl would FAIL here because the fixture
    // input is reversed.
    expect(structure(buildDomainFlows(nodes, edges))).toEqual(CANONICAL);

    // Two independent shuffles of BOTH nodes and edges must produce byte-equal
    // full output — proving order is content-derived, not input-derived.
    const a = structure(buildDomainFlows(shuffle(7, nodes), shuffle(13, edges)));
    const b = structure(buildDomainFlows(shuffle(31, nodes), shuffle(5, edges)));
    expect(a).toEqual(CANONICAL);
    expect(b).toEqual(CANONICAL);
    expect(a).toEqual(b);
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

describe("buildDomainFlows — FIX-G11 federated (source_guild,id) keying", () => {
  it("keeps same-id domains from different guilds as separate groups (anti-vacuity vs raw-id keying)", () => {
    // Two guilds each carry an identically-named `domain:x` / `flow:y` / `step:z`.
    // Raw-id keying would collapse them into ONE group; composite keying keeps two.
    const nodes: Rec[] = [
      { id: "domain:x", type: "domain", name: "Alpha Domain", source_guild: "alpha" },
      { id: "flow:y", type: "flow", name: "Alpha Flow", source_guild: "alpha" },
      { id: "step:z", type: "step", name: "Alpha Step", source_guild: "alpha" },
      { id: "domain:x", type: "domain", name: "Beta Domain", source_guild: "beta" },
      { id: "flow:y", type: "flow", name: "Beta Flow", source_guild: "beta" },
      { id: "step:z", type: "step", name: "Beta Step", source_guild: "beta" },
    ];
    const edges: Rec[] = [
      { source: "domain:x", target: "flow:y", type: "contains_flow", source_guild: "alpha" },
      { source: "flow:y", target: "step:z", type: "flow_step", weight: 0.1, source_guild: "alpha" },
      { source: "domain:x", target: "flow:y", type: "contains_flow", source_guild: "beta" },
      { source: "flow:y", target: "step:z", type: "flow_step", weight: 0.1, source_guild: "beta" },
    ];

    const groups = buildDomainFlows(nodes, edges);

    // TWO distinct domain groups (would be ONE under raw-id keying).
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.guild).sort()).toEqual(["alpha", "beta"]);

    // Each group resolved its OWN guild's flow + step (no cross-guild bleed).
    const alpha = groups.find((g) => g.guild === "alpha")!;
    const beta = groups.find((g) => g.guild === "beta")!;
    expect(alpha.label).toBe("Alpha Domain");
    expect(alpha.flows).toHaveLength(1);
    expect(alpha.flows[0].label).toBe("Alpha Flow");
    expect(alpha.flows[0].steps.map((s) => s.label)).toEqual(["Alpha Step"]);
    expect(beta.label).toBe("Beta Domain");
    expect(beta.flows[0].label).toBe("Beta Flow");
    expect(beta.flows[0].steps.map((s) => s.label)).toEqual(["Beta Step"]);
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

// FIX round-2 #3 — REAL-PATH federated selection. These render the page and
// CLICK (domains step, node-list, canvas node) with duplicate (guild,id) across
// two guilds. Anti-vacuity: under raw-id selection the last-inserted (beta) node
// wins, so clicking alpha would surface beta — these assertions then fail.

// A federated mount that preserves each node/edge's own source_guild (the shared
// `mount` above stamps everything "project").
function mountFederated(graph: { nodes: Rec[]; edges: Rec[] }) {
  const handle = installMockFetch({
    override: (url) =>
      url.includes("/api/project/knowledge-graph")
        ? new Response(
            JSON.stringify({
              nodes: graph.nodes,
              edges: graph.edges,
              sources: [
                { guild: "alpha", path: "/ws/alpha/.guild/indexes/knowledge-graph.json" },
                { guild: "beta", path: "/ws/beta/.guild/indexes/knowledge-graph.json" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : undefined,
  });
  render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <KnowledgePage />
    </MemoryRouter>,
  );
  return handle;
}

// Two guilds, each with an identically-named domain:x → flow:y → step:z.
function federatedDomainsGraph(): { nodes: Rec[]; edges: Rec[] } {
  const nodes: Rec[] = [];
  const edges: Rec[] = [];
  for (const guild of ["alpha", "beta"]) {
    const Cap = guild[0].toUpperCase() + guild.slice(1);
    nodes.push({ id: "domain:x", type: "domain", name: `${Cap} Domain`, source_guild: guild });
    nodes.push({ id: "flow:y", type: "flow", name: `${Cap} Flow`, source_guild: guild });
    nodes.push({ id: "step:z", type: "step", name: `${Cap} Step`, source_guild: guild });
    edges.push({ source: "domain:x", target: "flow:y", type: "contains_flow", source_guild: guild });
    edges.push({ source: "flow:y", target: "step:z", type: "flow_step", weight: 0.1, source_guild: guild });
  }
  return { nodes, edges };
}

describe("KnowledgePage — FIX round-2 federated selection (real path)", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;
  afterEach(() => handle?.reset());

  it("clicking the alpha domain step selects ALPHA's step, not beta's", async () => {
    handle = mountFederated(federatedDomainsGraph());
    const list = await screen.findByTestId("knowledge-domain-flows-list");

    const alphaGroup = list.querySelector('[data-guild="alpha"]')!;
    const betaGroup = list.querySelector('[data-guild="beta"]')!;
    const alphaStepBtn = within(alphaGroup as HTMLElement).getByText("Alpha Step").closest("button")!;
    const betaStepBtn = within(betaGroup as HTMLElement).getByText("Beta Step").closest("button")!;

    await userEvent.setup().click(alphaStepBtn);

    // Only the alpha step button is pressed.
    await waitFor(() => expect(alphaStepBtn).toHaveAttribute("aria-pressed", "true"));
    expect(betaStepBtn).toHaveAttribute("aria-pressed", "false");

    // The selection panel resolved ALPHA's node, not beta's (raw-id keying would
    // surface "Beta Step" because it was inserted last).
    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(within(selected).getByText("Alpha Step")).toBeInTheDocument();
    expect(within(selected).queryByText("Beta Step")).toBeNull();
  });

  it("clicking the alpha node in the node-list selects ALPHA, not the same-id beta node", async () => {
    handle = mountFederated({
      nodes: [
        { id: "dup", type: "file", name: "Alpha Dup", source_guild: "alpha" },
        { id: "dup", type: "file", name: "Beta Dup", source_guild: "beta" },
      ],
      edges: [],
    });
    const nodeList = await screen.findByTestId("knowledge-node-list");
    const alphaBtn = within(nodeList).getByText("Alpha Dup").closest("button")!;
    const betaBtn = within(nodeList).getByText("Beta Dup").closest("button")!;

    await userEvent.setup().click(alphaBtn);

    await waitFor(() => expect(alphaBtn).toHaveAttribute("aria-pressed", "true"));
    expect(betaBtn).toHaveAttribute("aria-pressed", "false");
    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(within(selected).getByText("Alpha Dup")).toBeInTheDocument();
    expect(within(selected).queryByText("Beta Dup")).toBeNull();
  });

  it("clicking a same-id canvas node selects the right guild's node", async () => {
    handle = mountFederated({
      nodes: [
        { id: "dup", type: "file", name: "Alpha Dup", source_guild: "alpha" },
        { id: "dup", type: "file", name: "Beta Dup", source_guild: "beta" },
      ],
      edges: [],
    });
    const canvas = await screen.findByTestId("knowledge-graph-canvas");
    // Canvas g nodes carry aria-label `${label}, ${type}` → target alpha precisely.
    const alphaNode = within(canvas).getByLabelText("Alpha Dup, file");
    await userEvent.setup().click(alphaNode);

    const selected = await screen.findByTestId("knowledge-selected-node");
    expect(within(selected).getByText("Alpha Dup")).toBeInTheDocument();
    expect(within(selected).queryByText("Beta Dup")).toBeNull();
  });
});
