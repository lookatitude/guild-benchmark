// AT41 (U02) — P06 composed workflow inspector.
// Fixture: composed definition + interrupted run + repaired assurance
// (fixtures/contracts/c8-v2, valid under the frozen A02 validator).
// Negative control: an execution overlay rendered as an editable persisted
// definition must fail the inspector contract check.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import WorkflowInspectorPage, { inspectorContractViolations } from "../routes/WorkflowInspectorPage";
import { installMockFetch, type MockFetchHandle } from "./fixtures/mockFetch";
import runNew from "../../../fixtures/contracts/c8-v2/at41-run-new.json";
import runOld from "../../../fixtures/contracts/c8-v2/at41-run-old.json";

const NEW_RUN = "run-20261105-000002-composed";
const OLD_RUN = "run-20261101-000001-composed";
const NEW_DEF = `sha256:${"1a".repeat(32)}`;
const OLD_DEF = `sha256:${"6f".repeat(32)}`;

const BODIES: Record<string, unknown> = {
  [NEW_RUN]: { status: "available", run_id: NEW_RUN, projection: runNew },
  [OLD_RUN]: { status: "available", run_id: OLD_RUN, projection: runOld },
  "run-nowf": { status: "unavailable", run_id: "run-nowf", reason: "no workflow-projection.json recorded for this run" },
  "run-bad": { status: "refused", run_id: "run-bad", issues: ["invocations[1]: invocation definition changed"] },
};

let handle: MockFetchHandle | undefined;
function mount(runId: string, theme?: "light" | "dark") {
  handle = installMockFetch({
    override: (url) => {
      const m = /^\/api\/project\/runs\/([^/?]+)\/workflow/.exec(url);
      if (!m) return undefined;
      const body = BODIES[decodeURIComponent(m[1])];
      return new Response(JSON.stringify(body ?? { error: "run not found" }), {
        status: body ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return render(
    <div data-theme={theme}>
      <MemoryRouter initialEntries={[`/project-runs/${runId}/workflow`]}>
        <Routes>
          <Route path="/project-runs/:run_id/workflow" element={<WorkflowInspectorPage />} />
        </Routes>
      </MemoryRouter>
    </div>,
  );
}

afterEach(() => {
  handle?.reset();
  handle = undefined;
  cleanup();
});

describe("AT41 workflow UI journey", () => {
  it("shows exact definition pins in a read-only definition region", async () => {
    mount(NEW_RUN);
    const def = await screen.findByTestId("wf-definition");
    for (const pin of [NEW_DEF, `sha256:${"2b".repeat(32)}`, `sha256:${"3c".repeat(32)}`, `sha256:${"4d".repeat(32)}`]) {
      expect(within(def).getAllByText(pin).length).toBeGreaterThan(0);
    }
    expect(within(def).getByText("product")).toBeTruthy();
    expect(inspectorContractViolations(document.body)).toEqual([]);
  });

  it("expanded view lists every node with typed ports, effects, gates and edges", async () => {
    mount(NEW_RUN);
    const view = await screen.findByTestId("wf-view-expanded");
    for (const id of ["plan", "build", "d5", "qa", "security-review", "ops", "d8", "release"]) {
      expect(within(view).getByTestId(`wf-node-${id}`)).toBeTruthy();
    }
    const build = within(view).getByTestId("wf-node-build");
    expect(build.textContent).toContain("plan: guild.plan.v1");
    expect(build.textContent).toContain("patch: guild.patch.v1");
    expect(build.textContent).toContain("comp-build@2");
    const sr = within(view).getByTestId("wf-node-security-review");
    expect(sr.textContent).toMatch(/inside qa gate/i);
    expect(sr.textContent).toContain("build (changes-requested)");
    expect(within(view).getByTestId("wf-node-qa").textContent).toMatch(/protected gate/i);
    // Empty stays empty: a node with no inputs says so, never a zero count.
    expect(within(view).getByTestId("wf-node-plan").textContent).toMatch(/inputs: none declared/i);
  });

  it("component and text views are reachable by keyboard", async () => {
    mount(NEW_RUN);
    const tab = await screen.findByRole("tab", { name: "Expanded graph" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    tab.focus();
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    const comp = screen.getByRole("tab", { name: "Components" });
    expect(comp.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(comp);
    const cview = screen.getByTestId("wf-view-components");
    expect(within(cview).getByTestId("wf-component-comp-build@2").textContent).toContain(`sha256:${"a1".repeat(32)}`);
    expect(within(cview).getByTestId("wf-component-comp-build@2").textContent).toContain("build");
    fireEvent.keyDown(comp, { key: "End" });
    const text = screen.getByTestId("wf-view-text");
    expect(text.textContent).toContain(`definition ${NEW_DEF}`);
    expect(text.textContent).toContain("security-review [review, inside qa] -> build (changes-requested), ops (pass)");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Text" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Expanded graph" }).getAttribute("aria-selected")).toBe("true");
  });

  it("execution overlay is separate and shows loop round, budget and open questions", async () => {
    mount(NEW_RUN);
    const overlay = await screen.findByTestId("wf-overlay");
    const def = screen.getByTestId("wf-definition");
    expect(def.contains(overlay)).toBe(false);
    expect(overlay.contains(def)).toBe(false);
    expect(def.textContent).not.toContain("inv-security-review-1");
    const inv = within(overlay).getByTestId("wf-invocation-inv-security-review-1");
    expect(inv.textContent).toContain("Round 2 of 3");
    expect(inv.textContent).toContain("1 round left");
    expect(inv.textContent).toContain("active");
    expect(inv.textContent).toContain("q-auth-token-scope");
    expect(inv.textContent).toContain(NEW_DEF);
    expect(within(overlay).getByTestId("wf-invocation-inv-build-1").textContent).toMatch(/round budget used/i);
  });

  it("repaired evidence is visibly invalid; pending repair has no evidence yet", async () => {
    mount(NEW_RUN);
    const r1 = await screen.findByTestId("wf-obligation-ob-security-r1");
    expect(r1.getAttribute("data-status")).toBe("invalidated");
    expect(r1.textContent).toMatch(/invalidated: this evidence no longer counts/i);
    expect(r1.querySelectorAll("s").length).toBeGreaterThan(0);
    // Unknown stays unknown: redacted evidence keeps its reason.
    expect(r1.textContent).toContain("redacted");
    expect(r1.textContent).toContain("reviewer transcript withheld");
    const r2 = screen.getByTestId("wf-obligation-ob-security-r2");
    expect(r2.getAttribute("data-status")).toBe("pending");
    expect(r2.textContent).toMatch(/no evidence recorded/i);
    expect(r2.querySelectorAll("s").length).toBe(0);
    const ok = screen.getByTestId("wf-obligation-ob-quality-build");
    expect(ok.getAttribute("data-status")).toBe("accepted");
    expect(ok.querySelectorAll("s").length).toBe(0);
  });

  it("two versions of one component stay distinct by hash", async () => {
    const twoVersions = structuredClone(runNew) as typeof runNew;
    const v1 = `sha256:${"b1".repeat(32)}`;
    twoVersions.components.push({ id: "comp-build", version: "1", sha256: v1 });
    twoVersions.nodes[0].component_id = "comp-build";
    twoVersions.nodes[0].component_hash = v1;
    BODIES["run-two"] = { status: "available", run_id: "run-two", projection: twoVersions };
    mount("run-two");
    const view = await screen.findByTestId("wf-view-expanded");
    expect(within(view).getByTestId("wf-node-plan").textContent).toContain("comp-build@1");
    expect(within(view).getByTestId("wf-node-build").textContent).toContain("comp-build@2");
    fireEvent.click(screen.getByRole("tab", { name: "Components" }));
    expect(screen.getByTestId("wf-component-comp-build@1").textContent).toMatch(/Used by:\s*plan$/);
    expect(screen.getByTestId("wf-component-comp-build@2").textContent).toMatch(/Used by:\s*build$/);
  });

  it("an older run keeps its own definition hash", async () => {
    mount(OLD_RUN);
    const def = await screen.findByTestId("wf-definition");
    expect(within(def).getAllByText(OLD_DEF).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(NEW_DEF);
    expect(within(screen.getByTestId("wf-view-expanded")).getByTestId("wf-node-build").textContent).toContain("comp-build@1");
  });

  it("is read-only: only GET requests, no editable controls", async () => {
    mount(NEW_RUN);
    await screen.findByTestId("wf-overlay");
    for (const call of handle!.calls) expect((call.init?.method ?? "GET").toUpperCase()).toBe("GET");
    expect(document.querySelectorAll("input, textarea, select, form, [contenteditable]").length).toBe(0);
  });

  it("missing projection is unavailable, not an empty or zero workflow", async () => {
    mount("run-nowf");
    const el = await screen.findByTestId("wf-unavailable");
    expect(el.textContent).toMatch(/no workflow-projection\.json recorded/);
    expect(screen.queryByTestId("wf-definition")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0 (nodes|rounds|obligations)\b/);
  });

  it("refused projection shows reasons and renders nothing partial", async () => {
    mount("run-bad");
    const el = await screen.findByTestId("wf-refused");
    expect(el.textContent).toContain("invocation definition changed");
    expect(screen.queryByTestId("wf-definition")).toBeNull();
    expect(screen.queryByTestId("wf-overlay")).toBeNull();
  });

  it("renders under both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      mount(NEW_RUN, theme);
      await screen.findByTestId("wf-overlay");
      expect(inspectorContractViolations(document.body)).toEqual([]);
      cleanup();
    }
  });

  // Theme-token and narrow-layout CSS checks live in tests/workflow-projection.test.ts (node fs).

  it("NEGATIVE CONTROL: overlay rendered as an editable persisted definition fails", () => {
    const bad = document.createElement("div");
    bad.innerHTML = `
      <section data-testid="wf-definition">
        <form><input name="round" value="2" /></form>
        <div data-testid="wf-overlay"><div data-testid="wf-invocation-inv-1">Round 2 of 3</div></div>
        <button type="button">Save definition</button>
      </section>`;
    const violations = inspectorContractViolations(bad);
    expect(violations).toContain("overlay is nested inside the definition");
    expect(violations).toContain("editable control present");
    expect(violations).toContain("overlay content inside the definition");
    expect(violations).toContain("mutating action present");
  });
});
