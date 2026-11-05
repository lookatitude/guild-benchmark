import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeGenerationSource, KnowledgeGenerationView, KnowledgeGenerationsResponse } from "../../../src/types";
import FreshnessPage from "../routes/FreshnessPage";
import { installMockFetch, type MockFetchHandle } from "./fixtures/mockFetch";

// AT42 — P07 generation and freshness view. Values come only from the reader;
// missing stays missing, unknown shows as unknown, empty stays empty.
const URL = "/api/project/knowledge-generations";
const h = (c: string) => `sha256:${c.repeat(64)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let handle: MockFetchHandle | undefined;
function mount(body: unknown, status = 200) {
  handle = installMockFetch({ override: (u) => (u === URL ? json(body, status) : undefined) });
  render(
    <MemoryRouter>
      <FreshnessPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  handle?.reset();
});

function gen(over: Partial<KnowledgeGenerationView>): KnowledgeGenerationView {
  return {
    generation: h("1"),
    status: "verified",
    reason: null,
    previous_generation: null,
    source_id: "source-a",
    source_worktree_id: "lane-a",
    durable_owner_source_id: "source-a",
    publication_scope_source_id: "source-a",
    basis_commit: "abc",
    basis_tree: h("a"),
    source_basis_hash: h("b"),
    basis_verified_at: "2026-10-26T00:00:00Z",
    channels: [],
    unpublished_channels: [],
    decision_refs: [],
    replan_required: [],
    ...over,
  };
}

function source(over: Partial<KnowledgeGenerationSource>): KnowledgeGenerationsResponse {
  return {
    sources: [
      { source_guild: "project", status: "published", reason: null, tip: h("1"), generations: [], history_truncated: false, candidates: null, ...over },
    ],
  };
}

const channel = (name: string, state: string, reason: string | null, observed: string | null = "2026-10-26T00:00:00Z") => ({
  channel: name,
  state,
  reason,
  basis_hash: h("b"),
  layer_hash: h("c"),
  basis_matches: true,
  observed_at: observed,
  output_path: observed ? "runs/x/evidence.json" : null,
  output_availability: observed ? "available" : null,
});

describe("AT42 FreshnessPage", () => {
  it("empty: no publication shows the reader's reason and no channel table", async () => {
    mount(source({ status: "none", tip: null, reason: "no knowledge publication under .guild/indexes/publication" }));
    expect(await screen.findByText(/no knowledge publication under/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /channels/i })).toBeNull();
    expect(screen.getByText("No candidate manifest.")).toBeInTheDocument();
  });

  it("unknown: state and cause show as unknown; a null time renders unknown, not a date or zero", async () => {
    mount(
      source({
        generations: [
          gen({
            basis_verified_at: null,
            channels: [channel("semantic_graph", "unknown", "wiki inputs are not bound", null) as never],
            unpublished_channels: ["structural_graph", "recall", "wiki", "project_memory"],
          }),
        ],
      }),
    );
    const table = await screen.findByRole("table", { name: /channels/i });
    const row = within(table).getByRole("row", { name: /semantic_graph/ });
    expect(within(row).getByText("unknown", { selector: ".pill" })).toBeInTheDocument();
    expect(within(row).getByText("wiki inputs are not bound")).toBeInTheDocument();
    expect(within(row).getByTestId("observed-at")).toHaveTextContent("unknown");
    expect(screen.getByTestId("basis-verified-at")).toHaveTextContent("unknown");
    expect(screen.getByTestId("unpublished")).toHaveTextContent("structural_graph, recall, wiki, project_memory");
  });

  it("stale with cause: canonical current and derived pending are both reported; decisions and replans listed", async () => {
    mount(
      source({
        generations: [
          gen({
            channels: [
              channel("wiki", "current_for_basis", null) as never,
              channel("recall", "pending", "recall rebuild queued") as never,
              channel("project_memory", "stale", "decision:d1 superseded by decision:d2") as never,
            ],
            decision_refs: [{ source_id: "source-a", kind: "decision", id: "decision:d2", revision: h("d") }],
            replan_required: [{ source_id: "source-a", kind: "knowledge", id: "plan:p1", revision: h("e") }],
          }),
        ],
      }),
    );
    const table = await screen.findByRole("table", { name: /channels/i });
    const stale = within(table).getByRole("row", { name: /project_memory/ });
    expect(within(stale).getByText("stale", { selector: ".pill" })).toBeInTheDocument();
    expect(within(stale).getByText("decision:d1 superseded by decision:d2")).toBeInTheDocument();
    expect(screen.getByTestId("coexistence")).toHaveTextContent(/canonical current: wiki.*derived pending: recall/i);
    expect(screen.getByTestId("decision-refs")).toHaveTextContent("decision:d2");
    expect(screen.getByTestId("replan-required")).toHaveTextContent("plan:p1");
  });

  it("selects one generation at a time for the drilldown", async () => {
    mount(
      source({
        tip: h("2"),
        generations: [
          gen({ generation: h("2"), previous_generation: h("1"), channels: [channel("structural_graph", "stale", "source drift") as never] }),
          gen({ generation: h("1"), channels: [channel("structural_graph", "current_for_basis", null) as never] }),
        ],
      }),
    );
    expect(await screen.findByText("source drift")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/generation/i), { target: { value: h("1") } });
    expect(screen.queryByText("source drift")).toBeNull();
    expect(screen.getAllByRole("table", { name: /channels/i })).toHaveLength(1);
    expect(screen.getByText("current for basis", { selector: ".pill" })).toBeInTheDocument();
  });

  it("drilldown requests the selected generation's layer for this source and resets on selection change", async () => {
    const layer = (gen: string, n: number) => ({
      source_guild: "project", generation: gen, channel: "structural_graph", status: "verified", reason: null,
      artifact: "structural-graph.json", bytes: 10, sha256: h("f"), layer_hash: h("c"), basis_hash: h("b"), unknown_reason: null,
      top_level: [{ key: "nodes", kind: "array", length: n }],
    });
    const body = source({
      tip: h("2"),
      generations: [
        gen({ generation: h("2"), previous_generation: h("1"), channels: [channel("structural_graph", "stale", "source drift") as never] }),
        gen({ generation: h("1"), channels: [channel("structural_graph", "current_for_basis", null) as never] }),
      ],
    });
    const layerUrl = (g: string) => `/api/project/knowledge-generations/layer?guild=project&generation=${encodeURIComponent(g)}&channel=structural_graph`;
    handle = installMockFetch({
      override: (u) => (u === URL ? json(body) : u === layerUrl(h("2")) ? json(layer(h("2"), 7)) : u === layerUrl(h("1")) ? json(layer(h("1"), 3)) : undefined),
    });
    render(<MemoryRouter><FreshnessPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect structural_graph" }));
    expect(await screen.findByText(/7 items/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/generation/i), { target: { value: h("1") } });
    expect(screen.queryByTestId("layer-drilldown")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect structural_graph" }));
    expect(await screen.findByText(/3 items/)).toBeInTheDocument();
    expect(handle.calls.map((c) => c.url)).toContain(layerUrl(h("1")));
    expect(screen.queryByText(/7 items/)).toBeNull();
  });

  it("drilldown of a layer absent from the generation stays empty, with no counts", async () => {
    const body = source({ generations: [gen({ channels: [channel("recall", "pending", "rebuild queued") as never] })] });
    handle = installMockFetch({
      override: (u) =>
        u === URL
          ? json(body)
          : u.startsWith("/api/project/knowledge-generations/layer")
            ? json({ source_guild: "project", generation: h("1"), channel: "recall", status: "not_in_generation", reason: "recall has no layer in this generation", artifact: null, bytes: null, sha256: null, layer_hash: null, basis_hash: null, unknown_reason: null, top_level: [] })
            : undefined,
    });
    render(<MemoryRouter><FreshnessPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect recall" }));
    expect(await screen.findByText("recall has no layer in this generation")).toBeInTheDocument();
    expect(screen.queryByTestId("layer-top-level")).toBeNull();
  });

  describe("negative controls", () => {
    it("stale without a recorded cause says so instead of inventing one", async () => {
      mount(source({ generations: [gen({ channels: [channel("structural_graph", "stale", null) as never] })] }));
      const row = within(await screen.findByRole("table", { name: /channels/i })).getByRole("row", { name: /structural_graph/ });
      expect(within(row).getByText("cause not recorded")).toBeInTheDocument();
    });

    it("an unreadable tip shows its reason and no channel state, freshness, or counts", async () => {
      mount(
        source({
          status: "unreadable",
          reason: "publication.json hash does not match its pointer",
          generations: [gen({ status: "unreadable", reason: "publication.json hash does not match its pointer", source_worktree_id: null })],
        }),
      );
      expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent(/hash does not match/);
      expect(screen.queryByRole("table", { name: /channels/i })).toBeNull();
      expect(screen.queryByText(/current for basis|^0$/)).toBeNull();
    });

    it("an empty candidate manifest stays empty", async () => {
      mount(
        source({
          generations: [gen({ channels: [channel("wiki", "current_for_basis", null) as never] })],
          candidates: { status: "read", reason: null, owner_source_id: "source-a", autopromote: false, generated_at: null, entries: [] },
        }),
      );
      expect(await screen.findByText("No candidates in the manifest.")).toBeInTheDocument();
      expect(screen.getByTestId("candidates-generated-at")).toHaveTextContent("unknown");
    });

    it("two revisions of one candidate path render as two rows", async () => {
      const e = (rev: string, state: string) => ({ path: "knowledge/candidates/decisions/c1.md", state, decision_id: "decision:d1", candidate_id: "candidate:c1", candidate_revision: rev, conflict_count: 0 });
      mount(source({ status: "none", tip: null, reason: "no knowledge publication", candidates: { status: "read", reason: null, owner_source_id: "source-a", autopromote: false, generated_at: "2026-10-27T00:00:00Z", entries: [e(h("1"), "pending_human_ingest"), e(h("2"), "missing")] } }));
      const table = await screen.findByRole("table", { name: "Candidates" });
      expect(within(table).getAllByRole("row")).toHaveLength(3);
      expect(within(table).getByText("missing")).toBeInTheDocument();
      expect(within(table).getByText("222222222222")).toBeInTheDocument();
    });

    it("server error is reported, not rendered as an empty project", async () => {
      mount({ error: "boom" }, 500);
      expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load/);
    });
  });
});
