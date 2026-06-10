import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import WikiPage from "../routes/WikiPage";
import { installMockFetch } from "./fixtures/mockFetch";

// SC-12 / G-18 — Wiki browser tests. Backend contract:
// GET /api/project/wiki        → { pages: [{ path, title, source_guild, labels? }] }
// GET /api/project/wiki/page   → { path, source_guild, content }

const WORKSPACE_PAGES = {
  pages: [
    {
      path: "index.md",
      title: "Alpha Wiki",
      source_guild: "alpha",
    },
    {
      path: "standards/hooks.md",
      title: "shell-hook-json-parsing",
      source_guild: "alpha",
      labels: ["hooks", "shell"],
    },
    {
      path: "index.md",
      title: "Beta Wiki",
      source_guild: "beta",
    },
  ],
};

const PAGE_BODIES: Record<string, { path: string; source_guild: string; content: string }> = {
  "alpha:index.md": {
    path: "index.md",
    source_guild: "alpha",
    content: "# Alpha Wiki\n\nAlpha index body.\n",
  },
  "alpha:standards/hooks.md": {
    path: "standards/hooks.md",
    source_guild: "alpha",
    content: "# shell-hook-json-parsing\n\nUse temp files.\n",
  },
  "beta:index.md": {
    path: "index.md",
    source_guild: "beta",
    content: "# Beta Wiki\n\nBeta index body.\n",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wikiOverride(url: string): Response | undefined {
  if (url.includes("/api/project/wiki/page")) {
    const u = new URL(url, "http://127.0.0.1");
    const path = u.searchParams.get("path") ?? "";
    const guild = u.searchParams.get("guild") ?? "";
    const body = PAGE_BODIES[`${guild}:${path}`];
    return body
      ? jsonResponse(body)
      : jsonResponse({ error: `wiki page not found: ${path}` }, 404);
  }
  if (url.includes("/api/project/wiki")) {
    return jsonResponse(WORKSPACE_PAGES);
  }
  return undefined;
}

function mount(override: (url: string) => Response | undefined = wikiOverride) {
  const handle = installMockFetch({ override });
  render(
    <MemoryRouter initialEntries={["/wiki"]}>
      <WikiPage />
    </MemoryRouter>,
  );
  return handle;
}

describe("WikiPage", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("groups the page list by source_guild with labels as badges", async () => {
    handle = mount();
    expect(await screen.findByRole("heading", { name: "Wiki" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("Alpha Wiki")).toBeInTheDocument();
    });
    // Two guild groups with per-group counts.
    expect(screen.getByText("2 pages")).toBeInTheDocument(); // alpha
    expect(screen.getByText("1 page")).toBeInTheDocument(); // beta
    expect(screen.getByText("Beta Wiki")).toBeInTheDocument();
    // Frontmatter labels render as badges.
    expect(screen.getByText("hooks")).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument();
    // Placeholder until a page is picked.
    expect(screen.getByText(/Select a page to read it/)).toBeInTheDocument();
  });

  it("selecting a page fetches it with the owning guild and renders the content", async () => {
    handle = mount();
    await screen.findByText("Beta Wiki");
    await userEvent.click(screen.getByText("Beta Wiki"));
    const panel = await screen.findByTestId("wiki-page-content");
    expect(within(panel).getByText(/Beta index body/)).toBeInTheDocument();
    expect(within(panel).getByText("beta")).toBeInTheDocument();
    // The fetch carried both path and guild query params.
    const pageCall = handle.calls.find((c) => c.url.includes("/api/project/wiki/page"));
    expect(pageCall).toBeDefined();
    expect(pageCall!.url).toContain("path=index.md");
    expect(pageCall!.url).toContain("guild=beta");
  });

  it("switching pages swaps the rendered content", async () => {
    handle = mount();
    await screen.findByText("Alpha Wiki");
    await userEvent.click(screen.getByText("Alpha Wiki"));
    await screen.findByTestId("wiki-page-content");
    expect(screen.getByText(/Alpha index body/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("shell-hook-json-parsing"));
    await waitFor(() => {
      expect(screen.getByText(/Use temp files/)).toBeInTheDocument();
    });
  });

  it("shows a page-level error when the page fetch 404s", async () => {
    handle = mount((url) => {
      if (url.includes("/api/project/wiki/page")) {
        return jsonResponse({ error: "wiki page not found: index.md" }, 404);
      }
      if (url.includes("/api/project/wiki")) return jsonResponse(WORKSPACE_PAGES);
      return undefined;
    });
    await screen.findByText("Alpha Wiki");
    await userEvent.click(screen.getByText("Alpha Wiki"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/wiki page not found/);
  });

  it("renders the empty state when the wiki has no pages", async () => {
    handle = mount((url) =>
      url.includes("/api/project/wiki") ? jsonResponse({ pages: [] }) : undefined,
    );
    expect(await screen.findByText(/no pages yet/)).toBeInTheDocument();
  });

  it("renders the live-mode-off hint on the no-project-root 404", async () => {
    handle = mount((url) =>
      url.includes("/api/project/wiki")
        ? jsonResponse(
            { error: "no project root configured (start serve with --project-root <abs>)" },
            404,
          )
        : undefined,
    );
    expect(await screen.findByTestId("wiki-no-project-root")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders an error banner for other list failures", async () => {
    handle = mount((url) =>
      url.includes("/api/project/wiki")
        ? jsonResponse({ error: "disk exploded" }, 500)
        : undefined,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
