// RecommendationPanel.test.tsx — E02 explicit decisions with exact effects.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecommendationPanel, { MAX_DECISION_ATTEMPTS, resetDecisionStores } from "../components/RecommendationPanel";
import type { AnalysisJobView } from "../components/AnalysisJobPanel";

const TOKEN = "a".repeat(64);
const HASH = "c".repeat(64);
const ANALYSIS_ID = "analysis:run-src:abc";

function rec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "guild.recommendation.v1",
    id: "rec-1",
    source_id: "run-src",
    source_analysis_id: ANALYSIS_ID,
    scope: "plugin",
    kind: "bug_report",
    confidence: "high",
    severity: "medium",
    evidence_refs: ["run-src/logs/v1.4-events.jsonl#L3", "run-src/logs/v1.4-events.jsonl#L9"],
    evidence_signature: "sig",
    affected_runs: ["run-src"],
    proposed_action: "Report the hook timeout to the plugin",
    suggested_owner: "guild-plugin",
    next_action: "ask_user_before_filing",
    requires_user_approval: true,
    status: "proposed",
    routing: { action: "ask_user_before_filing", requires_user_approval: true, target: "guild-plugin" },
    ...overrides,
  };
}

function job(overrides: Partial<AnalysisJobView> = {}): AnalysisJobView {
  return {
    job_id: "job-d",
    source_guild: "root",
    operation: "recommendation_decide",
    state: "running",
    created_at: "2026-10-18T00:00:00Z",
    started_at: "2026-10-18T00:00:00Z",
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

type Reply = { status: number; body: unknown };
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function installFetch(create: Reply, poll: Reply[] = []) {
  const calls: Call[] = [];
  const queue = [...poll];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      let reply: Reply;
      if (url.endsWith("/project/analysis/session")) reply = { status: 200, body: { action_token: TOKEN } };
      else if (method === "POST" && url.endsWith("/project/analysis/jobs")) reply = create;
      else if (method === "GET" && url.includes("/project/analysis/jobs/")) {
        reply = queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 404, body: {} };
      } else reply = { status: 404, body: {} };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }),
  );
  return { calls, posts: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/jobs")) };
}

function mount(props: Partial<Parameters<typeof RecommendationPanel>[0]> = {}) {
  return render(
    <RecommendationPanel
      sourceGuild="root"
      sourceKind="run"
      sourceId="run-src"
      sourceAnalysisId={ANALYSIS_ID}
      sourceInputHash={HASH}
      decisionEligible={true}
      recommendations={[rec()]}
      pollIntervalMs={10}
      {...props}
    />,
  );
}

beforeEach(() => {
  resetDecisionStores();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RecommendationPanel — destination and exact effect (E02-AC1)", () => {
  it("E02-AC1 plugin: destination shows before any decision and the prompt states the exact effect", async () => {
    const f = installFetch({ status: 202, body: job() });
    mount();
    const item = screen.getByTestId("recommendation-rec-1");
    expect(within(item).getByTestId("recommendation-destination")).toHaveTextContent(
      "Destination: plugin local draft. Accept writes an accepted local draft in the plugin recommendation store.",
    );
    expect(screen.queryByTestId("decision-prompt")).toBeNull();
    await userEvent.click(within(item).getByRole("button", { name: "Accept…" }));
    expect(within(item).getByTestId("decision-effect")).toHaveTextContent(
      "Accept sets the status accepted and writes a local draft only. Nothing is filed to a remote issue tracker. Nothing is implemented. No capability changes.",
    );
    // Opening the prompt sends nothing.
    expect(f.calls).toHaveLength(0);
  });

  it("E02-AC1 project: accept goes to the proposal queue and implements nothing", async () => {
    installFetch({ status: 202, body: job() });
    mount({ recommendations: [rec({ scope: "project", suggested_owner: "project", kind: "update_workflow" })] });
    const item = screen.getByTestId("recommendation-rec-1");
    expect(within(item).getByTestId("recommendation-destination")).toHaveTextContent(
      "Destination: project proposal queue (.guild/recommendations/queue.jsonl). Accept adds a queued proposal.",
    );
    await userEvent.click(within(item).getByRole("button", { name: "Accept…" }));
    expect(within(item).getByTestId("decision-effect")).toHaveTextContent(
      "Accept sets the status queued and adds one proposal to the project queue. Nothing is implemented. No capability changes. Nothing is filed.",
    );
  });

  it("E02-AC1 confirm sends one recommendation_decide job with both expected guards and no status claim", async () => {
    const f = installFetch({ status: 202, body: job() }, [
      {
        status: 200,
        body: job({
          state: "succeeded",
          closed_at: "2026-10-18T00:00:01Z",
          exit_code: 0,
          stdout_excerpt: JSON.stringify({ ok: true, source_id: "run-src", recommendation_id: "rec-1", status: "accepted", effect: "plugin_draft_written" }),
        }),
      },
    ]);
    const onDecided = vi.fn();
    mount({ onDecided });
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() =>
      expect(screen.getByTestId("decision-status")).toHaveTextContent("The producer recorded: accepted local draft. Not filed. Not implemented."),
    );
    expect(f.posts()).toHaveLength(1);
    const post = f.posts()[0];
    expect(post.headers["X-Guild-Action-Token"]).toBe(TOKEN);
    expect(post.body).toEqual({
      source_guild: "root",
      operation: "recommendation_decide",
      target_kind: "run",
      ids: ["run-src"],
      idempotency_key: expect.stringMatching(/^decide-rec-1-accept-/),
      decision: "accept",
      recommendation_id: "rec-1",
      source_analysis_id: ANALYSIS_ID,
      source_input_hash: HASH,
    });
    // Only the job endpoints are called: no other write route, no remote filing.
    expect(f.calls.every((c) => c.url.includes("/project/analysis/"))).toBe(true);
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it("E02-AC1 the UI offers no filed/implemented control and labels decided rows honestly", () => {
    installFetch({ status: 202, body: job() });
    mount({
      recommendations: [
        rec({ id: "rec-a", status: "accepted" }),
        rec({ id: "rec-q", scope: "project", status: "queued" }),
        rec({ id: "rec-i", scope: "project", status: "implemented" }),
      ],
    });
    expect(screen.queryByRole("button", { name: /filed|implement|file issue/i })).toBeNull();
    expect(within(screen.getByTestId("recommendation-rec-a")).getByTestId("recommendation-status")).toHaveTextContent(
      "Accepted local draft. Not filed. Not implemented.",
    );
    expect(within(screen.getByTestId("recommendation-rec-q")).getByTestId("recommendation-status")).toHaveTextContent(
      "Queued proposal. Not implemented.",
    );
    expect(within(screen.getByTestId("recommendation-rec-i")).getByTestId("recommendation-status")).toHaveTextContent(
      "Recorded as implemented by an operator outside this page.",
    );
    for (const id of ["rec-a", "rec-q", "rec-i"]) {
      expect(within(screen.getByTestId(`recommendation-${id}`)).getByRole("button", { name: "Accept…" })).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("an unparseable producer result never claims a status", async () => {
    installFetch({ status: 202, body: job({ state: "succeeded", closed_at: "2026-10-18T00:00:01Z", stdout_excerpt: '{"ok":true,"stat…' }) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Reject…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(screen.getByTestId("decision-status")).toHaveTextContent("The producer finished. Reload the analysis to see the recorded status."));
    expect(screen.queryByText(/recorded: /)).toBeNull();
  });
});

describe("RecommendationPanel — expected-context guards", () => {
  it("a recommendation from an older analysis cannot be decided", async () => {
    const f = installFetch({ status: 202, body: job() });
    mount({ recommendations: [rec({ source_analysis_id: "analysis:run-src:old" })] });
    expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("made by an older analysis");
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    expect(screen.queryByTestId("decision-prompt")).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it("a missing input hash or ineligible preflight disables decisions", () => {
    installFetch({ status: 202, body: job() });
    const view = mount({ sourceInputHash: null });
    expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("input hash is not reported");
    view.rerender(
      <RecommendationPanel
        sourceGuild="root"
        sourceKind="run"
        sourceId="run-src"
        sourceAnalysisId={ANALYSIS_ID}
        sourceInputHash={HASH}
        decisionEligible={false}
        recommendations={[rec()]}
      />,
    );
    expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("not eligible for decisions");
  });

  it("F3 a failed decide job is reported as unverified and asks the parent to re-read", async () => {
    installFetch({ status: 202, body: job() }, [
      {
        status: 200,
        body: job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1", stderr_excerpt: "expected analysis id mismatch" }),
      },
    ]);
    const onDecided = vi.fn();
    const onUnverified = vi.fn();
    mount({ onDecided, onUnverified });
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The decision outcome is unverified (failed: producer exited 1). The producer may have recorded it before it stopped. Re-read the analysis artifact before you decide again.",
      ),
    );
    expect(screen.queryByText(/status is unchanged/)).toBeNull();
    expect(onDecided).not.toHaveBeenCalled();
    expect(onUnverified).toHaveBeenCalledTimes(1);
  });

  it("F3 a timed-out decide job is also unverified, never unchanged", async () => {
    installFetch({ status: 202, body: job() }, [
      { status: 200, body: job({ state: "timed_out", closed_at: "2026-10-18T00:02:00Z", reason: "timeout after 120000ms" }) },
    ]);
    const onUnverified = vi.fn();
    mount({ onUnverified });
    await userEvent.click(screen.getByRole("button", { name: "Reject…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The decision outcome is unverified (timed_out: timeout after 120000ms)."));
    expect(onUnverified).toHaveBeenCalledTimes(1);
  });

  it("F2 an inconsistent decide job is unverified: re-read requested and decisions blocked until it arrives", async () => {
    const inconsistent = job({ state: "succeeded", closed_at: "2026-10-18T00:00:01Z", exit_code: 1 });
    const f = installFetch({ status: 200, body: inconsistent });
    const onDecided = vi.fn();
    const onUnverified = vi.fn();
    const view = mount({ onDecided, onUnverified });
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("inconsistent job report: the server reported succeeded with exit code 1"));
    expect(onUnverified).toHaveBeenCalledTimes(1);
    expect(onUnverified).toHaveBeenCalledWith(expect.objectContaining({ job_id: "job-d", exit_code: 1 }));
    expect(onDecided).not.toHaveBeenCalled();
    expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("the last decision outcome is unverified; waiting for the re-read analysis artifact");
    expect(screen.getByRole("button", { name: "Accept…" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "Reject…" }));
    expect(screen.queryByTestId("decision-prompt")).toBeNull();
    expect(f.posts()).toHaveLength(1);
    // The parent passes the re-read record: the block clears.
    view.rerender(
      <RecommendationPanel
        sourceGuild="root"
        sourceKind="run"
        sourceId="run-src"
        sourceAnalysisId={ANALYSIS_ID}
        sourceInputHash={HASH}
        decisionEligible={true}
        recommendations={[rec()]}
        pollIntervalMs={10}
        onUnverified={onUnverified}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("recommendation-blocked")).toBeNull());
    expect(screen.getByRole("button", { name: "Accept…" })).not.toHaveAttribute("aria-disabled");
    expect(onUnverified).toHaveBeenCalledTimes(1);
  });

  it("F2 a failed decide job also blocks decisions until the re-read record arrives", async () => {
    installFetch({ status: 202, body: job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1" }) });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Reject…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("waiting for the re-read analysis artifact"));
    expect(screen.getByRole("button", { name: "Reject…" })).toHaveAttribute("aria-disabled", "true");
  });

  it("F4 decision attempts are capped per row", async () => {
    const failed = job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1" });
    const f = installFetch({ status: 202, body: failed });
    const view = mount();
    for (let i = 0; i < MAX_DECISION_ATTEMPTS; i++) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Accept…" })).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unverified"));
      // The parent re-reads the record (still proposed, same context).
      view.rerender(
        <RecommendationPanel
          sourceGuild="root"
          sourceKind="run"
          sourceId="run-src"
          sourceAnalysisId={ANALYSIS_ID}
          sourceInputHash={HASH}
          decisionEligible={true}
          recommendations={[rec()]}
          pollIntervalMs={10}
        />,
      );
    }
    await waitFor(() => expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("decision attempt limit reached (3)"));
    expect(screen.getByRole("button", { name: "Accept…" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    expect(screen.queryByTestId("decision-prompt")).toBeNull();
    expect(f.posts()).toHaveLength(MAX_DECISION_ATTEMPTS);
    const keys = f.posts().map((p) => (p.body as Record<string, string>).idempotency_key);
    expect(new Set(keys).size).toBe(MAX_DECISION_ATTEMPTS);
  });

  it("EFIX-R1 unmounting during the re-read preserves attempts and idempotency sequence", async () => {
    // The composed pages unmount the whole panel while the analysis re-read
    // is loading; the cap and key sequence must survive that, not reset.
    const failed = job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1" });
    const f = installFetch({ status: 202, body: failed });
    for (let i = 0; i < MAX_DECISION_ATTEMPTS; i++) {
      const view = mount();
      await waitFor(() => expect(screen.getByRole("button", { name: "Accept…" })).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unverified"));
      view.unmount();
    }
    mount();
    await waitFor(() => expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("decision attempt limit reached (3)"));
    expect(screen.getByRole("button", { name: "Accept…" })).toHaveAttribute("aria-disabled", "true");
    expect(f.posts()).toHaveLength(MAX_DECISION_ATTEMPTS);
    const keys = f.posts().map((p) => (p.body as Record<string, string>).idempotency_key);
    expect(new Set(keys).size).toBe(MAX_DECISION_ATTEMPTS);
  });

  it("EFIX-R2 an exhausted cap in one source does not block the same ids under another source", async () => {
    const failed = job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1" });
    installFetch({ status: 202, body: failed });
    for (let i = 0; i < MAX_DECISION_ATTEMPTS; i++) {
      const view = mount();
      await waitFor(() => expect(screen.getByRole("button", { name: "Accept…" })).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unverified"));
      view.unmount();
    }
    const blockedView = mount();
    await waitFor(() => expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("decision attempt limit reached (3)"));
    blockedView.unmount();
    // Same analysis id, hash and recommendation id, different source guild.
    mount({ sourceGuild: "other-root" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept…" })).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByTestId("recommendation-blocked")).toBeNull();
  });

  it("a 128-char recommendation id keeps distinct, bounded keys per attempt", async () => {
    const longId = "r" + "x".repeat(127);
    const failed = job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1" });
    const f = installFetch({ status: 202, body: failed });
    const view = mount({ recommendations: [rec({ id: longId })] });
    for (let i = 0; i < 2; i++) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Reject…" })).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(screen.getByRole("button", { name: "Reject…" }));
      await userEvent.click(screen.getByRole("button", { name: "Confirm reject" }));
      await waitFor(() => expect(f.posts()).toHaveLength(i + 1));
      await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unverified"));
      view.rerender(
        <RecommendationPanel
          sourceGuild="root"
          sourceKind="run"
          sourceId="run-src"
          sourceAnalysisId={ANALYSIS_ID}
          sourceInputHash={HASH}
          decisionEligible={true}
          recommendations={[rec({ id: longId })]}
          pollIntervalMs={10}
        />,
      );
    }
    const keys = f.posts().map((p) => (p.body as Record<string, string>).idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toMatch(/-reject-.*-1$/);
    expect(keys[1]).toMatch(/-reject-.*-2$/);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(128);
  });

  it("F4 a 503 unconfigured reply blocks further decisions until the context changes", async () => {
    const f = installFetch({ status: 503, body: { error: "analysis_package_unconfigured" } });
    const view = mount();
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("analysis jobs are unavailable"));
    await userEvent.click(screen.getByRole("button", { name: "Reject…" }));
    expect(screen.queryByTestId("decision-prompt")).toBeNull();
    expect(f.posts()).toHaveLength(1);
    const NEW_ID = "analysis:run-src:def";
    view.rerender(
      <RecommendationPanel
        sourceGuild="root"
        sourceKind="run"
        sourceId="run-src"
        sourceAnalysisId={NEW_ID}
        sourceInputHash={"d".repeat(64)}
        decisionEligible={true}
        recommendations={[rec({ source_analysis_id: NEW_ID })]}
        pollIntervalMs={10}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("recommendation-blocked")).toBeNull());
    expect(screen.getByRole("button", { name: "Accept…" })).not.toHaveAttribute("aria-disabled");
  });

  it("503 unconfigured on decide is a distinct non-failure state", async () => {
    installFetch({ status: 503, body: { error: "analysis_package_unconfigured" } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(screen.getByTestId("decision-status")).toHaveTextContent("no analysis package is configured"));
    expect(screen.getByTestId("decision-alert")).toHaveTextContent("");
  });

  it("malformed recommendation rows are counted and never decidable", () => {
    installFetch({ status: 202, body: job() });
    mount({ recommendations: [rec(), { id: "bad", scope: "remote" }] });
    expect(screen.getByTestId("recommendation-invalid")).toHaveTextContent("1 recommendation row could not be read");
    expect(screen.queryByTestId("recommendation-bad")).toBeNull();
  });
});

// E03 F3 (Team D): server and producer disagree on the hash format. The guard
// accepts both forms and the UI sends the artifact's hash unchanged.
describe("RecommendationPanel — input hash format (E-FIX)", () => {
  it.each([
    ["bare hex", HASH],
    ["sha256: prefixed", `sha256:${HASH}`],
  ])("sends a %s input hash exactly as the artifact reports it", async (_label, hash) => {
    const f = installFetch({ status: 202, body: job() });
    mount({ sourceInputHash: hash });
    expect(screen.queryByTestId("recommendation-blocked")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Accept…" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm accept" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect((f.posts()[0].body as Record<string, unknown>).source_input_hash).toBe(hash);
  });

  it("still blocks a hash that is neither form", () => {
    installFetch({ status: 202, body: job() });
    mount({ sourceInputHash: "md5:abc" });
    expect(screen.getByTestId("recommendation-blocked")).toHaveTextContent("input hash is not reported");
  });
});
