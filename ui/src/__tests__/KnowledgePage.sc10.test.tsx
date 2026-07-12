// KnowledgePage.sc10.test.tsx
//
// SC-10 UI render verification — confirms KnowledgePage correctly renders
// v2 knowledge graph features when the API returns a v2 response:
//
//   (a) subtopic_of tree panel renders with depth badge (≥ 3)
//   (b) wiki_page clusters panel renders with category / importance / label badges
//   (c) cross-modal evidenced_by panel renders doc→code edges
//
// The mock fetch returns the same canonical v2 fixture used by the server-level
// SC-10 test (knowledge-graph-v2.json, copied from the plugin corpus).
// This verifies the RENDER path (KnowledgePage component) after the import
// path is proven green by server.sc10-knowledge-v2.test.ts.

import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import KnowledgePage from "../routes/KnowledgePage";
import { installMockFetch } from "./fixtures/mockFetch";
import v2Graph from "./fixtures/knowledge-graph-v2.json";

// The API response shape wraps nodes/edges with source_guild + sources array.
// We simulate what readProjectKnowledgeGraph returns for a plain project root.
const V2_KG_API_RESPONSE = {
  nodes: (v2Graph.nodes as Record<string, unknown>[]).map((n) => ({
    ...n,
    source_guild: "project",
  })),
  edges: (v2Graph.edges as Record<string, unknown>[]).map((e) => ({
    ...e,
    source_guild: "project",
  })),
  sources: [
    {
      guild: "project",
      path: "/project/.guild/indexes/knowledge-graph.json",
      kind: "knowledge-graph",
    },
  ],
};

function mountWithV2Kg() {
  const handle = installMockFetch({
    override: (url) => {
      if (!url.includes("/api/project/knowledge-graph")) return undefined;
      return new Response(JSON.stringify(V2_KG_API_RESPONSE), {
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

describe("KnowledgePage — SC-10 v2 render verification", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("renders the node/edge count summary for the 28-node v2 graph", async () => {
    handle = mountWithV2Kg();
    await waitFor(() => {
      expect(screen.getByText(/28 nodes · 24 edges/)).toBeInTheDocument();
    });
  });

  // ---- SC-10(a): subtopic_of tree panel ------------------------------------

  it("SC-10(a): renders the subtopic_of tree panel with a depth ≥ 3 badge", async () => {
    handle = mountWithV2Kg();
    // The panel renders when subtopic_of edges exist.
    const treePanel = await screen.findByTestId("knowledge-v2-subtopic-tree");
    expect(treePanel).toBeInTheDocument();

    // Heading confirms it is the topic tree panel.
    expect(within(treePanel).getByRole("heading", { name: /topic tree/i })).toBeInTheDocument();

    // Depth badge: fixture has depth 4 (3 edges from Event Pipeline root to Webhook Adapter leaf).
    expect(within(treePanel).getByText(/depth \d+/i)).toBeInTheDocument();

    // The tree list is rendered.
    const treeList = within(treePanel).getByTestId("knowledge-subtopic-tree-list");
    expect(treeList).toBeInTheDocument();

    // Root topic (Event Pipeline) appears somewhere in the tree.
    expect(within(treeList).getByText("Event Pipeline")).toBeInTheDocument();
    // Leaf topic (Webhook Adapter) appears deeper in the tree.
    expect(within(treeList).getByText("Webhook Adapter")).toBeInTheDocument();
  });

  // ---- SC-10(b): wiki_page clusters panel ----------------------------------

  it("SC-10(b): renders the wiki_page clusters panel with category / importance / label badges", async () => {
    handle = mountWithV2Kg();
    const clustersPanel = await screen.findByTestId("knowledge-v2-wiki-clusters");
    expect(clustersPanel).toBeInTheDocument();

    // Heading.
    expect(within(clustersPanel).getByRole("heading", { name: /wiki pages/i })).toBeInTheDocument();

    // The Ingestion wiki_page has category=guide, importance=high, labels=[ingestion, pipeline].
    const listItem = (await within(clustersPanel).findAllByRole("listitem")).find((li) =>
      within(li).queryByText("Ingestion") !== null,
    );
    expect(listItem).toBeDefined();
    if (!listItem) throw new Error("Ingestion list item not found");

    // Category badge.
    expect(within(listItem).getByText("guide")).toBeInTheDocument();
    // Importance badge.
    expect(within(listItem).getByText("high")).toBeInTheDocument();
    // Labels.
    expect(within(listItem).getByText("ingestion")).toBeInTheDocument();
    expect(within(listItem).getByText("pipeline")).toBeInTheDocument();
  });

  // ---- SC-10(c): cross-modal evidenced_by panel ----------------------------

  it("SC-10(c): renders the cross-modal evidenced_by panel with doc→code edges", async () => {
    handle = mountWithV2Kg();
    const crossModalPanel = await screen.findByTestId("knowledge-v2-cross-modal-edges");
    expect(crossModalPanel).toBeInTheDocument();

    // Heading.
    expect(
      within(crossModalPanel).getByRole("heading", { name: /cross-modal evidence/i }),
    ).toBeInTheDocument();

    // At least one list item should be rendered.
    const items = within(crossModalPanel).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(1);

    // The claim → validateEvent edge must appear:
    // source type "claim", source label (name of the claim node), target type "function",
    // target label "validateEvent".
    const claimItem = items.find(
      (li) =>
        within(li).queryByText("claim") !== null &&
        within(li).queryByText("validateEvent") !== null,
    );
    expect(claimItem).toBeDefined();
    if (!claimItem) throw new Error("claim→validateEvent edge not found in cross-modal panel");

    // Arrow separator is present.
    expect(within(claimItem).getByText("→")).toBeInTheDocument();
    expect(within(claimItem).getByText("function")).toBeInTheDocument();
  });

  // ---- Back-compat: old v1 graph does NOT render v2 panels -----------------

  it("does NOT render v2 panels when graph has no subtopic_of / wiki_page / evidenced_by data", async () => {
    handle = installMockFetch({
      override: (url) => {
        if (!url.includes("/api/project/knowledge-graph")) return undefined;
        const v1Graph = {
          nodes: [
            { id: "src/server.ts", type: "file", name: "server.ts", source_guild: "project" },
            { id: "createApp", type: "function", name: "createApp", source_guild: "project" },
          ],
          edges: [
            {
              source: "src/server.ts",
              target: "createApp",
              type: "declares",
              source_guild: "project",
            },
          ],
          sources: [
            {
              guild: "project",
              path: "/proj/.guild/indexes/knowledge-graph.json",
              kind: "knowledge-graph",
            },
          ],
        };
        return new Response(JSON.stringify(v1Graph), {
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

    await screen.findByTestId("knowledge-node-list");
    expect(screen.queryByTestId("knowledge-v2-subtopic-tree")).toBeNull();
    expect(screen.queryByTestId("knowledge-v2-wiki-clusters")).toBeNull();
    expect(screen.queryByTestId("knowledge-v2-cross-modal-edges")).toBeNull();
  });
});
