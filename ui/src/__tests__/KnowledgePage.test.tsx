import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import KnowledgePage from "../routes/KnowledgePage";
import { installMockFetch } from "./fixtures/mockFetch";

// SC-12 / G-18 — Knowledge view tests. Backend contract:
// GET /api/project/knowledge-graph → { nodes, edges, sources } with
// source_guild stamped on every node/edge (project-reader.ts).

const WORKSPACE_KG = {
  nodes: [
    { id: "src/server.ts", type: "file", name: "server.ts", source_guild: "alpha" },
    { id: "createApp", type: "function", name: "createApp", source_guild: "alpha" },
    { id: "beta-mod", type: "module", name: "beta-mod", source_guild: "beta" },
  ],
  edges: [
    { source: "src/server.ts", target: "createApp", type: "declares", source_guild: "alpha" },
    { source: "createApp", target: "beta-mod", type: "uses", source_guild: "alpha" },
  ],
  sources: [
    { guild: "alpha", path: "/ws/alpha/.guild/indexes/knowledge-graph.json" },
    { guild: "beta", path: "/ws/beta/.guild/indexes/knowledge-graph.json" },
  ],
};

const PLAIN_KG = {
  nodes: [{ id: "only", type: "file", name: "only.ts", source_guild: "project" }],
  edges: [],
  sources: [{ guild: "project", path: "/proj/.guild/indexes/knowledge-graph.json" }],
};

function kgResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mountWithKg(body: unknown, status = 200) {
  const handle = installMockFetch({
    override: (url) =>
      url.includes("/api/project/knowledge-graph") ? kgResponse(body, status) : undefined,
  });
  render(
    <MemoryRouter initialEntries={["/knowledge"]}>
      <KnowledgePage />
    </MemoryRouter>,
  );
  return handle;
}

describe("KnowledgePage", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("renders type counts, node list and workspace source badges", async () => {
    handle = mountWithKg(WORKSPACE_KG);
    expect(await screen.findByRole("heading", { name: "Knowledge" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/3 nodes · 2 edges · 2 sources/)).toBeInTheDocument();
    });
    expect(screen.getByTestId("knowledge-graph-canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Neighborhood" })).toBeDisabled();
    // Type-grouped counts.
    const counts = screen.getByTestId("knowledge-type-counts");
    expect(within(counts).getByText("file (1)")).toBeInTheDocument();
    expect(within(counts).getByText("function (1)")).toBeInTheDocument();
    expect(within(counts).getByText("module (1)")).toBeInTheDocument();
    // Workspace mode shows the source_guild badge per node.
    const list = screen.getByTestId("knowledge-node-list");
    expect(within(list).getAllByText("alpha").length).toBe(2);
    expect(within(list).getAllByText("beta").length).toBe(1);
  });

  it("filters the node list via the type buttons (toggle on/off)", async () => {
    handle = mountWithKg(WORKSPACE_KG);
    await screen.findByTestId("knowledge-node-list");
    await userEvent.click(screen.getByRole("button", { name: "module (1)" }));
    const list = screen.getByTestId("knowledge-node-list");
    expect(within(list).getByText("beta-mod")).toBeInTheDocument();
    expect(within(list).queryByText("createApp")).toBeNull();
    // Clicking the active filter again clears it.
    await userEvent.click(screen.getByRole("button", { name: "module (1)" }));
    expect(within(screen.getByTestId("knowledge-node-list")).getByText("createApp")).toBeInTheDocument();
  });

  it("searches nodes and shows the empty state on no match", async () => {
    handle = mountWithKg(WORKSPACE_KG);
    await screen.findByTestId("knowledge-node-list");
    const input = screen.getByLabelText("Search nodes");
    await userEvent.type(input, "createApp");
    const list = screen.getByTestId("knowledge-node-list");
    expect(within(list).getByText("createApp")).toBeInTheDocument();
    expect(within(list).queryByText("beta-mod")).toBeNull();
    await userEvent.clear(input);
    await userEvent.type(input, "zzz-no-match");
    expect(screen.getByText(/No nodes match the current filter/)).toBeInTheDocument();
  });

  it("selecting a node shows its edges grouped by type with clickable neighbors", async () => {
    handle = mountWithKg(WORKSPACE_KG);
    await screen.findByTestId("knowledge-node-list");
    const list = screen.getByTestId("knowledge-node-list");
    await userEvent.click(within(list).getByText("createApp"));
    expect(screen.getByRole("button", { name: "Neighborhood" })).not.toBeDisabled();
    const panel = await screen.findByTestId("knowledge-selected-node");
    // Two edge groups: declares (incoming from server.ts), uses (outgoing to beta-mod).
    expect(within(panel).getByRole("heading", { name: /declares/ })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: /uses/ })).toBeInTheDocument();
    expect(within(panel).getByText("server.ts")).toBeInTheDocument();
    // Clicking a neighbor re-selects it.
    await userEvent.click(within(panel).getByText("beta-mod"));
    const panel2 = await screen.findByTestId("knowledge-selected-node");
    expect(within(panel2).getByRole("heading", { name: /beta-mod/ })).toBeInTheDocument();
    expect(within(panel2).getByRole("heading", { name: /uses/ })).toBeInTheDocument();
  });

  it("plain project mode: no source badge column, singular counts", async () => {
    handle = mountWithKg(PLAIN_KG);
    await waitFor(() => {
      expect(screen.getByText(/1 node · 0 edges · 1 source/)).toBeInTheDocument();
    });
    const list = screen.getByTestId("knowledge-node-list");
    expect(within(list).queryByText("project")).toBeNull();
    // Selecting the only node shows the no-edges message.
    await userEvent.click(within(list).getByText("only.ts"));
    expect(await screen.findByText(/No edges touch this node/)).toBeInTheDocument();
  });

  it("renders the live-mode-off hint when the server returns the no-project-root 404", async () => {
    handle = mountWithKg(
      { error: "no project root configured (start serve with --project-root <abs>)" },
      404,
    );
    expect(await screen.findByTestId("knowledge-no-project-root")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an error banner for other failures", async () => {
    handle = mountWithKg({ error: "boom" }, 500);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
