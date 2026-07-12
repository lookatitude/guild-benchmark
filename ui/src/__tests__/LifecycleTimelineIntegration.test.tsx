// LifecycleTimelineIntegration.test.tsx — SC-9
// TDD integration: RunDetailPage renders a lifecycle timeline section
// when GET /api/runs/:id/lifecycle-record returns a LifecycleRunRecord.
//
// NOTE: mockFetch's default intercept returns 404 for /lifecycle-record URLs
// without calling the override (to preserve existing polling-contract test
// invariants). This test therefore installs its own fetch spy so it can
// control both the run-detail and lifecycle-record responses independently.

import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import RunDetailPage from "../routes/RunDetailPage";
import runDetailFixture from "./fixtures/run-detail.json";
import type { LifecycleRunRecord } from "../../../src/types";

const LIFECYCLE_FIXTURE: LifecycleRunRecord = {
  run_id: "sample-pass-001",
  command: "/guild:learn",
  run_class: "full",
  run_type: "learn",
  benchmark_eligible: false,
  started_at: "2026-05-01T10:00:00Z",
  closed_at: "2026-05-01T10:10:00Z",
  status: "closed",
  phases_log: [
    { phase: "detect", at: "2026-05-01T10:00:01Z" },
    { phase: "learn", at: "2026-05-01T10:01:00Z" },
  ],
  timeline: [
    { at: "2026-05-01T10:00:00Z", kind: "run_started", label: "run_started" },
    { at: "2026-05-01T10:00:01Z", kind: "phase", label: "detect" },
    {
      at: "2026-05-01T10:01:00Z",
      kind: "phase",
      label: "learn (end)",
      duration_ms: 54000,
      detail: { status: "completed" },
    },
    { at: "2026-05-01T10:10:00Z", kind: "run_closed", label: "run_closed" },
  ],
  metrics: {
    replay_completeness: "full",
    benchmark_fixture_eligible: false,
  },
  partial: false,
  missing_artifacts: [],
};

// Install a standalone fetch spy that handles both run-detail and lifecycle
// endpoints. The lifecycle-record URL is matched BEFORE the broad run-detail
// pattern so the right fixture is returned.
function installFullFetchSpy({
  lifecycleStatus,
}: {
  lifecycleStatus: "found" | "not-found";
}) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.match(/\/lifecycle-record$/)) {
      if (lifecycleStatus === "found") {
        return new Response(JSON.stringify(LIFECYCLE_FIXTURE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ error: "no lifecycle record for run: sample-pass-001" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    if (url.match(/\/api\/runs\/[^/]+$/)) {
      return new Response(JSON.stringify(runDetailFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(`unhandled: ${url}`, { status: 599 });
  });

  vi.stubGlobal("fetch", spy);
  return spy;
}

function mount(runId = "sample-pass-001") {
  return render(
    <MemoryRouter initialEntries={[`/runs/${runId}`]}>
      <Routes>
        <Route path="/runs/:run_id" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetailPage — lifecycle timeline section", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the Lifecycle timeline section heading when lifecycle record is available", async () => {
    installFullFetchSpy({ lifecycleStatus: "found" });
    mount();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /lifecycle timeline/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders all four timeline entries from the lifecycle record", async () => {
    installFullFetchSpy({ lifecycleStatus: "found" });
    mount();

    // 4 entries = 4 data rows + 1 header row = 5 rows total
    await waitFor(() => {
      const rows = screen.getAllByRole("row");
      expect(rows).toHaveLength(5);
    });

    // Spot-check that run_started and run_closed appear
    expect(screen.getByTestId("timeline-kind-0")).toHaveTextContent("run_started");
    expect(screen.getByTestId("timeline-kind-3")).toHaveTextContent("run_closed");
  });

  it("does NOT render the lifecycle timeline section when the run has no lifecycle record (404)", async () => {
    installFullFetchSpy({ lifecycleStatus: "not-found" });
    mount();

    // Wait for the main run detail to load
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run metadata" }),
      ).toBeInTheDocument();
    });

    // No lifecycle section should appear
    expect(
      screen.queryByRole("heading", { name: /lifecycle timeline/i }),
    ).not.toBeInTheDocument();
  });

  it("renders duration_ms formatted in the lifecycle timeline", async () => {
    installFullFetchSpy({ lifecycleStatus: "found" });
    mount();

    // Entry index 2 has duration_ms: 54000 = 54.0 s
    await waitFor(() => {
      expect(screen.getByTestId("timeline-duration-2")).toHaveTextContent("54.0 s");
    });
  });
});
