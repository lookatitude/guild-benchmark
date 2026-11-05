import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectRunLineageResponse } from "../../../src/run-lineage-types";
import RunLineagePage, { correlates } from "../routes/RunLineagePage";
import { installMockFetch, type MockFetchHandle } from "./fixtures/mockFetch";

// U01 / P05 run lineage page. AT39 (lifecycle journey) and AT40 (authority
// and security). The page only reads; it must never show run success from a
// dispatch receipt or a host exit.

const RUN = "run-20261105-000001-p05";
const H = (c: string) => `sha256:${c.repeat(64)}`;
const HOSTILE = '/guild:build <img src=x onerror="alert(1)"><script>window.__pwned=1</script>';

type Available = Extract<ProjectRunLineageResponse, { status: "available" }>;

function lineage(over: Partial<Available> = {}): Available {
  const ev = { sha256: H("c"), schema_version: "guild.evidence.v1", availability: "available" as const, reason: null };
  const runRef = { source_id: "proj-a", kind: "run", id: RUN, revision: H("d") };
  return {
    status: "available",
    requested: { run_id: RUN, guild: "alpha" },
    source_guild: "alpha",
    input_revision: H("1"),
    run: {
      source_id: "proj-a",
      run_id: RUN,
      revision: H("d"),
      initiative_id: null,
      parent_run: null,
      created_at: "2026-11-05T10:00:00Z",
      phase: "build",
      initial_command: HOSTILE,
      initial_prompt: { sha256: H("c"), schema_version: "guild.prompt.v1", availability: "redacted", reason: "raw prompt withheld by retention policy" },
      controller: { source_id: "proj-a", host_id: "controller-host", epoch: 1, state: "active" },
      workflow_hash: H("a"),
      settings_hash: H("a"),
      state: { lifecycle: "active", outcome: "pending", acceptance: "pending", observability: "partial" },
    },
    executions: [
      {
        source_id: "proj-a",
        execution_id: "exec-1",
        revision: H("e"),
        original_host_id: "codex",
        host_session_id: null,
        issued_controller_epoch: 1,
        admission: "sealed",
        interval: { start: "2026-11-05T10:00:00Z", end: "2026-11-05T10:20:00Z", duration_ms: 1200000, clock_basis: "controller" },
        pins: { assignment: H("a"), definition: H("a"), configuration: H("a"), workflow: H("a"), policy: H("a") },
        seal: { outcome_state: "exited", sealed_at: "2026-11-05T10:20:00Z", operation_id: "op-seal-1", matches_segment: true },
      },
    ],
    attempts: [
      {
        source_id: "proj-a",
        attempt_id: "att-b1",
        execution_id: "exec-1",
        logical_task_id: "task-b",
        goal_id: null,
        agent_instance_id: null,
        ordinal: 1,
        state: { lifecycle: "unknown", outcome: "unknown", acceptance: "unknown", observability: "unavailable" },
        assignment: { ...ev, schema_version: "guild.task_assignment.v3" },
        results: [],
        acceptance_subject_hash: null,
        accepted_by_controller_epoch: null,
        receipt_loss_reconciled: false,
        uncertain_effects: true,
      },
    ],
    transfers: [
      {
        operation_id: "xfer-1",
        state: "source_committed",
        stages: ["reserved", "target_prepared", "source_committed"],
        source_work: { source_id: "proj-a", kind: "logical_task", id: "task-1", revision: H("a") },
        destination_work: { source_id: "source-b", kind: "logical_task", id: "task-2", revision: H("a") },
        recorded_at: "2026-10-26T00:00:00Z",
        source_commit: ev,
        target_activation: null,
        target_ack: null,
      },
    ],
    operations: [
      {
        operation_id: "op-launch",
        operation: "v2.launch",
        session_id: "stack-session-1",
        preview_hash: H("b"),
        expires_at: "2099-01-01T00:00:00Z",
        controller_epoch: 1,
        targets: [runRef],
        dependencies: [],
        effects: [{ target: runRef, action: "dispatch" }],
        approval: { decision: "approved", at: "2026-10-26T00:00:00Z", actor_label: "operator" },
        receipt: { state: "accepted", effect_kind: "dispatch", outcome: null, recorded_at: "2026-10-26T00:00:00Z", correlation: "correlated" },
        authority: { status: "pins_current", codes: [], unverified: ["scope_revision", "capability_revision", "policy_revision", "writer_scope"] },
      },
      {
        operation_id: "op-reused-source",
        operation: "v2.launch",
        session_id: "stack-session-1",
        preview_hash: H("f"),
        expires_at: "2099-01-01T00:00:00Z",
        controller_epoch: 1,
        targets: [runRef],
        dependencies: [],
        effects: [{ target: runRef, action: "dispatch" }],
        approval: { decision: "approved", at: "2026-10-26T00:00:00Z", actor_label: "operator" },
        receipt: null,
        authority: { status: "stale", codes: ["approval_authority_mismatch", "approval_source_mismatch"], unverified: ["scope_revision", "capability_revision", "policy_revision", "writer_scope"] },
      },
    ],
    usage: {
      status: "partial",
      analysis_id: "analysis-p05-1",
      analysis_sha256: H("9"),
      entries: [
        { accounting_identity: "request-1", granularity: "leaf_request", inclusion: "leaf_exclusive", input_inclusive: 100, output: 20, total: 120, cost_usd: 0.0003, cost_basis: "derived_estimate", final: true, coverage: { state: "complete", reason: null } },
        { accounting_identity: "request-2", granularity: "leaf_request", inclusion: "leaf_exclusive", input_inclusive: null, output: null, total: null, cost_usd: null, cost_basis: "unavailable", final: true, coverage: { state: "unavailable", reason: "provider returned no usage" } },
      ],
      losses: [],
    },
    close_blockers: [
      { code: "transfer_unacknowledged", subject: "xfer-1" },
      { code: "receipt_loss_unreconciled", subject: "att-b1" },
      { code: "uncertain_effects", subject: "att-b1" },
      { code: "no_accepted_final_evidence", subject: "task-b" },
    ],
    refused: [{ file: "lineage/attempts/att-zz.json", reason: "misplaced" }],
    ...over,
  };
}

let handle: MockFetchHandle | undefined;

function mount(body: unknown, search = "?guild=alpha"): MockFetchHandle {
  handle = installMockFetch({
    override: (url) =>
      url.startsWith(`/api/project/runs/${RUN}/lineage`)
        ? new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
        : undefined,
  });
  render(
    <MemoryRouter initialEntries={[`/project-runs/${RUN}/lineage${search}`]}>
      <Routes>
        <Route path="/project-runs/:run_id/lineage" element={<RunLineagePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return handle;
}

afterEach(() => {
  handle?.reset();
  handle = undefined;
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("AT39 · run lineage journey (UI)", () => {
  it("requests the source-qualified lineage route", async () => {
    const h = mount(lineage());
    await screen.findByTestId("ln-run");
    expect(h.calls.map((c) => c.url)).toContain(`/api/project/runs/${RUN}/lineage?guild=alpha`);
  });

  it("shows the run's four state axes, executions, attempts, close blockers and transfer state", async () => {
    mount(lineage());
    const axes = await screen.findByTestId("ln-run-state");
    expect(within(axes).getByTestId("ln-run-state-lifecycle").textContent).toBe("active");
    expect(within(axes).getByTestId("ln-run-state-outcome").textContent).toBe("pending");
    expect(within(axes).getByTestId("ln-run-state-acceptance").textContent).toBe("pending");
    expect(within(axes).getByTestId("ln-run-state-observability").textContent).toBe("partial");
    expect(screen.getByTestId("ln-execution-proj-a-exec-1")).toBeInTheDocument();
    expect(screen.getByTestId("ln-attempt-proj-a-att-b1")).toHaveTextContent("guild.task_assignment.v3");
    for (const code of ["transfer_unacknowledged", "receipt_loss_unreconciled", "uncertain_effects", "no_accepted_final_evidence"]) {
      expect(screen.getByTestId(`ln-blocker-${code}`)).toBeInTheDocument();
    }
    const xfer = screen.getByTestId("ln-transfer-xfer-1");
    expect(xfer).toHaveAttribute("data-state", "source_committed");
    expect(xfer).toHaveTextContent("not acknowledged");
    expect(screen.getByTestId("ln-snapshot")).toHaveTextContent(H("1"));
  });

  it("keeps unknown and missing values unknown and missing", async () => {
    mount(lineage());
    await screen.findByTestId("ln-run");
    const att = screen.getByTestId("ln-attempt-state-att-b1");
    for (const axis of ["lifecycle", "outcome", "acceptance"]) expect(within(att).getByTestId(`ln-attempt-state-att-b1-${axis}`).textContent).toBe("unknown");
    expect(screen.getByTestId("ln-attempt-proj-a-att-b1")).toHaveTextContent("none recorded");
    expect(screen.getByTestId("ln-execution-proj-a-exec-1")).toHaveTextContent("session unknown");
    const missingRow = screen.getByTestId("ln-usage-request-2");
    expect(within(missingRow).getAllByText("missing")).toHaveLength(4);
    expect(missingRow.textContent).not.toMatch(/\b0\b|\$0/);
    expect(screen.getByTestId("ln-usage-status")).toHaveAttribute("data-status", "partial");
    expect(screen.getByTestId("ln-coverage-request-2")).toHaveTextContent("coverage unavailable: provider returned no usage");
    expect(screen.queryByTestId("ln-coverage-request-1")).toBeNull();
  });

  it("shows absent usage as missing, not zero", async () => {
    mount(lineage({ usage: { status: "missing", reason: "no run analysis v2 recorded for this run" } }));
    const u = await screen.findByTestId("ln-usage-status");
    expect(u).toHaveAttribute("data-status", "missing");
    expect(screen.queryByTestId("ln-usage-request-1")).toBeNull();
  });

  it("negative control: an accepted dispatch receipt and a host exit never display run success", async () => {
    mount(lineage());
    const receipt = await screen.findByTestId("ln-receipt-op-launch");
    expect(receipt).toHaveTextContent("Accepted for processing. This is not an outcome.");
    expect(screen.getByTestId("ln-seal")).toHaveTextContent("Host exit closes this segment only; the logical run is active.");
    expect(screen.getByTestId("ln-run-state-outcome").textContent).toBe("pending");
    expect(screen.getByTestId("ln-run")).not.toHaveTextContent(/succeeded|success/i);
  });

  it("shows legacy and unavailable runs with their reason", async () => {
    mount({ status: "legacy", requested: { run_id: RUN, guild: "alpha" }, source_guild: "alpha", reason: "v1 run" });
    const s = await screen.findByTestId("ln-status");
    expect(s).toHaveAttribute("data-status", "legacy");
    expect(screen.queryByTestId("ln-run")).toBeNull();
  });

  it("is keyboard reachable and has no mutating controls", async () => {
    mount(lineage());
    await screen.findByTestId("ln-run");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(document.querySelectorAll("input, select, textarea, form, [tabindex]")).toHaveLength(0);
    expect(screen.getByTestId("ln-controls-unavailable")).toHaveTextContent("Operation controls are unavailable");
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Back to run" }));
    for (const id of ["ln-run", "ln-blockers", "ln-executions", "ln-attempts", "ln-usage", "ln-transfers", "ln-operations"]) {
      expect(screen.getByTestId(id).getAttribute("aria-labelledby")).toBeTruthy();
    }
  });

  it("renders the same content in light and dark themes, using theme tokens only", async () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-theme", theme);
      mount(lineage());
      expect(await screen.findByTestId("ln-run-state")).toBeInTheDocument();
      cleanup();
      handle?.reset();
    }
    const css = readFileSync(join(__dirname, "..", "styles", "run-lineage.css"), "utf8");
    const tokens = ["system/tokens.css", "global.css"].map((f) => readFileSync(join(__dirname, "..", "styles", f), "utf8")).join("\n");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    for (const [, name] of css.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(tokens, name).toContain(`${name}:`);
  });
});

describe("AT40 · run lineage authority and security (UI)", () => {
  it("escapes hostile run text", async () => {
    mount(lineage());
    const cmd = await screen.findByTestId("ln-command");
    expect(cmd.textContent).toBe(HOSTILE);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("shows a reused approval as stale with its codes and never as authorized", async () => {
    mount(lineage());
    const stale = await screen.findByTestId("ln-authority-op-reused-source");
    expect(stale).toHaveAttribute("data-status", "stale");
    expect(stale).toHaveTextContent("approval_source_mismatch");
    const current = screen.getByTestId("ln-authority-op-launch");
    expect(current).toHaveAttribute("data-status", "pins_current");
    expect(current).toHaveTextContent("this view does not authorize");
    expect(screen.getByTestId("ln-unverified-op-launch")).toHaveTextContent("Not checked here: scope_revision, capability_revision, policy_revision, writer_scope.");
  });

  it("shows the redacted prompt by hash only", async () => {
    mount(lineage());
    const p = await screen.findByTestId("ln-prompt");
    expect(p).toHaveTextContent("redacted");
    expect(p).toHaveTextContent("raw prompt withheld by retention policy");
    expect(document.body.textContent).not.toContain("private/");
  });

  it("negative control: a response for another run or source is not shown", async () => {
    mount(lineage({ requested: { run_id: RUN, guild: "beta" }, source_guild: "beta" }));
    expect(await screen.findByTestId("ln-uncorrelated")).toBeInTheDocument();
    expect(screen.queryByTestId("ln-run")).toBeNull();
    expect(correlates(lineage(), RUN, "alpha")).toBe(true);
    expect(correlates(lineage(), "run-other", "alpha")).toBe(false);
    expect(correlates(lineage(), RUN, undefined)).toBe(false);
  });
});
