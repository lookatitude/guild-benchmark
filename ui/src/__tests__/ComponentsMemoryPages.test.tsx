import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import ComponentsPage from "../routes/ComponentsPage";
import MemoryPage from "../routes/MemoryPage";
import { installMockFetch, type MockFetchHandle } from "./fixtures/mockFetch";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mount(element: JSX.Element, url: string, body: unknown, status = 200): MockFetchHandle {
  const handle = installMockFetch({
    override: (u) => (u === url ? json(body, status) : undefined),
  });
  render(<MemoryRouter>{element}</MemoryRouter>);
  return handle;
}

const COMPONENTS = {
  components: [
    {
      kind: "agent",
      name: "backend",
      source_guild: "project",
      path: ".guild/agents/backend.md",
      description: "Builds APIs.",
      model: "opus",
    },
    {
      kind: "skill",
      name: "do-thing",
      source_guild: "project",
      path: ".guild/skills/do-thing/SKILL.md",
    },
  ],
  total: 2,
  truncated: false,
  sources: [{ guild: "project", present: ["agent", "skill"] }],
};

const MEMORY = {
  entries: [
    {
      kind: "summary",
      source_guild: "project",
      path: ".guild/memory/summaries/a.md",
      title: "Release summary",
      date: "2026-09-01",
      date_source: "frontmatter",
      excerpt: "Shipped the thing",
      excerpt_truncated: true,
    },
    {
      kind: "recall-index",
      source_guild: "project",
      path: ".guild/memory/recall-index.json",
      title: "Recall index",
      date: "2026-01-02T03:04:05.000Z",
      date_source: "mtime",
      entry_count: 0,
    },
  ],
  total: 2,
  truncated: false,
  sources: [{ guild: "project", present: ["summary", "recall-index"] }],
};

describe("ComponentsPage", () => {
  let handle: MockFetchHandle | undefined;
  afterEach(() => {
    handle?.reset();
    handle = undefined;
    cleanup();
  });

  it("renders rows with only stated fields and filters by kind and text", async () => {
    handle = mount(<ComponentsPage />, "/api/project/components", COMPONENTS);
    expect(await screen.findByText("backend")).toBeInTheDocument();
    expect(screen.getByText("Builds APIs.")).toBeInTheDocument();
    expect(screen.getByText("opus")).toBeInTheDocument();
    expect(screen.getByText("do-thing")).toBeInTheDocument();
    expect(document.querySelectorAll("tbody a")).toHaveLength(0);
    expect(screen.queryByTestId("listing-truncated")).toBeNull();

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "skill" } });
    expect(screen.queryByText("backend")).toBeNull();
    expect(screen.getByText("do-thing")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "zzz" } });
    expect(screen.getByText("No components match this filter.")).toBeInTheDocument();
  });

  it("says when the server truncated the listing", async () => {
    handle = mount(<ComponentsPage />, "/api/project/components", { ...COMPONENTS, truncated: true });
    expect(await screen.findByTestId("listing-truncated")).toHaveTextContent(/walk limit/);
  });

  it("shows the truncation notice even when no rows came back", async () => {
    handle = mount(<ComponentsPage />, "/api/project/components", { components: [], total: 0, truncated: true, sources: [] });
    expect(await screen.findByTestId("listing-truncated")).toBeInTheDocument();
    expect(screen.queryByText(/No agents, skills, or registry entries found/)).toBeNull();
  });

  it("shows an honest empty state", async () => {
    handle = mount(<ComponentsPage />, "/api/project/components", {
      components: [],
      total: 0,
      sources: [],
    });
    expect(await screen.findByText(/No agents, skills, or registry entries found/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("explains a missing project root", async () => {
    handle = mount(
      <ComponentsPage />,
      "/api/project/components",
      { error: "no project root configured (start serve with --project-root <abs>)" },
      404,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/--project-root/);
  });
});

describe("MemoryPage", () => {
  let handle: MockFetchHandle | undefined;
  afterEach(() => {
    handle?.reset();
    handle = undefined;
    cleanup();
  });

  it("renders entries with a labelled date source and bounded excerpt", async () => {
    handle = mount(<MemoryPage />, "/api/project/memory", MEMORY);
    expect(await screen.findByText("Release summary")).toBeInTheDocument();
    expect(screen.getByText("Shipped the thing…")).toBeInTheDocument();
    expect(screen.getByText("0 entries")).toBeInTheDocument();
    const labels = screen.getAllByTestId("memory-date-source").map((n) => n.textContent);
    expect(labels).toEqual(["frontmatter", "file mtime"]);

    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "recall-index" } });
    expect(screen.queryByText("Release summary")).toBeNull();
  });

  it("says when the server truncated the listing", async () => {
    handle = mount(<MemoryPage />, "/api/project/memory", { ...MEMORY, truncated: true });
    expect(await screen.findByTestId("listing-truncated")).toHaveTextContent(/walk limit/);
  });

  it("shows the truncation notice even when no rows came back", async () => {
    handle = mount(<MemoryPage />, "/api/project/memory", { entries: [], total: 0, truncated: true, sources: [] });
    expect(await screen.findByTestId("listing-truncated")).toBeInTheDocument();
    expect(screen.queryByText(/No memory summaries, lessons, or recall index found/)).toBeNull();
  });

  it("shows an honest empty state", async () => {
    handle = mount(<MemoryPage />, "/api/project/memory", { entries: [], total: 0, sources: [] });
    expect(await screen.findByText(/No memory summaries, lessons, or recall index found/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
