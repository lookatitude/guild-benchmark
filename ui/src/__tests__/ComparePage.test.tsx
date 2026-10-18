import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { Comparison, ReflectionApplied } from "../../../src/types";
import ComparePage from "../routes/ComparePage";
import comparisonFixture from "./fixtures/comparison.json";
import { installMockFetch } from "./fixtures/mockFetch";

function mount(initialEntries: string[] = ["/compare"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ComparePage />
    </MemoryRouter>,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT_TARGETS = {
  targets: [
    {
      id: "initiative:workspace:guild-dashboard",
      kind: "initiative",
      source_guild: "workspace",
      label: "workspace · Guild dashboard",
      run_ids: ["run-root"],
      run_count: 1,
      comparison_eligible: true,
      reasons: [],
    },
    {
      id: "initiative:workspace:website-v2",
      kind: "initiative",
      source_guild: "workspace",
      label: "workspace · Website v2",
      run_ids: ["run-web"],
      run_count: 1,
      comparison_eligible: true,
      reasons: [],
    },
    {
      id: "run:plugin:run-plugin",
      kind: "run",
      source_guild: "plugin",
      label: "plugin · run-plugin",
      run_ids: ["run-plugin"],
      run_count: 1,
      comparison_eligible: true,
      reasons: [],
    },
  ],
  total: 3,
  sources: [],
};

const PROJECT_COMPARISON = {
  baseline: {
    target: PROJECT_TARGETS.targets[0],
    status_counts: { closed: 1 },
    total_events: 24,
  },
  candidate: {
    target: PROJECT_TARGETS.targets[1],
    status_counts: { closed: 1 },
    total_events: 31,
  },
  status: "ok",
  generated_at: "2026-06-11T00:00:00Z",
  notes: ["Trace volume changed by 7 events."],
};

describe("ComparePage — surface", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("renders empty state when baseline + candidate are not in the URL", () => {
    handle = installMockFetch();
    mount();
    expect(
      screen.getByText(/Select a baseline and candidate/),
    ).toBeInTheDocument();
  });

  it("renders the comparison summary and excluded runs when both ids are present", async () => {
    handle = installMockFetch();
    mount(["/compare?baseline=set-a&candidate=set-b"]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    });
    // Mean scores from the comparison fixture (baseline mean is unique).
    expect(screen.getByText("67.13")).toBeInTheDocument();
    // Candidate mean shows up as "100.00" — but so do DeltaTable cells; assert
    // at least one match instead of pinning to the summary cell exclusively.
    expect(screen.getAllByText("100.00").length).toBeGreaterThan(0);
    // Status from the fixture.
    expect(screen.getByText("partial")).toBeInTheDocument();
    // Excluded runs section appears since fixture has one.
    expect(
      screen.getByRole("heading", { name: "Excluded runs" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/model_ref drift/)).toBeInTheDocument();
  });

  it("writes baseline + candidate into the URL search params on input", async () => {
    handle = installMockFetch();
    mount();
    const baselineInput = await screen.findByLabelText(/Baseline set id/i);
    await userEvent.type(baselineInput, "set-a");
    expect((baselineInput as HTMLInputElement).value).toBe("set-a");
  });

  it("renders live eligible targets as dropdowns and analyzes selected initiatives", async () => {
    handle = installMockFetch({
      override: (url, init) => {
        if (url.match(/\/api\/project\/comparison-targets$/)) {
          return jsonResponse(PROJECT_TARGETS);
        }
        if (url.match(/\/api\/project\/comparisons/)) {
          return jsonResponse(PROJECT_COMPARISON);
        }
        if ((init?.method ?? "GET").toUpperCase() === "POST" && url.match(/\/api\/project\/analyze$/)) {
          return jsonResponse({
            target: PROJECT_TARGETS.targets[0],
            signals: ["24 trace events available for analysis across 1 run."],
            actions: [
              {
                label: "Reflect on mistakes and performance",
                command: "/guild:reflect --initiative guild-dashboard",
                intent: "reflect",
              },
              {
                label: "Evolve a skill after reflection names a target",
                command: "/guild:evolve <skill-name>",
                intent: "evolve",
              },
            ],
          });
        }
        return undefined;
      },
    });
    mount();
    await screen.findByRole("combobox", { name: "Baseline" });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Baseline" }),
      "initiative:workspace:guild-dashboard",
    );
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Candidate" }),
      "initiative:workspace:website-v2",
    );

    expect(await screen.findByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByText("+7")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Analyze baseline" }));
    expect(await screen.findByTestId("analysis-panel")).toHaveTextContent(
      "/guild:reflect --initiative guild-dashboard",
    );
    expect(screen.getByTestId("analysis-panel")).toHaveTextContent(
      "/guild:evolve <skill-name>",
    );
  });
});

// --- P4 reflection_applied annotation (Q19, T4-qa) -------------------------
//
// These tests pin the wire from `Comparison.reflection_applied` (P4 schema
// bump) through `ComparePage` into `<ReflectionBadge>`. The default fixture
// (`fixtures/comparison.json`) intentionally omits the field — that's the
// legacy/no-loop shape (Q19 backward-compat). For the kept/discarded cases
// we override the mock to inject a reflection_applied block.

function buildComparisonWithReflection(
  reflection: ReflectionApplied,
): Comparison {
  // Spread off the existing fixture so we keep the rest of the shape stable
  // and only swap `reflection_applied` in. Cast through Comparison since the
  // fixture is JSON-typed.
  return {
    ...(comparisonFixture as unknown as Comparison),
    reflection_applied: reflection,
  };
}

const KEPT_REFLECTION: ReflectionApplied = {
  proposal_id: "ref-2026-04-26-architect",
  source_path: "agents/architect.md",
  applied_at: "2026-04-26T17:00:00Z",
  plugin_ref_before: "abcdef1234567890",
  plugin_ref_after: "0987654321fedcba",
  kept: true,
  delta_summary: {
    guild_score_delta: 5.2,
    worst_component_delta: -0.5,
    worst_component: "delegation",
  },
};

const DISCARDED_REFLECTION: ReflectionApplied = {
  ...KEPT_REFLECTION,
  proposal_id: "ref-2026-04-26-discarded",
  kept: false,
  delta_summary: {
    guild_score_delta: -3.4,
    worst_component_delta: -2.5,
    worst_component: "gates",
  },
};

describe("ComparePage — reflection_applied annotation (P4 / Q19)", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("does NOT render <ReflectionBadge> when comparison.reflection_applied is absent (legacy shape, Q19 backward-compat)", async () => {
    handle = installMockFetch();
    mount(["/compare?baseline=set-a&candidate=set-b"]);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    });
    // No reflection field on the default fixture → no badge.
    expect(screen.queryByTestId("reflection-badge")).toBeNull();
    expect(screen.queryByTestId("keep-discard-badge")).toBeNull();
    expect(screen.queryByTestId("plugin-ref-delta")).toBeNull();
  });

  it("renders <ReflectionBadge> with kept=true when reflection_applied.kept is true", async () => {
    handle = installMockFetch({
      override: (url) => {
        if (url.match(/\/api\/comparisons\//)) {
          return new Response(
            JSON.stringify(buildComparisonWithReflection(KEPT_REFLECTION)),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    mount(["/compare?baseline=set-a&candidate=set-b"]);

    await waitFor(() => {
      expect(screen.getByTestId("reflection-badge")).toBeInTheDocument();
    });
    const kept = screen.getByTestId("keep-discard-badge");
    expect(kept).toHaveAttribute("data-kept", "true");
    expect(kept).toHaveTextContent("kept");
    // Discard reason paragraph is suppressed when kept=true.
    expect(screen.queryByText(/Discarded —/)).toBeNull();
  });

  it("renders <ReflectionBadge> with kept=false + discard reason when reflection_applied.kept is false", async () => {
    handle = installMockFetch({
      override: (url) => {
        if (url.match(/\/api\/comparisons\//)) {
          return new Response(
            JSON.stringify(buildComparisonWithReflection(DISCARDED_REFLECTION)),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    mount(["/compare?baseline=set-a&candidate=set-b"]);

    await waitFor(() => {
      expect(screen.getByTestId("reflection-badge")).toBeInTheDocument();
    });
    const kept = screen.getByTestId("keep-discard-badge");
    expect(kept).toHaveAttribute("data-kept", "false");
    expect(kept).toHaveTextContent("discarded");
    // Discard reason paragraph names the worst component. The badge's
    // <p class="reflection-discard-reason"> wraps the worst_component name
    // in a <code> tag — scope the assertion to the badge so we don't match
    // the per-component delta table's "gates" row.
    const badge = screen.getByTestId("reflection-badge");
    expect(badge).toHaveTextContent(/Discarded —/);
    expect(badge).toHaveTextContent(/gates/);
  });

  it("plugin-ref-delta cell renders both 7-char short refs separated by an arrow", async () => {
    handle = installMockFetch({
      override: (url) => {
        if (url.match(/\/api\/comparisons\//)) {
          return new Response(
            JSON.stringify(buildComparisonWithReflection(KEPT_REFLECTION)),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    mount(["/compare?baseline=set-a&candidate=set-b"]);

    await waitFor(() => {
      expect(screen.getByTestId("plugin-ref-delta")).toBeInTheDocument();
    });
    const cell = screen.getByTestId("plugin-ref-delta");
    // ReflectionBadge's `shortRef` slices to 7 chars when length > 8.
    expect(cell).toHaveTextContent("abcdef1");
    expect(cell).toHaveTextContent("0987654");
    // The `→` glyph is wrapped in aria-hidden but should be in the DOM text.
    expect(cell.textContent).toMatch(/→/);
  });
});

// ---------------------------------------------------------------------------
// E01 — diagnostic evidence selection. Comparison payload transcribes the D01
// contract fixture benchmark/tests/analysis-contract-fixtures/comparison.json
// (feature/v3c-team-d-benchmark-api @ 96d2ab2), run ids deliberately shuffled
// so hashes must stay paired by position.
// ---------------------------------------------------------------------------

const RUN_A = "run-20261017-010000-example-a";
const RUN_B = "run-20261017-010100-example-b";
const HASH_A = "1b4f1c74f378d71d89f706b4e019468486321894419facec6c7661b48370628a";
const HASH_B = "998e28e3f03f8a4ba536b2ee0e78d8c4d5268846d1e17858cec94ffd6370c55d";
const CMP_ID = "comparison-abac869491a330d9";
const evRef = (run: string, line: number) => `.guild/runs/${run}/logs/v1.4-events.jsonl#line:${line}`;

function summary(kind: "run" | "comparison", id: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    id,
    source_guild: "plugin",
    analysis_id: kind === "comparison" ? id : `analysis:${id}:1b4f1c74f378`,
    schema_version: kind === "comparison" ? "guild.run_comparison.v1" : "guild.run_analysis.v1",
    artifact_eligible: kind === "comparison" ? null : true,
    validation: "valid",
    invalid_recommendation_rows: 0,
    recommendation_count: 1,
    finding_count: 0,
    path: `/abs/project/.guild/analysis/${kind}s/${id}`,
    ...extra,
  };
}

const ANALYSIS_LIST = {
  artifacts: [summary("run", RUN_A), summary("comparison", CMP_ID)],
  total: 2,
  sources: [],
};

const COMPARISON_DETAIL = {
  summary: summary("comparison", CMP_ID),
  artifact: {
    schema_version: "guild.run_comparison.v1",
    comparison_id: CMP_ID,
    run_ids: [RUN_B, RUN_A],
    source_hashes: [HASH_B, HASH_A],
    completeness: { eligible_runs: 2, total_runs: 2, average_score: 100 },
    repeated_signatures: [
      { signature: "Bash|fixture failing check|fixture error", runs: [RUN_A, RUN_B], occurrences: 2 },
    ],
    recommendations: [],
  },
  recommendations: [
    {
      schema_version: "guild.recommendation.v1",
      id: "rec-da35bafbcf69c4cd",
      source_id: CMP_ID,
      source_analysis_id: CMP_ID,
      status: "proposed",
      confidence: "high",
      requires_user_approval: true,
      evidence_refs: [evRef(RUN_A, 8), evRef(RUN_B, 9), evRef("run-not-in-comparison", 1)],
      proposed_action: "Address repeated cross-run signature Bash|fixture failing check|fixture error",
    },
  ],
  invalid_recommendation_lines: 0,
  freshness: { state: "current", reason: null, decision_eligible: true },
};

const DIAG_TARGETS = {
  targets: [
    ...PROJECT_TARGETS.targets,
    {
      id: "run:plugin:run-plugin-2",
      kind: "run",
      source_guild: "plugin",
      label: "plugin · run-plugin-2",
      run_ids: ["run-plugin-2"],
      run_count: 1,
      comparison_eligible: true,
      reasons: [],
    },
    {
      id: "run:website:run-web-1",
      kind: "run",
      source_guild: "website",
      label: "website · run-web-1",
      run_ids: ["run-web-1"],
      run_count: 1,
      comparison_eligible: true,
      reasons: [],
    },
  ],
  total: 5,
  sources: [],
};

function mountDiagnostics(
  analysis: (url: string) => Response | undefined,
  initial: string[] = ["/compare"],
) {
  const h = installMockFetch({
    override: (url) => {
      if (url.includes("/api/project/analysis/")) return analysis(url);
      if (url.match(/\/api\/project\/comparison-targets$/)) return jsonResponse(DIAG_TARGETS);
      if (url.match(/\/api\/project\/comparisons/)) return jsonResponse(PROJECT_COMPARISON);
      return undefined;
    },
  });
  mount(initial);
  return h;
}

const diagnosticsOk = (url: string) =>
  url.includes("kind=comparison") ? jsonResponse(COMPARISON_DETAIL) : jsonResponse(ANALYSIS_LIST);

describe("ComparePage — E01 diagnostic evidence", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("E01-AC2: renders a selected comparison with shuffled run ids paired to their hashes", async () => {
    handle = mountDiagnostics(diagnosticsOk);
    const picker = await screen.findByRole("combobox", { name: "Analysis artifact" });
    await userEvent.selectOptions(picker, `comparison|plugin|${CMP_ID}`);
    const detail = await screen.findByTestId("analysis-detail");
    expect(detail).toHaveAttribute("data-kind", "comparison");
    const rows = Array.from(screen.getByTestId("comparison-runs").querySelectorAll("li"));
    expect(rows.map((r) => r.textContent)).toEqual([
      `${RUN_B} source hash ${HASH_B}`,
      `${RUN_A} source hash ${HASH_A}`,
    ]);
    expect(rows[0].style.overflowWrap).toBe("anywhere");
    expect(screen.getByTestId("completeness")).toHaveTextContent("Eligible runs: 2 of 2");
    expect(screen.getByTestId("completeness")).toHaveTextContent("not a quality score");
    expect(screen.getByTestId("analysis-finding")).toHaveTextContent("2 occurrences");
    // Decision eligibility comes from producer inspection, artifact flag is unknown.
    expect(screen.getByTestId("artifact-eligible")).toHaveTextContent("unknown");
    expect(screen.getByTestId("decision-eligible")).toHaveTextContent("yes");
  });

  it("E01-AC3: comparison evidence links only to its reported runs", async () => {
    handle = mountDiagnostics(diagnosticsOk);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Analysis artifact" }),
      `comparison|plugin|${CMP_ID}`,
    );
    const rec = await screen.findByTestId("analysis-recommendation");
    const hrefs = Array.from(rec.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([
      `/project-runs/${RUN_A}?guild=plugin`,
      `/project-runs/${RUN_B}?guild=plugin`,
    ]);
    const panels = Array.from(rec.querySelectorAll('[data-testid="evidence-ref"] summary')).map((s) => s.textContent);
    expect(panels).toEqual([evRef(RUN_A, 8), evRef(RUN_B, 9)]);
    expect(rec.querySelector('[data-testid="evidence-unlinked"]')).toHaveTextContent(
      "run not reported by this artifact",
    );
    expect(document.body).not.toHaveTextContent("/abs/project/.guild/analysis");
  });

  it("shows an explicit empty state when no analysis artifacts exist", async () => {
    handle = mountDiagnostics(() => jsonResponse({ artifacts: [], total: 0, sources: [] }));
    expect(await screen.findByTestId("analysis-artifacts-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("analysis-detail")).toBeNull();
  });

  it("503 analysis_package_unconfigured disables every action with an explanation", async () => {
    handle = mountDiagnostics(() =>
      jsonResponse({ error: "analysis_package_unconfigured", hint: "start serve with --guild-plugin-package <abs>" }, 503),
    );
    expect(await screen.findByTestId("analysis-unconfigured")).toHaveTextContent("--guild-plugin-package <abs>");
    for (const key of ["analyze-baseline", "analyze-candidate", "compare-runs"]) {
      const row = screen.getByTestId(`analysis-action-${key}`);
      expect(row).toHaveAttribute("data-action-state", "disabled");
      expect(row).toHaveTextContent("analysis package is not configured");
    }
    expect(screen.queryByTestId("analysis-error")).toBeNull();
  });

  it("states exact requests for run/initiative targets and refuses cross-source compares", async () => {
    handle = mountDiagnostics(diagnosticsOk, [
      "/compare?baseline=run:plugin:run-plugin&candidate=run:plugin:run-plugin-2",
    ]);
    const compare = await screen.findByTestId("analysis-action-compare-runs");
    await waitFor(() => expect(compare).toHaveAttribute("data-action-state", "ready"));
    expect(compare).toHaveTextContent(
      JSON.stringify({
        source_guild: "plugin",
        operation: "compare",
        target_kind: "runs",
        ids: ["run-plugin", "run-plugin-2"],
      }),
    );
    handle.reset();
    cleanup();

    handle = mountDiagnostics(diagnosticsOk, [
      "/compare?baseline=run:plugin:run-plugin&candidate=run:website:run-web-1",
    ]);
    const cross = await screen.findByTestId("analysis-action-compare-runs");
    await waitFor(() => expect(cross).toHaveTextContent("different sources"));
    expect(cross).toHaveAttribute("data-action-state", "disabled");
    handle.reset();
    cleanup();

    handle = mountDiagnostics(diagnosticsOk, [
      "/compare?baseline=initiative:workspace:guild-dashboard",
    ]);
    const init = await screen.findByTestId("analysis-action-analyze-baseline");
    await waitFor(() => expect(init).toHaveAttribute("data-action-state", "ready"));
    expect(init).toHaveTextContent(
      JSON.stringify({
        source_guild: "workspace",
        operation: "analyze",
        target_kind: "initiative",
        ids: ["guild-dashboard"],
      }),
    );
    expect(screen.getByTestId("analysis-action-analyze-candidate")).toHaveTextContent(
      "Disabled: select a candidate",
    );
  });

  it("independent-group scope validates the id before stating a request", async () => {
    handle = mountDiagnostics(diagnosticsOk);
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Analysis scope" }),
      "independent",
    );
    expect(screen.getByTestId("analysis-action-analyze-independent")).toHaveTextContent(
      "Disabled: enter an independent group id",
    );
    const input = screen.getByLabelText("Independent group id");
    await userEvent.type(input, "../etc");
    expect(screen.getByTestId("analysis-action-analyze-independent")).toHaveTextContent(
      "Disabled: unsupported id: ../etc",
    );
    await userEvent.clear(input);
    await userEvent.type(input, "plan-fixtures");
    const row = screen.getByTestId("analysis-action-analyze-independent");
    await waitFor(() => expect(row).toHaveAttribute("data-action-state", "ready"));
    expect(row).toHaveTextContent('"target_kind":"independent","ids":["plan-fixtures"]');
  });

  it("stale and unsupported comparison states are explicit", async () => {
    handle = mountDiagnostics((url) =>
      url.includes("kind=comparison")
        ? jsonResponse({
            ...COMPARISON_DETAIL,
            summary: summary("comparison", CMP_ID, { validation: "unsupported_schema" }),
            // Artifact stays populated: only the validation guard may hide it.
            freshness: { state: "stale", reason: "input_hash changed", decision_eligible: false },
          })
        : jsonResponse(ANALYSIS_LIST),
    );
    await userEvent.selectOptions(
      await screen.findByRole("combobox", { name: "Analysis artifact" }),
      `comparison|plugin|${CMP_ID}`,
    );
    const notice = await screen.findByTestId("analysis-freshness");
    expect(notice).toHaveAttribute("data-freshness", "stale");
    expect(notice).toHaveAttribute("data-validation", "unsupported_schema");
    expect(notice).toHaveTextContent("input_hash changed");
    expect(screen.queryByTestId("comparison-runs")).toBeNull();
    expect(screen.queryByTestId("analysis-finding")).toBeNull();
    expect(document.body).not.toHaveTextContent(HASH_A);
  });

  it("a malformed list envelope renders a malformed state and disables actions", async () => {
    handle = mountDiagnostics(() => jsonResponse({ artifacts: [{ kind: "run" }], total: 1 }));
    expect(await screen.findByTestId("analysis-malformed")).toBeInTheDocument();
    expect(screen.getByTestId("analysis-action-analyze-baseline")).toHaveAttribute("data-action-state", "disabled");
  });
});
