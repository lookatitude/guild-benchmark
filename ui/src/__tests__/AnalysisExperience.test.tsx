// AnalysisExperience.test.tsx — E03 audit of the integrated analysis UX.
//
// Exercises every planned analysis state (empty, partial, stale, failed,
// cancelled, unknown, succeeded) through the shipped components at a mobile
// (320px) and a desktop (1280px) viewport, plus keyboard reach, focus
// retention, accessible names and "no inference from absent evidence".
//
// happy-dom has no layout engine: the viewport is set on window and the
// wrap styles are asserted, but pixel overflow is checked only by the
// integrated browser run (see the E03 report). Tests named "E03-F<n>"
// characterize audit findings: they pin the observed (defective) behavior so
// the report cites an executable observation, not prose.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AnalysisJobPanel, { type AnalysisJobView } from "../components/AnalysisJobPanel";
import RecommendationPanel from "../components/RecommendationPanel";
import ComparePage from "../routes/ComparePage";
import RunDetailPage, { AnalysisDetailView, type AnalysisDetailResponse } from "../routes/RunDetailPage";

const TOKEN = "a".repeat(64);
const INPUT_HASH = "b".repeat(64);
const LONG_ID = `run-${"x".repeat(124)}`; // 128 chars, the contract maximum
const VIEWPORTS = [
  { name: "mobile", width: 320, height: 640 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Route_ = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

function installFetch(route: Route_) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.endsWith("/project/analysis/session")) return json({ action_token: TOKEN });
    return (await route(url, init)) ?? json({ error: "unrouted" }, 404);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- fixtures: one detail response per planned read state ----------------

function summary(overrides: Partial<AnalysisDetailResponse["summary"]> = {}): AnalysisDetailResponse["summary"] {
  return {
    kind: "run",
    id: LONG_ID,
    source_guild: "root",
    analysis_id: "an-1",
    schema_version: "guild.run_analysis.v1",
    artifact_eligible: true,
    validation: "valid",
    invalid_recommendation_rows: 0,
    recommendation_count: 1,
    finding_count: 1,
    ...overrides,
  };
}

function fullArtifact(): Record<string, unknown> {
  return {
    run_id: LONG_ID,
    identity: { run_scope: "initiative", initiative_id: "init-1", host: "claude", phase: "build" },
    completeness: { score: 64, present: ["events", "receipts"], missing: ["usage"] },
    assessments: {
      instruction_following: { status: "satisfied", evidence_refs: [`.guild/runs/${LONG_ID}/events.jsonl#line:4`] },
      prompt_efficiency: { status: "ambiguous", evidence_refs: [] },
      workflow: { status: "violated", evidence_refs: ["https://evil.example/x"] },
      tool_coverage: { status: "unobservable", evidence_refs: [] },
    },
    findings: [{ id: "f1", kind: "loop", severity: "medium", summary: "Repeated review round", evidence_refs: [] }],
    usage: {
      tokens: { input: 10, output: 0, cached: 0, cost_usd: 0 },
      duration_ms: 0,
      availability: { input: { state: "complete" }, output: { state: "unobserved", missing_reason: "host_silent" } },
    },
  };
}

const STATES: Record<string, AnalysisDetailResponse> = {
  empty: {
    summary: summary({ analysis_id: null, validation: "absent", artifact_eligible: null, recommendation_count: 0, finding_count: 0 }),
    recommendations: [],
    invalid_recommendation_lines: 0,
    freshness: { state: "missing", reason: null },
  },
  partial: {
    summary: summary({ validation: "partial", invalid_recommendation_rows: 2 }),
    artifact: { run_id: LONG_ID }, // every evidence section absent
    recommendations: [],
    invalid_recommendation_lines: 1,
    freshness: { state: "current", reason: null, decision_eligible: true },
  },
  stale: {
    summary: summary(),
    artifact: fullArtifact(),
    recommendations: [],
    invalid_recommendation_lines: 0,
    freshness: { state: "stale", reason: "source_hash changed", decision_eligible: false },
  },
  failed: {
    summary: summary(),
    artifact: fullArtifact(),
    recommendations: [],
    invalid_recommendation_lines: 0,
    freshness: { state: "error", reason: "inspect exited 1" },
  },
  unknown: {
    summary: summary(),
    artifact: fullArtifact(),
    recommendations: [],
    invalid_recommendation_lines: 0,
    freshness: { state: "__proto__", reason: null },
  },
  succeeded: {
    summary: summary(),
    artifact: fullArtifact(),
    recommendations: [],
    invalid_recommendation_lines: 0,
    freshness: { state: "current", reason: null, decision_eligible: true },
  },
};

function mountDetail(detail: AnalysisDetailResponse) {
  return render(
    <MemoryRouter>
      <AnalysisDetailView detail={detail} />
    </MemoryRouter>,
  );
}

function job(overrides: Partial<AnalysisJobView> = {}): AnalysisJobView {
  return {
    job_id: "job-e03",
    source_guild: "root",
    operation: "analyze",
    state: "running",
    created_at: "2026-10-18T00:00:00.000Z",
    started_at: "2026-10-18T00:00:00.100Z",
    closed_at: null,
    exit_code: null,
    signal: null,
    stdout_excerpt: "",
    stderr_excerpt: "",
    artifact_refs: [],
    reason: null,
    ...overrides,
  };
}

const CLOSED = "2026-10-18T00:00:05.000Z";

/** Job state fixtures: the panel must reach each final text from real polls. */
const JOB_FINALS: Record<string, { poll: { status: number; body: unknown }; tone: string; text: RegExp }> = {
  succeeded: {
    poll: { status: 200, body: job({ state: "succeeded", closed_at: CLOSED, exit_code: 0, artifact_refs: [".guild/analysis/runs/r/analysis.json"] }) },
    tone: "done",
    text: /Job succeeded\. The producer reported 1 artifact\./,
  },
  failed: {
    poll: { status: 200, body: job({ state: "failed", closed_at: CLOSED, exit_code: 1, reason: "producer_failed", stderr_excerpt: "boom" }) },
    tone: "failure",
    text: /Job failed: producer_failed\. No result is reported\./,
  },
  cancelled: {
    poll: { status: 200, body: job({ state: "cancelled", closed_at: CLOSED, signal: "SIGTERM" }) },
    tone: "failure",
    text: /Job cancelled\. The process closed\./,
  },
  unknown: {
    poll: { status: 404, body: { error: "unknown job" } },
    tone: "failure",
    text: /does not know this job any more.*nothing was restarted/,
  },
};

// ---- E03-AC1: every planned read state, both widths ----------------------

describe.each(VIEWPORTS)("analysis read states at $name ($width px)", ({ width, height }) => {
  beforeEach(() => setViewport(width, height));

  it("empty: missing freshness, no artifact body, nothing invented", () => {
    mountDetail(STATES.empty);
    const notice = screen.getByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "missing");
    expect(notice).toHaveTextContent("Missing: no analysis exists for this target yet.");
    expect(notice).toHaveTextContent("No local artifact.");
    expect(screen.queryByTestId("completeness")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("partial: absent evidence renders 'not reported', never zero or success", () => {
    mountDetail(STATES.partial);
    expect(screen.getByTestId("analysis-freshness")).toHaveTextContent("Partial: the artifact validates but some recommendation rows do not.");
    expect(screen.getByTestId("analysis-freshness")).toHaveTextContent("Refused recommendation rows: 2 in artifact, 1 in ledger.");
    expect(screen.getByTestId("completeness")).toHaveTextContent("Evidence completeness: not reported");
    expect(screen.queryByTestId("completeness-score")).toBeNull();
    for (const key of ["instruction_following", "prompt_efficiency", "workflow", "tool_coverage"]) {
      const row = screen.getByTestId(`assessment-${key}`);
      expect(within(row).getByText("Not reported")).toHaveAttribute("data-assessment", "not_reported");
    }
    expect(screen.getByTestId("usage")).toHaveTextContent("Usage: not reported");
  });

  it("stale: stale notice, decision not eligible, evidence still shown", () => {
    mountDetail(STATES.stale);
    const notice = screen.getByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "stale");
    expect(notice).toHaveTextContent("Re-run analysis before relying on it.");
    expect(notice).toHaveTextContent("Reason: source_hash changed");
    expect(screen.getByTestId("decision-eligible")).toHaveTextContent("no");
  });

  it("failed: inspection error is 'freshness unknown', never current", () => {
    mountDetail(STATES.failed);
    const notice = screen.getByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "error");
    expect(notice).toHaveTextContent("Freshness unknown: the producer inspection failed.");
    expect(screen.getByTestId("decision-eligible")).toHaveTextContent("unknown");
  });

  it("unknown: an unrecognized producer state is shown as unsupported, prototype keys never resolve", () => {
    mountDetail(STATES.unknown);
    const notice = screen.getByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "unsupported");
    expect(screen.getByTestId("freshness-unrecognized")).toHaveTextContent("__proto__");
  });

  it("succeeded: current artifact shows the four distinct statuses and the 128-char id wraps", () => {
    mountDetail(STATES.succeeded);
    expect(screen.getByTestId("analysis-freshness")).toHaveAttribute("data-freshness", "current");
    const statuses = ["satisfied", "ambiguous", "violated", "unobservable"].map(
      (s) => screen.getByTestId("analysis-detail").querySelector(`[data-assessment="${s}"]`),
    );
    expect(statuses.every(Boolean)).toBe(true);
    expect(screen.getByTestId("completeness")).toHaveTextContent("It is not a quality score.");
    const scope = screen.getByTestId("analysis-scope");
    const id = within(scope).getByText(LONG_ID);
    expect(id.textContent).toHaveLength(128);
    expect(id.style.overflowWrap).toBe("anywhere");
    // Zero stored usage with an unobserved availability is "unknown", not 0.
    expect(screen.getByTestId("usage").querySelector('[data-usage-unknown="output"]')).toHaveTextContent("unknown (host_silent");
    // A scheme ref never becomes a link.
    const refused = screen.getAllByTestId("evidence-unlinked").find((n) => n.textContent?.includes("evil.example"));
    expect(refused).toHaveTextContent("not linked: URL scheme");
    expect(screen.queryByRole("link", { name: /evil/ })).toBeNull();
  });
});

// ---- E03-AC1: every planned job state, both widths ------------------------

describe.each(VIEWPORTS)("analysis job states at $name ($width px)", ({ width, height }) => {
  beforeEach(() => setViewport(width, height));

  it.each(Object.entries(JOB_FINALS))("%s reaches its final text only from a real poll", async (_name, final) => {
    const calls = installFetch((url, init) => {
      if (init?.method === "POST" && url.endsWith("/project/analysis/jobs")) return json(job(), 202);
      if (url.includes("/project/analysis/jobs/")) return json(final.poll.body, final.poll.status);
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <AnalysisJobPanel
        title="Analyze run"
        request={{ source_guild: "root", operation: "analyze", target_kind: "run", ids: ["run-a"] }}
        contextKey="ctx"
        disabledReason={null}
        pollIntervalMs={10}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status").dataset.jobTone ?? "").not.toBe("progress"));
    const text = (screen.getByTestId("job-status").textContent ?? "") + (screen.getByTestId("job-alert").textContent ?? "");
    expect(text).toMatch(final.text);
    expect(screen.getByTestId("job-status")).toHaveAttribute("data-job-tone", final.tone);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/jobs"));
    expect(post?.headers["X-Guild-Action-Token"]).toBe(TOKEN);
    // A 404 is never followed by an automatic restart.
    if (_name === "unknown") expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/jobs"))).toHaveLength(1);
  });

  it("running then cancel: stays open until the server reports the real close", async () => {
    let closed = false;
    installFetch((url, init) => {
      if (init?.method === "POST" && url.endsWith("/cancel")) return json(job({ state: "running" }), 202);
      if (init?.method === "POST") return json(job(), 202);
      if (url.includes("/project/analysis/jobs/")) {
        return json(closed ? job({ state: "cancelled", closed_at: CLOSED }) : job({ state: "running" }));
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <AnalysisJobPanel title="Analyze run" request={{ source_guild: "root", operation: "analyze", target_kind: "run", ids: ["run-a"] }} contextKey="ctx" disabledReason={null} pollIntervalMs={10} />,
    );
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await screen.findByText("Job is running.");
    await user.click(screen.getByRole("button", { name: "Cancel job" }));
    await screen.findByText(/Cancel requested\. The job stays running until the process closes\./);
    expect(screen.getByRole("button", { name: "Cancel requested" })).toHaveAttribute("aria-disabled", "true");
    closed = true;
    await screen.findByText(/Job cancelled\. The process closed\./);
  });
});

// ---- E03-AC1/AC3: 503 unconfigured on the real route ---------------------

describe.each(VIEWPORTS)("run page with no analysis package at $name", ({ width, height }) => {
  beforeEach(() => setViewport(width, height));

  it("shows the 503 hint and disables every action from the server reply", async () => {
    const hint = "start serve with --guild-plugin-package <absolute-packaged-plugin-root>";
    installFetch((url) => {
      if (url.includes("/project/analysis/artifacts")) return json({ error: "analysis_package_unconfigured", hint }, 503);
      if (url.includes("/api/runs/")) return json({ error: "run not found" }, 404);
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={["/runs/run-a?guild=root"]}>
        <Routes>
          <Route path="/runs/:run_id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const banner = await screen.findByTestId("analysis-unconfigured");
    // E03-F5: the banner names the flag once instead of repeating "start serve with".
    expect(banner).toHaveTextContent("Start the server with --guild-plugin-package <absolute-packaged-plugin-root>.");
    expect(banner.textContent).not.toMatch(/start serve with/i);
    for (const key of ["analyze-run", "inspect-run"]) {
      const row = screen.getByTestId(`analysis-action-${key}`);
      expect(row).toHaveAttribute("data-action-state", "disabled");
      expect(row).toHaveTextContent("Disabled: analysis package is not configured");
    }
  });
});

// ---- E03-AC3: controls follow the server refusal, not frontend disabling --

describe("server refusals drive the controls", () => {
  it.each([
    [403, { error: "foreign Origin: http://evil.example" }, /refused the action token \(foreign Origin/],
    [409, { error: "another analysis job is active", active: job({ job_id: "job-other" }) }, /Another analysis job is active for this project \(job-other, running\)\. Nothing was started\./],
    [503, { error: "analysis_package_unconfigured" }, /Analysis jobs are unavailable: no analysis package is configured/],
  ])("HTTP %i from POST /jobs is shown verbatim and nothing is tracked", async (status, body, text) => {
    installFetch((_url, init) => (init?.method === "POST" ? json(body, status) : undefined));
    const user = userEvent.setup();
    render(
      <AnalysisJobPanel title="Analyze run" request={{ source_guild: "root", operation: "analyze", target_kind: "run", ids: ["run-a"] }} contextKey="ctx" disabledReason={null} pollIntervalMs={10} />,
    );
    // The start control is enabled in the browser; only the server says no.
    expect(screen.getByRole("button", { name: "Start job" })).not.toHaveAttribute("aria-disabled");
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect((screen.getByTestId("job-status").textContent ?? "") + (screen.getByTestId("job-alert").textContent ?? "")).toMatch(text));
    expect(screen.queryByTestId("job-detail")).toBeNull();
  });

  it("a 403 drops the token so the next attempt refetches /session", async () => {
    let first = true;
    const calls = installFetch((_url, init) => {
      if (init?.method === "POST") {
        if (first) {
          first = false;
          return json({ error: "missing or invalid X-Guild-Action-Token" }, 403);
        }
        return json(job({ state: "succeeded", closed_at: CLOSED, exit_code: 0 }), 202);
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <AnalysisJobPanel title="Analyze run" request={{ source_guild: "root", operation: "analyze", target_kind: "run", ids: ["run-a"] }} contextKey="ctx" disabledReason={null} pollIntervalMs={10} />,
    );
    await user.click(screen.getByRole("button", { name: "Start job" }));
    await screen.findByText(/refused the action token/);
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Job succeeded/);
    expect(calls.filter((c) => c.url.endsWith("/session"))).toHaveLength(2);
  });
});

// ---- E03 step 2: keyboard, focus, names, no inference ---------------------

describe("keyboard, focus and accessible names", () => {
  it("every job control is reachable by Tab, keeps focus while polling, and blocked controls stay focusable", async () => {
    let polls = 0;
    installFetch((url, init) => {
      if (init?.method === "POST") return json(job(), 202);
      if (url.includes("/project/analysis/jobs/")) {
        polls++;
        return json(job({ state: polls < 3 ? "queued" : "running" }));
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <AnalysisJobPanel title="Analyze run" request={{ source_guild: "root", operation: "analyze", target_kind: "run", ids: ["run-a"] }} contextKey="ctx" disabledReason={null} pollIntervalMs={10} />,
    );
    expect(screen.getByRole("region", { name: "Analyze run" })).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("button", { name: "Start job" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByText("Job is queued.");
    await user.tab();
    expect(screen.getByRole("button", { name: "Cancel job" })).toHaveFocus();
    await user.tab();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toHaveFocus();
    expect(retry).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(3));
    await screen.findByText("Job is running.");
    expect(retry).toHaveFocus();
    // Enter on a blocked control does nothing.
    await user.keyboard("{Enter}");
    expect(screen.getByText("Job is running.")).toBeInTheDocument();
  });

  it("recommendation decision is keyboard-only operable and names its effect before confirm", async () => {
    installFetch((url, init) => {
      if (init?.method === "POST") return json(job({ operation: "recommendation_decide" }), 202);
      if (url.includes("/project/analysis/jobs/")) {
        return json(job({ operation: "recommendation_decide", state: "succeeded", closed_at: CLOSED, exit_code: 0, stdout_excerpt: JSON.stringify({ effect: "project_proposal_queued", status: "queued" }) }));
      }
      return undefined;
    });
    const user = userEvent.setup();
    render(
      <RecommendationPanel
        sourceGuild="root"
        sourceKind="run"
        sourceId="run-a"
        sourceAnalysisId="an-1"
        sourceInputHash={INPUT_HASH}
        decisionEligible={true}
        pollIntervalMs={10}
        recommendations={[{ id: "rec-1", source_id: "run-a", source_analysis_id: "an-1", scope: "project", kind: "workflow", status: "proposed", proposed_action: "Add a review gate", confidence: "medium", severity: "low", evidence_refs: [] }]}
      />,
    );
    const item = screen.getByRole("listitem", { name: "Add a review gate" });
    expect(within(item).getByTestId("recommendation-destination")).toHaveTextContent("project proposal queue");
    within(item).getByRole("button", { name: "Accept…" }).focus();
    await user.keyboard("{Enter}");
    const group = screen.getByRole("group", { name: "Confirm accept" });
    expect(group).toHaveTextContent("Accept sets the status queued");
    expect(group).toHaveTextContent("Nothing is implemented.");
    within(group).getByRole("button", { name: "Confirm accept" }).focus();
    await user.keyboard("{Enter}");
    await screen.findByText("The producer recorded: queued proposal. Not implemented.");
    // No UI-only "implemented" or "filed" claim anywhere.
    expect(screen.queryByText(/\bis implemented\b|\bwas filed\b/i)).toBeNull();
  });

  it("absent eligibility is 'unknown', never yes; absent analysis identity blocks decisions", () => {
    render(
      <RecommendationPanel
        sourceGuild="root"
        sourceKind="run"
        sourceId="run-a"
        sourceAnalysisId={null}
        sourceInputHash={null}
        decisionEligible={undefined}
        recommendations={[{ id: "rec-1", source_id: "run-a", source_analysis_id: "an-1", scope: "plugin", kind: "workflow", status: "proposed", proposed_action: "Tighten prompt", confidence: "low", severity: "low", evidence_refs: [] }]}
      />,
    );
    expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("the analysis identity is not reported");
    expect(screen.getByRole("button", { name: "Accept…" })).toHaveAttribute("aria-disabled", "true");
    mountDetail({ ...STATES.succeeded, freshness: { state: "current", reason: null } });
    expect(screen.getByTestId("decision-eligible")).toHaveTextContent("unknown");
  });
});

// ---- E03-AC2: surfaces that must not survive (characterized findings) ----

const TARGETS = {
  targets: [
    { id: "run:root:run-a", kind: "run", source_guild: "root", label: "root · run-a", run_ids: ["run-a"], run_count: 1, comparison_eligible: true, reasons: [] },
    { id: "run:root:run-b", kind: "run", source_guild: "root", label: "root · run-b", run_ids: ["run-b"], run_count: 1, comparison_eligible: true, reasons: [] },
  ],
  total: 2,
  sources: [],
};

function mountCompare() {
  return render(
    <MemoryRouter initialEntries={["/compare?baseline=run%3Aroot%3Arun-a&candidate=run%3Aroot%3Arun-b"]}>
      <ComparePage />
    </MemoryRouter>,
  );
}

describe("legacy and duplicate analysis surfaces", () => {
  // Updated by E-FIX: these two tests asserted the E03 defects (F2 legacy
  // analyzer, F1 unmounted panels). They now assert the fixed behavior.
  it("E03-F2 fixed: live Compare has one 'Analyze baseline' control, a C-JOBS job; no legacy /api/project/analyze", async () => {
    const calls = installFetch((url, init) => {
      if (url.includes("/project/comparison-targets")) return json(TARGETS);
      if (url.includes("/project/comparison?") || url.includes("/project/comparison/")) return json({ error: "n/a" }, 404);
      if (url.includes("/project/analysis/artifacts")) return json({ artifacts: [], total: 0 });
      if (init?.method === "POST" && url.endsWith("/project/analyze")) {
        return json({
          target: TARGETS.targets[0],
          signals: [],
          actions: [{ label: "Analyze this run with the packaged diagnostic producer", command: "/guild:maintain analyze run run-a", intent: "reflect" }],
        });
      }
      return undefined;
    });
    const user = userEvent.setup();
    mountCompare();
    await screen.findByTestId("diagnostic-section");
    const buttons = screen.getAllByRole("button", { name: "Analyze baseline" });
    expect(buttons).toHaveLength(1);
    const row = screen.getByTestId("analysis-action-analyze-baseline");
    expect(within(row).getByTestId("analysis-job-panel")).toContainElement(buttons[0]);
    await user.click(buttons[0]);
    expect(screen.queryByTestId("analysis-panel")).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/project/analyze"))).toBe(false);
  });

  it("E03-F1 fixed: ready analysis actions mount the job panel and the recommendation panel", async () => {
    installFetch((url) => {
      if (url.includes("/project/analysis/artifacts")) return json(STATES.succeeded);
      if (url.includes("/api/runs/")) return json({ error: "run not found" }, 404);
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={["/runs/run-a?guild=root"]}>
        <Routes>
          <Route path="/runs/:run_id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const row = await screen.findByTestId("analysis-action-analyze-run");
    await waitFor(() => expect(row).toHaveAttribute("data-action-state", "ready"));
    expect(row).not.toHaveTextContent("Ready for the analysis job panel");
    const panel = within(row).getByTestId("analysis-job-panel");
    expect(within(panel).getByRole("button", { name: "Analyze this run" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByTestId("recommendation-panel")).toBeInTheDocument();
  });

  it("Compare selectors: no artifacts is an explicit empty state; a partial artifact is labeled partial", async () => {
    const partial = { ...STATES.partial.summary, id: "run-a" };
    let artifacts: unknown[] = [];
    installFetch((url) => {
      if (url.includes("/project/comparison-targets")) return json(TARGETS);
      if (url.includes("/project/analysis/artifacts?")) return json({ ...STATES.partial, summary: partial });
      if (url.includes("/project/analysis/artifacts")) return json({ artifacts, total: artifacts.length });
      return undefined;
    });
    const first = mountCompare();
    expect(await screen.findByTestId("analysis-artifacts-empty")).toHaveTextContent("No analysis artifacts yet.");
    first.unmount();
    artifacts = [partial];
    const user = userEvent.setup();
    mountCompare();
    const select = await screen.findByLabelText("Analysis artifact");
    expect(within(select).getByRole("option", { name: "root · run-a (partial)" })).toBeInTheDocument();
    await user.selectOptions(select, "run|root|run-a");
    await waitFor(() => expect(screen.getByTestId("analysis-freshness")).toHaveAttribute("data-validation", "partial"));
    // Independent-group scope with no id is disabled with a reason.
    await user.selectOptions(screen.getByLabelText("Analysis scope"), "independent");
    expect(screen.getByTestId("analysis-action-analyze-independent")).toHaveTextContent("Disabled: enter an independent group id");
    await act(async () => {});
  });
});
