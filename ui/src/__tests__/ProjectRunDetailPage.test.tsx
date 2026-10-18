import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import ProjectRunDetailPage from "../routes/ProjectRunDetailPage";
import { installMockFetch, type MockFetchHandle } from "./fixtures/mockFetch";

// E01-AC3 followup: a contained `?ref=` opens through
// GET /api/project/runs/:run_id/artifacts/*; a refused ref stays plain text.

const RUN = "run-20261018-000001-demo";

function detail() {
  return {
    run: {
      run_id: RUN,
      source_guild: "plugin",
      path: `/abs/project/.guild/runs/${RUN}`,
      has_run_yaml: true,
      has_provenance: false,
      benchmark_eligible: false,
    },
    event_count: 1,
    trace_preview: [],
  };
}

function mount(search: string): MockFetchHandle {
  const handle = installMockFetch({
    override: (url) =>
      url.startsWith(`/api/project/runs/${RUN}?`) || url === `/api/project/runs/${RUN}`
        ? new Response(JSON.stringify(detail()), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : undefined,
  });
  render(
    <MemoryRouter initialEntries={[`/project-runs/${RUN}${search}`]}>
      <Routes>
        <Route path="/project-runs/:run_id" element={<ProjectRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return handle;
}

describe("ProjectRunDetailPage — referenced file", () => {
  let handle: MockFetchHandle | undefined;
  afterEach(() => {
    handle?.reset();
    handle = undefined;
    cleanup();
  });

  it("links a contained ref to the project-run artifact route", async () => {
    handle = mount(`?guild=plugin&ref=${encodeURIComponent("logs/v1.4-events.jsonl")}`);
    const link = await screen.findByTestId("run-ref-file-link");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(
      `/api/project/runs/${RUN}/artifacts/logs/v1.4-events.jsonl?guild=plugin`,
    );
    expect(screen.queryByTestId("run-ref-unlinked")).toBeNull();
  });

  it("encodes each path segment", async () => {
    handle = mount(`?ref=${encodeURIComponent("evidence/a b#c.txt")}`);
    // `#` starts a fragment under E01's rules, so only `evidence/a b` is the path.
    const link = await screen.findByTestId("run-ref-file-link");
    expect(link.getAttribute("href")).toBe(`/api/project/runs/${RUN}/artifacts/evidence/a%20b`);
  });

  it("links a colon-bearing name the route also serves", async () => {
    handle = mount(`?ref=${encodeURIComponent("1:note.txt")}`);
    const link = await screen.findByTestId("run-ref-file-link");
    expect(link.getAttribute("href")).toBe(`/api/project/runs/${RUN}/artifacts/1%3Anote.txt`);
  });

  it.each([
    ["scheme-shaped name", "http:note.txt"],
    ["traversal", "../../etc/passwd"],
    ["absolute", "/etc/passwd"],
    ["backslash", "logs\\..\\secret"],
    ["scheme", "file:///etc/passwd"],
    ["dot segment", "logs/./x"],
  ])("renders a refused %s ref as plain text, never a link", async (_label, ref) => {
    handle = mount(`?guild=plugin&ref=${encodeURIComponent(ref)}`);
    const text = await screen.findByTestId("run-ref-unlinked");
    expect(text).toHaveTextContent(ref);
    expect(screen.queryByTestId("run-ref-file-link")).toBeNull();
    for (const a of Array.from(document.querySelectorAll("a"))) {
      expect(a.getAttribute("href") ?? "").not.toContain("/artifacts/");
    }
  });

  it("renders no ref section without a ref", async () => {
    handle = mount("?guild=plugin");
    await screen.findByText("Metadata");
    expect(screen.queryByTestId("run-ref")).toBeNull();
  });
});
