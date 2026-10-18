// RunDetailPage.test.tsx
//
// Surface tests + P3 polling-contract tests. The P3 contract is:
//   - useRunStatus polls GET /api/runs/<id> every 2s while the run.json's
//     status is non-terminal.
//   - When status becomes terminal (pass | fail | timeout | errored), the
//     interval clears and no further fetches fire.
//   - On unmount, the interval is cleared (no fetches after teardown).
//   - While polling, the page shows a `data-testid="run-in-progress-banner"`
//     "Run in progress…" banner; once terminal, the banner is gone.
//
// We use vitest fake timers for polling tests — `toFake: ["setInterval",
// "clearInterval", "setTimeout", "clearTimeout"]` so React's microtasks and
// `queueMicrotask` keep working. Each `vi.advanceTimersByTimeAsync(2000)`
// drains the interval tick + the setState chain that follows useFetch's
// resolved promise.

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunDetailPage from "../routes/RunDetailPage";
import runDetailFixture from "./fixtures/run-detail.json";
import { installMockFetch } from "./fixtures/mockFetch";

function mount(runId = "sample-pass-001") {
  return render(
    <MemoryRouter initialEntries={[`/runs/${runId}`]}>
      <Routes>
        <Route path="/runs/:run_id" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetailPage — surface", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("renders the score card, stages, components, artifacts, and metadata", async () => {
    handle = installMockFetch();
    mount();

    expect(
      screen.getByRole("heading", { level: 1 }),
    ).toHaveTextContent("sample-pass-001");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Score components" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("missing_artifact")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stages" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Run metadata" })).toBeInTheDocument();
    expect(screen.getByTestId("loop-rounds-per-lane")).toHaveTextContent(
      "T3a-backend-config: 2",
    );
  });

  // v1.1 — auth_identity_hash badge surface. The field is forensic-only
  // (architect default, security-review-p4 R8) — show 7-char prefix with
  // the full hash in the title attribute. Absent field = no badge.
  it("renders an auth_identity_hash badge when the field is present", async () => {
    const fixtureWithHash = {
      ...runDetailFixture,
      run: {
        ...runDetailFixture.run,
        auth_identity_hash:
          "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      },
    };
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify(fixtureWithHash), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    mount();
    const badge = await screen.findByTestId("auth-identity-hash-badge");
    expect(badge).toHaveTextContent("a1b2c3d…");
    expect(badge.getAttribute("title")).toBe(
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
    );
  });

  it("does not render the auth_identity_hash badge when the field is absent", async () => {
    handle = installMockFetch();
    mount();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run metadata" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("auth-identity-hash-badge")).toBeNull();
  });

  // v1.4 — F-7: model_family chip surface. Derived by the scorer from
  // `model_ref.default` and emitted on `score.model_family` (haiku/sonnet/
  // opus/unknown). Absent on pre-v1.4 runs whose score.json predates the
  // field — that path renders no chip (backwards compatible).
  it("renders a model_family chip when the field is present on the score", async () => {
    const fixtureWithFamily = {
      ...runDetailFixture,
      score: {
        ...runDetailFixture.score,
        model_family: "sonnet",
      },
    };
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify(fixtureWithFamily), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    mount();
    const chip = await screen.findByTestId("model-family-chip");
    expect(chip).toHaveTextContent("sonnet");
  });

  it("does not render the model_family chip when the field is absent", async () => {
    handle = installMockFetch();
    mount();
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Run metadata" }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("model-family-chip")).toBeNull();
  });

  it("surfaces an error state when the detail fetch fails", async () => {
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify({ error: "run not found" }), {
              status: 404,
              statusText: "Not Found",
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    mount();
    // The diagnostics section may add its own alert once the 404 lands.
    expect((await screen.findAllByRole("alert"))[0]).toHaveTextContent("404");
  });
});

// ---------------------------------------------------------------------------
// P3 polling contract — useRunStatus drives a 2s interval refetch while
// the run is non-terminal. We mount the page (which uses the hook) and
// observe fetch-call count + banner visibility through real timer advances.
// ---------------------------------------------------------------------------

describe("RunDetailPage — polling contract (useRunStatus integration)", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
  });

  afterEach(() => {
    handle?.reset();
    vi.useRealTimers();
  });

  // Build a non-terminal RunDetailResponse from the existing fixture so the
  // hook decides to poll. Status "running" is non-terminal — TERMINAL_STATUSES
  // = pass | fail | timeout | errored (useRunStatus.ts).
  function nonTerminalDetail() {
    return {
      ...runDetailFixture,
      run: { ...runDetailFixture.run, status: "running" },
    };
  }

  function terminalDetail() {
    return {
      ...runDetailFixture,
      run: { ...runDetailFixture.run, status: "pass" },
    };
  }

  // Drain the pending microtask + state update queue. Fake timers stub
  // setTimeout, so testing-library's `waitFor`/`findBy*` helpers can't poll;
  // we instead advance fake time inside `act()` and read the DOM
  // synchronously. Two zero-advances cover (a) the fetch promise resolving
  // and (b) the resulting setState's effect commit.
  async function flushFetchAndEffects() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("shows the 'Run in progress…' banner while status is non-terminal", async () => {
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify(nonTerminalDetail()), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    mount();

    await flushFetchAndEffects();

    const banner = screen.getByTestId("run-in-progress-banner");
    expect(banner).toHaveTextContent(/Run in progress/i);
  });

  it("hides the polling banner once the run reaches a terminal status", async () => {
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify(terminalDetail()), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    mount();

    await flushFetchAndEffects();

    // Status fixture is "pass" → terminal → no polling banner.
    expect(screen.queryByTestId("run-in-progress-banner")).not.toBeInTheDocument();
  });

  it("fires GET /api/runs/<id> every 2s while non-terminal", async () => {
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify(nonTerminalDetail()), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    mount();

    // Initial fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const detailCallsAfterInitial = handle.fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("/api/runs/sample-pass-001"),
    ).length;
    expect(detailCallsAfterInitial).toBe(1);

    // Tick #1 at 2_000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const after1 = handle.fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("/api/runs/sample-pass-001"),
    ).length;
    expect(after1).toBe(2);

    // Tick #2 at 4_000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const after2 = handle.fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("/api/runs/sample-pass-001"),
    ).length;
    expect(after2).toBe(3);
  });

  it("stops polling once a terminal status response arrives", async () => {
    // First response: non-terminal. Second response (after 2s): terminal.
    let calls = 0;
    handle = installMockFetch({
      override: (url) => {
        if (!url.includes("/api/runs/sample-pass-001")) return undefined;
        calls += 1;
        const body = calls >= 2 ? terminalDetail() : nonTerminalDetail();
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);

    // First poll tick — fetches the terminal payload, hook flips isPolling.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(calls).toBe(2);

    // After becoming terminal, advancing time another 6s must NOT fire more
    // fetches (interval was cleared via the cleanup of the polling effect).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(calls).toBe(2);

    // Drain one more microtask cycle so the terminal-status setState commits,
    // then assert banner is gone.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("run-in-progress-banner")).not.toBeInTheDocument();
  });

  it("clears the polling interval on unmount (no fetches after teardown)", async () => {
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/runs/sample-pass-001")
          ? new Response(JSON.stringify(nonTerminalDetail()), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : undefined,
    });
    const { unmount } = mount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const detailCalls = () =>
      handle!.fetchSpy.mock.calls.filter(([u]) =>
        String(u).includes("/api/runs/sample-pass-001"),
      ).length;
    expect(detailCalls()).toBe(1);

    // Tick once to confirm polling is active.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(detailCalls()).toBe(2);

    // Unmount — interval should be cleared. Advancing time further must
    // produce zero new fetches.
    unmount();
    const beforeAdvance = detailCalls();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(detailCalls()).toBe(beforeAdvance);
  });
});

// ---------------------------------------------------------------------------
// E01 — evidence-first diagnostic analysis. Payloads transcribe the D01
// contract fixture benchmark/tests/analysis-contract-fixtures/run-analysis.json
// (feature/v3c-team-d-benchmark-api @ 96d2ab2) wrapped in the D01
// ProjectAnalysisArtifactDetailResponse shape.
// ---------------------------------------------------------------------------

const RUN_ID = "sample-pass-001";
const REF = (line: number, run = RUN_ID) => `.guild/runs/${run}/logs/v1.4-events.jsonl#line:${line}`;

function runArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "guild.run_analysis.v1",
    analysis_id: `analysis:${RUN_ID}:1b4f1c74f378`,
    run_id: RUN_ID,
    source_hash: "1b4f1c74f378d71d89f706b4e019468486321894419facec6c7661b48370628a",
    eligible: true,
    identity: {
      run_scope: "independent",
      initiative_id: null,
      independent_group_id: "plan-fixtures",
      host: "codex",
      phase: "build",
    },
    completeness: {
      score: 100,
      present: [
        "agent", "close", "gate", "loop", "phase", "plugin-config-snapshot.json",
        "prompt", "run identity", "tool", "trace parseability", "trace validity",
      ],
      missing: [],
    },
    assessments: {
      instruction_following: { status: "satisfied", evidence_refs: [REF(1)] },
      prompt_efficiency: { status: "violated", evidence_refs: [REF(2)] },
      workflow: { status: "ambiguous", evidence_refs: [REF(4)] },
      tool_coverage: { status: "unobservable", evidence_refs: [] },
    },
    usage: {
      llm_event_count: 2,
      tokens: { input: 10, output: 5, cached: 0, total: 15, cost_usd: 0 },
      duration_ms: 12,
    },
    findings: [
      {
        id: "finding-f0aead720917319c",
        kind: "repeated_failure",
        severity: "high",
        summary: "The same failed action recurred 2 times.",
        evidence_refs: [REF(8), REF(9)],
        signature: "Bash|fixture failing check|fixture error",
      },
    ],
    recommendations: [],
    ...overrides,
  };
}

function runDetailResponse(opts: {
  artifact?: Record<string, unknown> | undefined;
  validation?: string;
  freshness?: Record<string, unknown>;
  id?: string;
} = {}) {
  const id = opts.id ?? RUN_ID;
  return {
    summary: {
      kind: "run",
      id,
      source_guild: "plugin",
      analysis_id: `analysis:${id}:1b4f1c74f378`,
      schema_version: "guild.run_analysis.v1",
      artifact_eligible: true,
      validation: opts.validation ?? "valid",
      invalid_recommendation_rows: 0,
      recommendation_count: 0,
      finding_count: 1,
      path: `/abs/project/.guild/analysis/runs/${id}`,
    },
    ...("artifact" in opts ? (opts.artifact ? { artifact: opts.artifact } : {}) : { artifact: runArtifact() }),
    recommendations: [
      {
        schema_version: "guild.recommendation.v1",
        id: "rec-a6e61633056fba7d",
        source_id: id,
        source_analysis_id: `analysis:${id}:1b4f1c74f378`,
        status: "proposed",
        confidence: "high",
        requires_user_approval: true,
        evidence_refs: [REF(8, id), REF(9, id)],
        proposed_action: "The same failed action recurred 2 times.",
      },
    ],
    invalid_recommendation_lines: 0,
    freshness: opts.freshness ?? { state: "current", reason: null, decision_eligible: true },
  };
}

function mountWithAnalysis(body: unknown, status = 200, runId = RUN_ID) {
  const handle = installMockFetch({
    override: (url) =>
      url.includes("/api/project/analysis/artifacts")
        ? new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          })
        : undefined,
  });
  mount(runId);
  return handle;
}

describe("RunDetailPage — E01 diagnostic analysis", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("E01-AC1: renders the 4 assessment statuses distinctly", async () => {
    handle = mountWithAnalysis(runDetailResponse());
    await screen.findByTestId("analysis-detail");
    const pill = (key: string) =>
      screen.getByTestId(`assessment-${key}`).querySelector("[data-assessment]") as HTMLElement;
    const seen = ["instruction_following", "prompt_efficiency", "workflow", "tool_coverage"].map((k) => [
      pill(k).getAttribute("data-assessment"),
      pill(k).getAttribute("data-status"),
      pill(k).textContent,
    ]);
    expect(seen).toEqual([
      ["satisfied", "pass", "Satisfied"],
      ["violated", "fail", "Violated"],
      ["ambiguous", "timeout", "Ambiguous"],
      ["unobservable", "errored", "Unobservable"],
    ]);
    // Benchmark scoring stays a separate concept beside the diagnostics.
    expect(screen.getByRole("heading", { name: "Score components" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Diagnostic analysis" })).toBeInTheDocument();
    expect(screen.getByTestId("completeness")).toHaveTextContent("not a quality score");
    expect(screen.getByTestId("completeness-score")).toHaveTextContent("100%");
    expect(screen.getByTestId("completeness")).toHaveTextContent("11 of 11 evidence parts present");
  });

  it("E01-AC1 negative: missing fields render 'not reported', never zero or success", async () => {
    const partial = runArtifact({
      completeness: undefined,
      assessments: { workflow: { status: "ambiguous", evidence_refs: [] } },
      findings: undefined,
      identity: undefined,
    });
    delete partial.completeness;
    delete partial.findings;
    delete partial.identity;
    handle = mountWithAnalysis(runDetailResponse({ artifact: partial }));
    const detail = await screen.findByTestId("analysis-detail");

    expect(screen.queryByTestId("completeness-score")).toBeNull();
    expect(screen.getByTestId("completeness")).toHaveTextContent("not reported");
    expect(detail).not.toHaveTextContent(/\b0%/);
    for (const key of ["instruction_following", "prompt_efficiency", "tool_coverage"]) {
      const p = screen.getByTestId(`assessment-${key}`).querySelector("[data-assessment]");
      expect(p).toHaveAttribute("data-assessment", "not_reported");
      expect(p).not.toHaveAttribute("data-status");
    }
    expect(detail.querySelectorAll('[data-assessment="satisfied"]').length).toBe(0);
    // Legacy usage without availability: stored zeros are not measurements.
    const usage = screen.getByTestId("usage");
    expect(usage.querySelector('[data-usage-unknown="cached"]')).toHaveTextContent(
      "stored total 0 is not a measurement",
    );
    expect(usage.querySelector('[data-usage-unknown="cost_usd"]')).toHaveTextContent("legacy_unknown");
  });

  it("E01-AC1: usage availability distinguishes complete, partial and unobserved", async () => {
    const artifact = runArtifact({
      usage: {
        tokens: { input: 10, output: 5, cached: 0, total: 15, cost_usd: 0 },
        duration_ms: 12,
        availability: {
          input: { state: "complete", evidence_refs: [REF(1)], missing_reason: null },
          output: { state: "partial", evidence_refs: [REF(1)], missing_reason: "incomplete_observation" },
          cached: { state: "unobserved", evidence_refs: [], missing_reason: "unwired" },
          cost_usd: { state: "unobserved", evidence_refs: [], missing_reason: "host_unavailable" },
        },
      },
    });
    handle = mountWithAnalysis(runDetailResponse({ artifact }));
    const usage = await screen.findByTestId("usage");
    expect(usage).toHaveTextContent("observed subtotal");
    expect(usage.querySelector('[data-usage-unknown="input"]')).toBeNull();
    expect(usage.querySelector('[data-usage-unknown="cached"]')).toHaveTextContent("unwired");
    expect(usage.querySelector('[data-usage-unknown="cost_usd"]')).toHaveTextContent("host_unavailable");
    expect(usage.querySelector('[data-usage-unknown="duration_ms"]')).toHaveTextContent("unobserved");
  });

  it("E01-AC3: evidence refs link only to contained reported runs; unsafe refs stay plain text", async () => {
    const unsafe = [
      "file:///etc/passwd",
      "/etc/passwd",
      "https://example.com/x",
      `.guild/runs/${RUN_ID}/../../../etc/passwd`,
      `.guild/runs/${RUN_ID}/logs\\..\\secret`,
      ".guild/runs/other-run/logs/v1.4-events.jsonl#line:1",
      "../.guild/runs/x/y",
    ];
    const artifact = runArtifact({
      findings: [
        { id: "f1", kind: "repeated_failure", severity: "high", summary: "s", evidence_refs: [REF(8), ...unsafe] },
      ],
    });
    handle = mountWithAnalysis(runDetailResponse({ artifact }));
    await screen.findByTestId("analysis-detail");

    const finding = screen.getByTestId("analysis-finding");
    const links = finding.querySelectorAll("a");
    expect(links.length).toBe(2);
    // The contained ref opens the file through the project-run artifact
    // route and hands the ref to the run overview.
    const fileLink = finding.querySelector('[data-testid="evidence-file-link"]') as HTMLAnchorElement;
    expect(fileLink.getAttribute("href")).toBe(
      `/api/project/runs/${RUN_ID}/artifacts/logs/v1.4-events.jsonl?guild=plugin`,
    );
    const overview = finding.querySelector('[data-testid="evidence-link"]') as HTMLAnchorElement;
    expect(overview.getAttribute("href")).toBe(
      `/project-runs/${RUN_ID}?guild=plugin&ref=${encodeURIComponent("logs/v1.4-events.jsonl")}`,
    );
    expect(overview).toHaveAttribute("data-ref-path", "logs/v1.4-events.jsonl");
    const ref = finding.querySelector('[data-testid="evidence-ref"]') as HTMLDetailsElement;
    expect(ref.querySelector("summary")).toHaveTextContent(REF(8));
    const panel = ref.querySelector('[data-testid="evidence-ref-panel"]') as HTMLElement;
    expect(panel).toHaveTextContent(`Run${RUN_ID}`);
    expect(panel).toHaveTextContent("Pathlogs/v1.4-events.jsonl");
    expect(panel.querySelector('[data-testid="evidence-ref-line"]')).toHaveTextContent("8");
    expect(panel).toHaveTextContent(`Reference${REF(8)}`);
    expect(finding.querySelectorAll('[data-testid="evidence-unlinked"]').length).toBe(unsafe.length);
    for (const a of Array.from(document.querySelectorAll("a"))) {
      const href = a.getAttribute("href") ?? "";
      expect(href).not.toMatch(/^(file|https?|javascript):/i);
      expect(href).not.toContain("..");
    }
    // The server-local artifact path is never rendered.
    expect(document.body).not.toHaveTextContent("/abs/project/.guild/analysis");
  });

  it("503 analysis_package_unconfigured disables actions with an explanation, no fake data", async () => {
    handle = mountWithAnalysis(
      {
        error: "analysis_package_unconfigured",
        hint: "start serve with --guild-plugin-package <absolute-packaged-plugin-root>",
      },
      503,
    );
    expect(await screen.findByTestId("analysis-unconfigured")).toHaveTextContent(
      "--guild-plugin-package <absolute-packaged-plugin-root>",
    );
    expect(screen.queryByTestId("analysis-detail")).toBeNull();
    expect(screen.queryByTestId("analysis-error")).toBeNull();
    for (const key of ["analyze-run", "inspect-run"]) {
      const row = screen.getByTestId(`analysis-action-${key}`);
      expect(row).toHaveAttribute("data-action-state", "disabled");
      expect(row).toHaveTextContent("Disabled: analysis package is not configured");
    }
  });

  it("HTTP 200 with a non-actionable freshness disables actions", async () => {
    for (const state of ["unavailable", "error", "refused", "unsupported"]) {
      handle = mountWithAnalysis(runDetailResponse({ freshness: { state, reason: `why-${state}` } }));
      expect(await screen.findByTestId("analysis-freshness")).toHaveAttribute("data-freshness", state);
      for (const key of ["analyze-run", "inspect-run"]) {
        const row = screen.getByTestId(`analysis-action-${key}`);
        expect(row).toHaveAttribute("data-action-state", "disabled");
        expect(row).toHaveTextContent(`Disabled: analysis freshness is ${state} (why-${state})`);
      }
      handle.reset();
      cleanup();
    }
    handle = mountWithAnalysis(runDetailResponse({ validation: "wrong_source" }));
    const row = await screen.findByTestId("analysis-action-analyze-run");
    await waitFor(() => expect(row).toHaveTextContent("Disabled: analysis artifact is wrong_source"));
    expect(row).toHaveAttribute("data-action-state", "disabled");
  });

  it("E01-F4: a malformed 200 envelope renders a malformed state, never a crash", async () => {
    const broken: unknown[] = [
      {},
      { ...runDetailResponse(), summary: { kind: "run" } },
      { ...runDetailResponse(), freshness: undefined },
      { ...runDetailResponse(), recommendations: "nope" },
      { ...runDetailResponse(), summary: { ...runDetailResponse().summary, validation: "bogus" } },
    ];
    for (const body of broken) {
      handle = mountWithAnalysis(body);
      expect(await screen.findByTestId("analysis-malformed")).toBeInTheDocument();
      expect(screen.queryByTestId("analysis-detail")).toBeNull();
      expect(screen.getByTestId("analysis-action-analyze-run")).toHaveAttribute("data-action-state", "disabled");
      handle.reset();
      cleanup();
    }
    handle = installMockFetch({
      override: (url) =>
        url.includes("/api/project/analysis/artifacts")
          ? new Response("not json{", { status: 200, headers: { "content-type": "application/json" } })
          : undefined,
    });
    mount();
    expect(await screen.findByTestId("analysis-malformed")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-action-inspect-run")).toHaveTextContent("analysis response is malformed");
  });

  it("E01-F1: diagnostics load for a live run with no benchmark record", async () => {
    const LIVE = "run-20261017-160817-live";
    handle = installMockFetch({
      override: (url) => {
        if (url.includes("/api/project/analysis/artifacts")) {
          return new Response(
            JSON.stringify(runDetailResponse({ id: LIVE, artifact: runArtifact({ run_id: LIVE }) })),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes(`/api/runs/${LIVE}`)) {
          return new Response(JSON.stringify({ error: "run not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });
    mount(LIVE);
    // Mounted job panels add their own (empty) alert regions.
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /404/.test(a.textContent ?? ""))).toBe(true));
    expect(await screen.findByTestId("analysis-detail")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Score components" })).toBeNull();
    const row = screen.getByTestId("analysis-action-analyze-run");
    expect(row).toHaveAttribute("data-action-state", "ready");
    expect(handle.calls.some((c) => c.url.includes(`kind=run&id=${LIVE}`))).toBe(true);
  });

  it("E01-F1 r2: route change from a polling benchmark run to a live-404 run shows diagnostics", async () => {
    const LIVE = "run-20261017-160817-live";
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    handle = installMockFetch({
      override: (url) => {
        if (url.includes("/api/project/analysis/artifacts")) {
          return url.includes(`id=${LIVE}`)
            ? json(runDetailResponse({ id: LIVE, artifact: runArtifact({ run_id: LIVE }) }))
            : json(runDetailResponse());
        }
        if (url.includes(`/api/runs/${LIVE}`)) return json({ error: "run not found" }, 404);
        if (url.includes(`/api/runs/${RUN_ID}`)) {
          return json({ ...runDetailFixture, run: { ...runDetailFixture.run, status: "running" } });
        }
        return undefined;
      },
    });
    render(
      <MemoryRouter initialEntries={[`/runs/${RUN_ID}`]}>
        <Link to={`/runs/${LIVE}`}>go live</Link>
        <Routes>
          <Route path="/runs/:run_id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: "Score components" })).toBeInTheDocument();
    expect(screen.queryByTestId("run-diagnostics")).toBeNull();

    await userEvent.click(screen.getByText("go live"));
    // Mounted job panels add their own (empty) alert regions.
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /404/.test(a.textContent ?? ""))).toBe(true));
    const detail = await screen.findByTestId("analysis-detail");
    expect(detail).toHaveTextContent(LIVE);
    // The previous run's benchmark data is not shown under the new id.
    expect(screen.queryByRole("heading", { name: "Score components" })).toBeNull();
    expect(handle.calls.some((c) => c.url.includes(`kind=run&id=${LIVE}`))).toBe(true);
  });

  it("E01-F4 r2: '__proto__' and unknown freshness render unsupported, never a crash", async () => {
    for (const state of ["__proto__", "constructor", "toString", "brand-new-state"]) {
      handle = mountWithAnalysis(runDetailResponse({ freshness: { state, reason: null } }));
      const notice = await screen.findByTestId("analysis-freshness");
      expect(notice).toHaveAttribute("data-freshness", "unsupported");
      expect(notice).toHaveTextContent("Unsupported: the diagnostics contract is not supported.");
      expect(screen.getByTestId("freshness-unrecognized")).toHaveTextContent(state);
      const row = screen.getByTestId("analysis-action-analyze-run");
      expect(row).toHaveAttribute("data-action-state", "disabled");
      expect(row).toHaveTextContent("Disabled: analysis freshness is unsupported");
      handle.reset();
      cleanup();
    }
    const artifact = runArtifact({
      assessments: { workflow: { status: "__proto__", evidence_refs: [] } },
    });
    handle = mountWithAnalysis(runDetailResponse({ artifact }));
    await screen.findByTestId("analysis-detail");
    expect(screen.getByTestId("assessment-workflow").querySelector("[data-assessment]")).toHaveAttribute(
      "data-assessment",
      "unrecognized",
    );
  });

  it("ready actions state the exact C-JOBS request", async () => {
    handle = mountWithAnalysis(runDetailResponse());
    const row = await screen.findByTestId("analysis-action-analyze-run");
    await waitFor(() => expect(row).toHaveAttribute("data-action-state", "ready"));
    expect(row).toHaveTextContent(
      JSON.stringify({ source_guild: "plugin", operation: "analyze", target_kind: "run", ids: [RUN_ID] }),
    );
  });

  it("stale, missing, unsupported and malformed states are explicit", async () => {
    handle = mountWithAnalysis(
      runDetailResponse({ freshness: { state: "stale", reason: "source_hash changed", decision_eligible: false } }),
    );
    let notice = await screen.findByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "stale");
    expect(notice).toHaveTextContent("Re-run analysis");
    expect(notice).toHaveTextContent("source_hash changed");
    expect(screen.getByTestId("decision-eligible")).toHaveTextContent("no");
    handle.reset();
    cleanup();

    handle = mountWithAnalysis(
      runDetailResponse({ artifact: undefined, validation: "absent", freshness: { state: "missing", reason: null } }),
    );
    notice = await screen.findByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "missing");
    expect(screen.queryByTestId("analysis-scope")).toBeNull();
    handle.reset();
    cleanup();

    handle = mountWithAnalysis(
      runDetailResponse({ validation: "malformed", freshness: { state: "unsupported", reason: "diagnostics v9" } }),
    );
    notice = await screen.findByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "unsupported");
    expect(notice).toHaveTextContent("No new conclusions");
    expect(notice).toHaveTextContent("Malformed");
    // A refused artifact never shows findings, even if a body slipped through.
    expect(screen.queryByTestId("analysis-finding")).toBeNull();
  });

  it("E01-AC2: long ids render in full and wrap at 320px", async () => {
    const longId = `run-${"a1b2c3d4".repeat(15)}-x`.slice(0, 128);
    window.innerWidth = 320;
    handle = mountWithAnalysis(
      runDetailResponse({ id: longId, artifact: runArtifact({ run_id: longId, assessments: {} }) }),
      200,
      longId,
    );
    const scope = await screen.findByTestId("analysis-scope");
    const code = Array.from(scope.querySelectorAll("code")).find((c) => c.textContent === longId);
    expect(code).toBeDefined();
    expect(code!.style.overflowWrap).toBe("anywhere");
    expect(scope.style.overflowWrap).toBe("anywhere");
    expect(screen.getByTestId("analysis-detail").style.overflowWrap).toBe("anywhere");
  });

  it("refuses to request analysis for an unsupported run id", async () => {
    handle = installMockFetch();
    mount("bad@id");
    expect(await screen.findByTestId("analysis-unsupported-id")).toBeInTheDocument();
    expect(handle.calls.some((c) => c.url.includes("/project/analysis/"))).toBe(false);
    expect(screen.getByTestId("analysis-action-analyze-run")).toHaveAttribute("data-action-state", "disabled");
  });
});


// ---- E-FIX (E03 F1/F5/F6): mounted job + recommendation panels ------------

function jobView(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "job-1",
    source_guild: "plugin",
    operation: "analyze",
    state: "queued",
    created_at: "2026-10-18T00:00:00Z",
    started_at: null,
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

function mountWithJobs(detail: unknown) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const handle = installMockFetch({
    override: (url, init) => {
      if (url.includes("/api/project/analysis/artifacts")) return json(detail);
      if (url.endsWith("/project/analysis/session")) return json({ action_token: "tok" });
      if (init?.method === "POST" && url.endsWith("/project/analysis/jobs")) {
        const body = JSON.parse(String(init.body));
        posts.push({ url, body });
        return json(jobView({ operation: body.operation }), 202);
      }
      return undefined;
    },
  });
  mount();
  return { handle, posts };
}

describe("RunDetailPage — E-FIX mounted analysis panels", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("F1: the analyze action mounts a job panel that submits the exact E01 request", async () => {
    const m = mountWithJobs(runDetailResponse());
    handle = m.handle;
    const row = await screen.findByTestId("analysis-action-analyze-run");
    await waitFor(() => expect(row).toHaveAttribute("data-action-state", "ready"));
    const start = within(within(row).getByTestId("analysis-job-panel")).getByRole("button", { name: "Analyze this run" });
    expect(start).not.toHaveAttribute("aria-disabled");
    await userEvent.click(start);
    await waitFor(() => expect(m.posts).toHaveLength(1));
    expect(m.posts[0].body).toMatchObject({
      source_guild: "plugin",
      operation: "analyze",
      target_kind: "run",
      ids: [RUN_ID],
      idempotency_key: expect.stringMatching(/^ui-/),
    });
    // Inspect is not a job: no panel, no submit control.
    expect(within(screen.getByTestId("analysis-action-inspect-run")).queryByTestId("analysis-job-panel")).toBeNull();
  });

  it("F1: a blocked action keeps the panel start control gated and sends no job", async () => {
    const m = mountWithJobs(runDetailResponse({ freshness: { state: "unavailable", reason: null } }));
    handle = m.handle;
    const row = await screen.findByTestId("analysis-action-analyze-run");
    await waitFor(() => expect(row).toHaveTextContent("Disabled: analysis freshness is unavailable"));
    const start = within(row).getByRole("button", { name: "Analyze this run" });
    expect(start).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(start);
    expect(m.posts).toHaveLength(0);
  });

  it("F1: the recommendation panel is mounted and sends the input hash exactly as reported", async () => {
    const hash = `sha256:${"ab".repeat(32)}`;
    const body = runDetailResponse({ artifact: runArtifact({ diagnostics: { input_hash: hash } }) });
    // The D01 fixture row (run-analysis.json) also carries scope, kind and severity.
    Object.assign(body.recommendations[0], { scope: "project", kind: "clarify_prompt_contract", severity: "high" });
    const m = mountWithJobs(body);
    handle = m.handle;
    const panel = await screen.findByTestId("recommendation-panel");
    await userEvent.click(within(panel).getByRole("button", { name: "Accept…" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(m.posts).toHaveLength(1));
    expect(m.posts[0].body).toMatchObject({
      operation: "recommendation_decide",
      target_kind: "run",
      ids: [RUN_ID],
      recommendation_id: "rec-a6e61633056fba7d",
      source_analysis_id: `analysis:${RUN_ID}:1b4f1c74f378`,
      source_input_hash: hash,
    });
  });

  it("F6: explains why artifact and decision eligibility differ", async () => {
    const body = runDetailResponse();
    body.summary.artifact_eligible = false;
    handle = mountWithAnalysis(body);
    const note = await screen.findByTestId("eligibility-note");
    expect(note).toHaveTextContent("Artifact eligibility comes from freshness and validation.");
    expect(screen.getByTestId("artifact-eligible")).toHaveTextContent("no");
    expect(screen.getByTestId("decision-eligible")).toHaveTextContent("yes");
  });

  it("F6: no note when both eligibilities agree", async () => {
    handle = mountWithAnalysis(runDetailResponse());
    await screen.findByTestId("analysis-detail");
    expect(screen.queryByTestId("eligibility-note")).toBeNull();
  });

  it("F5: the unconfigured banner says 'start serve with' at most once", async () => {
    handle = mountWithAnalysis(
      { error: "analysis_package_unconfigured", hint: "start serve with --guild-plugin-package <abs>" },
      503,
    );
    const banner = await screen.findByTestId("analysis-unconfigured");
    expect(banner).toHaveTextContent("Start the server with --guild-plugin-package <abs>.");
    expect((banner.textContent ?? "").match(/serve(r)? with/gi)).toHaveLength(1);
  });
});
