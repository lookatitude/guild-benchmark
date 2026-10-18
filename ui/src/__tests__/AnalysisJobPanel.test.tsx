// AnalysisJobPanel.test.tsx — E02 job progress, cancel/retry and a11y.
//
// fetch is stubbed per test with a small router. Polling runs on real timers
// at a 10ms interval so waitFor observes each state change.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AnalysisJobPanel, { MAX_JOB_RETRIES, shortHash, type AnalysisJobState, type AnalysisJobView } from "../components/AnalysisJobPanel";

const TOKEN = "t".repeat(64);

function job(overrides: Partial<AnalysisJobView> = {}): AnalysisJobView {
  return {
    job_id: "job-1",
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

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body: unknown; delayMs?: number };

/** Route table: POST /jobs, GET /jobs/:id (sequence; last repeats), POST cancel.
 * pollById gives one job id its own GET sequence. */
function installFetch(routes: { create?: Reply[]; poll?: Reply[]; pollById?: Record<string, Reply[]>; cancel?: Reply[]; session?: Reply }) {
  const calls: Call[] = [];
  const queues = { create: [...(routes.create ?? [])], poll: [...(routes.poll ?? [])], cancel: [...(routes.cancel ?? [])] };
  const byId = Object.fromEntries(Object.entries(routes.pollById ?? {}).map(([id, q]) => [id, [...q]]));
  const next = (q: Reply[]): Reply => (q.length > 1 ? q.shift()! : q[0] ?? { status: 500, body: { error: "no route" } });
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ method, url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    let reply: Reply;
    if (url.endsWith("/project/analysis/session")) reply = routes.session ?? { status: 200, body: { action_token: TOKEN } };
    else if (method === "POST" && url.endsWith("/cancel")) reply = next(queues.cancel);
    else if (method === "POST" && url.endsWith("/project/analysis/jobs")) reply = next(queues.create);
    else if (method === "GET" && url.includes("/project/analysis/jobs/")) {
      const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      reply = next(byId[id] ?? queues.poll);
    }
    else reply = { status: 404, body: { error: "unrouted" } };
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { calls, posts: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/jobs")) };
}

const REQUEST = { source_guild: "root", operation: "analyze" as const, target_kind: "run" as const, ids: ["run-a"] };

function mount(props: Partial<Parameters<typeof AnalysisJobPanel>[0]> = {}) {
  return render(
    <AnalysisJobPanel
      title="Analyze run"
      request={REQUEST}
      contextKey="ctx-1"
      disabledReason={null}
      pollIntervalMs={10}
      {...props}
    />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnalysisJobPanel — real job states (E02-AC2)", () => {
  it("E02-AC2 restart: a 404 poll reports unknown, never completion, and never restarts on its own", async () => {
    const f = installFetch({ create: [{ status: 202, body: job() }], poll: [{ status: 404, body: { error: "unknown job id" } }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("does not know this job"));
    expect(screen.getByTestId("job-alert")).toHaveTextContent("The result is unknown and nothing was restarted");
    expect(screen.queryByText(/succeeded/i)).toBeNull();
    // Wait several poll intervals: no auto-restart POST, no further polls.
    const pollsAtUnknown = f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length;
    await act(() => new Promise((r) => setTimeout(r, 60)));
    expect(f.posts()).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length).toBe(pollsAtUnknown);
  });

  it("E02-AC2 failed: a closed failure shows the reason and no completion", async () => {
    installFetch({
      create: [{ status: 202, body: job({ state: "queued", started_at: null }) }],
      poll: [
        { status: 200, body: job() },
        { status: 200, body: job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1", stderr_excerpt: "boom" }) },
      ],
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("Job failed: producer exited 1. No result is reported."));
    expect(screen.getByTestId("job-status")).toHaveTextContent("");
    expect(screen.queryByText(/Job succeeded/)).toBeNull();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("E02-AC2 terminal state without a real close is not shown as done and keeps polling", async () => {
    const f = installFetch({
      create: [{ status: 202, body: job() }],
      poll: [{ status: 200, body: job({ state: "succeeded", closed_at: null, artifact_refs: [".guild/analysis/runs/run-a/analysis.json"] }) }],
    });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("has not closed"));
    expect(screen.queryByText(/Job succeeded/)).toBeNull();
    expect(screen.queryByTestId("job-artifacts")).toBeNull();
    const before = f.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(f.calls.length).toBeGreaterThan(before);
  });

  it("succeeded only after close, with the producer's artifact refs", async () => {
    installFetch({
      create: [{ status: 202, body: job() }],
      poll: [{ status: 200, body: job({ state: "succeeded", closed_at: "2026-10-18T00:00:02Z", exit_code: 0, artifact_refs: [".guild/analysis/runs/run-a/analysis.json"] }) }],
    });
    const onClosed = vi.fn();
    mount({ onClosed });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job succeeded. The producer reported 1 artifact."));
    expect(screen.getByText(".guild/analysis/runs/run-a/analysis.json")).toBeInTheDocument();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("E02-AC2 unknown state value: a malformed poll body is refused, not completion", async () => {
    // Complete in every field but the state, so only the state enum guard can reject it.
    const done = job({ state: "done" as AnalysisJobState, closed_at: "2026-10-18T00:00:01Z", exit_code: 0 });
    installFetch({ create: [{ status: 202, body: job() }], poll: [{ status: 200, body: done }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("cannot read"));
    expect(screen.queryByText(/succeeded/i)).toBeNull();
  });
});

describe("AnalysisJobPanel — completion needs a consistent, real close (F1)", () => {
  it("an empty closed_at does not establish completion and polling continues", async () => {
    const f = installFetch({
      create: [{ status: 202, body: job() }],
      poll: [{ status: 200, body: job({ state: "succeeded", closed_at: "", exit_code: 0, artifact_refs: ["a.json"] }) }],
    });
    const onClosed = vi.fn();
    mount({ onClosed });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("has not closed"));
    expect(screen.queryByText(/Job succeeded/)).toBeNull();
    expect(screen.queryByTestId("job-artifacts")).toBeNull();
    const before = f.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(f.calls.length).toBeGreaterThan(before);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("succeeded with a nonzero exit code is an inconsistent report, never success", async () => {
    const f = installFetch({
      create: [{ status: 202, body: job() }],
      poll: [{ status: 200, body: job({ state: "succeeded", closed_at: "2026-10-18T00:00:02Z", exit_code: 1, artifact_refs: ["a.json"] }) }],
    });
    const onClosed = vi.fn();
    mount({ onClosed });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("inconsistent job report: the server reported succeeded with exit code 1"));
    expect(screen.queryByText(/Job succeeded/)).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
    const polls = f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length;
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length).toBe(polls);
  });
});

describe("AnalysisJobPanel — cancel, conflict, unconfigured, token", () => {
  it("F2 a delayed cancel response never replaces a closed poll result or restarts polling", async () => {
    const closed = job({ state: "cancelled", closed_at: "2026-10-18T00:00:03Z", signal: "SIGTERM", reason: "cancelled by request" });
    const f = installFetch({
      create: [{ status: 202, body: job() }],
      cancel: [{ status: 202, body: job(), delayMs: 150 }],
      poll: [
        { status: 200, body: job() },
        { status: 200, body: job() },
        { status: 200, body: closed },
      ],
    });
    mount({ pollIntervalMs: 20 });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job is running."));
    await userEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("Job cancelled. The process closed."));
    // Let the delayed cancel reply (state running) land after the close.
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(f.calls.some((c) => c.url.endsWith("/cancel"))).toBe(true);
    expect(screen.getByTestId("job-alert")).toHaveTextContent("Job cancelled. The process closed.");
    expect(screen.getByTestId("job-state")).toHaveTextContent("cancelled");
    const polls = f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length;
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length).toBe(polls);
  });

  it("F1 a late cancel response for job A never replaces retried job B or resumes tracking A", async () => {
    const failedA = job({ state: "failed", closed_at: "2026-10-18T00:00:02Z", exit_code: 1, reason: "producer exited 1" });
    const jobB = job({ job_id: "job-2" });
    const f = installFetch({
      create: [{ status: 202, body: job() }, { status: 202, body: jobB }],
      cancel: [{ status: 202, body: job(), delayMs: 300 }],
      pollById: {
        "job-1": [{ status: 200, body: job() }, { status: 200, body: job() }, { status: 200, body: failedA }],
        // Slow B polls, so a B reply cannot hide a stale A reply.
        "job-2": [{ status: 200, body: jobB, delayMs: 2000 }],
      },
    });
    mount({ pollIntervalMs: 20 });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job is running."));
    await userEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("Job failed: producer exited 1."));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("job-detail")).toHaveTextContent("job-2"));
    const pollsOfA = f.calls.filter((c) => c.method === "GET" && c.url.endsWith("/jobs/job-1")).length;
    // Let the delayed cancel reply for job A (state running) land during job B.
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(f.calls.some((c) => c.url.endsWith("/jobs/job-1/cancel"))).toBe(true);
    expect(screen.getByTestId("job-detail")).toHaveTextContent("job-2");
    expect(screen.getByTestId("job-detail")).not.toHaveTextContent("job-1");
    expect(screen.getByTestId("job-status")).toHaveTextContent("Job is running.");
    expect(f.calls.filter((c) => c.method === "GET" && c.url.endsWith("/jobs/job-1")).length).toBe(pollsOfA);
  });

  it("F1 a late cancel response never overwrites a settled inconsistent report", async () => {
    const f = installFetch({
      create: [{ status: 202, body: job() }],
      cancel: [{ status: 202, body: job(), delayMs: 150 }],
      poll: [
        { status: 200, body: job() },
        { status: 200, body: job() },
        { status: 200, body: job({ state: "succeeded", closed_at: "2026-10-18T00:00:02Z", exit_code: 1 }) },
      ],
    });
    mount({ pollIntervalMs: 20 });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job is running."));
    await userEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("inconsistent job report"));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(f.calls.some((c) => c.url.endsWith("/cancel"))).toBe(true);
    expect(screen.getByTestId("job-alert")).toHaveTextContent("inconsistent job report: the server reported succeeded with exit code 1");
    expect(screen.queryByTestId("job-detail")).toBeNull();
    const polls = f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length;
    await act(() => new Promise((r) => setTimeout(r, 80)));
    expect(f.calls.filter((c) => c.method === "GET" && c.url.includes("/jobs/")).length).toBe(polls);
  });

  it("cancel stays pending on 202 until the server reports the real close", async () => {
    const f = installFetch({
      create: [{ status: 202, body: job() }],
      cancel: [{ status: 202, body: job() }],
      poll: [
        { status: 200, body: job() },
        { status: 200, body: job() },
        { status: 200, body: job() },
        { status: 200, body: job({ state: "cancelled", closed_at: "2026-10-18T00:00:03Z", signal: "SIGTERM", reason: "cancelled by request" }) },
      ],
    });
    mount({ pollIntervalMs: 30 });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job is running."));
    await userEvent.click(screen.getByRole("button", { name: "Cancel job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Cancel requested. The job stays running until the process closes."));
    expect(screen.getByRole("button", { name: "Cancel requested" })).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("Job cancelled. The process closed."));
    const cancel = f.calls.find((c) => c.url.endsWith("/cancel"));
    expect(cancel?.headers["X-Guild-Action-Token"]).toBe(TOKEN);
  });

  it("409 conflict is a distinct non-destructive state; nothing is cancelled", async () => {
    const f = installFetch({ create: [{ status: 409, body: { error: "another analysis job is active", active: job({ job_id: "job-other" }) } }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("Another analysis job is active for this project (job-other, running). Nothing was started."));
    expect(f.calls.some((c) => c.url.endsWith("/cancel"))).toBe(false);
    expect(screen.getByRole("button", { name: "Retry" })).not.toHaveAttribute("aria-disabled");
  });

  it("503 analysis_package_unconfigured is a distinct disabled state, not a failure", async () => {
    installFetch({ create: [{ status: 503, body: { error: "analysis_package_unconfigured", hint: "start serve with --guild-plugin-package <abs>" } }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("no analysis package is configured (start serve with --guild-plugin-package <abs>)"));
    expect(screen.getByTestId("job-alert")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("aria-disabled", "true");
  });

  it("mutative calls carry the session token; it is never persisted", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const f = installFetch({ create: [{ status: 202, body: job({ state: "succeeded", closed_at: "2026-10-18T00:00:01Z" }) }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job succeeded"));
    const post = f.posts()[0];
    expect(post.headers["X-Guild-Action-Token"]).toBe(TOKEN);
    expect(post.body).toMatchObject({ ...REQUEST, idempotency_key: expect.stringMatching(/^ui-ctx-1-[0-9a-f]{16}-1$/) });
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(TOKEN);
    setItem.mockRestore();
  });

  it("a disabled reason blocks the start without any request", async () => {
    const f = installFetch({});
    mount({ disabledReason: "analysis freshness is unavailable" });
    expect(screen.getByTestId("job-disabled-reason")).toHaveTextContent("Disabled: analysis freshness is unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    expect(f.calls).toHaveLength(0);
  });
});

describe("AnalysisJobPanel — bounded retry and stale context", () => {
  it("retry is bounded and each attempt uses a new idempotency key", async () => {
    const failed = job({ state: "failed", closed_at: "2026-10-18T00:00:01Z", exit_code: 1, reason: "producer exited 1" });
    const f = installFetch({ create: [{ status: 202, body: failed }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    for (let i = 0; i < MAX_JOB_RETRIES; i++) {
      await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    }
    await waitFor(() => expect(screen.getByTestId("job-retry-exhausted")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    const keys = f.posts().map((p) => (p.body as Record<string, string>).idempotency_key);
    expect(keys).toEqual([1, 2, 3, 4].map((n) => `ui-ctx-1-${shortHash("ctx-1")}-${n}`));
  });

  it("a context change marks the job stale and retry uses the current request", async () => {
    const f = installFetch({ create: [{ status: 202, body: job({ state: "succeeded", closed_at: "2026-10-18T00:00:01Z" }) }] });
    const view = mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(screen.getByTestId("job-status")).toHaveTextContent("Job succeeded"));
    view.rerender(
      <AnalysisJobPanel
        title="Analyze run"
        request={{ ...REQUEST, ids: ["run-b"] }}
        contextKey="ctx-2"
        disabledReason={null}
        pollIntervalMs={10}
      />,
    );
    expect(screen.getByTestId("job-stale-context")).toHaveTextContent("older analysis context");
    await userEvent.click(screen.getByRole("button", { name: "Retry with current context" }));
    await waitFor(() => expect(f.posts()).toHaveLength(2));
    expect(f.posts()[1].body).toMatchObject({ ids: ["run-b"], idempotency_key: `ui-ctx-2-${shortHash("ctx-2")}-2` });
  });

  it("long context keys that share a tail or prefix get distinct, bounded keys", async () => {
    const tail = "x".repeat(200);
    const f = installFetch({ create: [{ status: 409, body: { error: "conflict" } }] });
    const view = mount({ contextKey: `a${tail}` });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    view.unmount();
    mount({ contextKey: `b${tail}` });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    await waitFor(() => expect(f.posts()).toHaveLength(2));
    const keys = f.posts().map((p) => (p.body as Record<string, string>).idempotency_key);
    expect(keys[0]).not.toBe(keys[1]);
    for (const k of keys) expect(k.length).toBeLessThanOrEqual(128);
  });
});

describe("AnalysisJobPanel — focus and announcements (E02-AC3)", () => {
  it("E02-AC3 polling keeps focus on the focused control and failures go to an alert", async () => {
    installFetch({
      create: [{ status: 202, body: job() }],
      poll: [
        { status: 200, body: job() },
        { status: 200, body: job() },
        { status: 200, body: job() },
        { status: 200, body: job({ state: "timed_out", closed_at: "2026-10-18T00:02:00Z", reason: "timeout after 120000ms" }) },
      ],
    });
    mount({ pollIntervalMs: 25 });
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    const cancel = await screen.findByRole("button", { name: "Cancel job" });
    cancel.focus();
    await waitFor(() => expect(screen.getByTestId("job-alert")).toHaveTextContent("Job timed out (timeout after 120000ms)"));
    // The same element stays in the DOM and keeps focus across polls and the terminal update.
    expect(document.activeElement).toBe(cancel);
    expect(cancel).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Job timed out");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("region", { name: "Analyze run" })).toBeInTheDocument();
    for (const name of ["Start job", "Cancel job", "Retry"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("E02-AC3 repeated polls with the same state do not change the live region text", async () => {
    installFetch({ create: [{ status: 202, body: job() }], poll: [{ status: 200, body: job() }] });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start job" }));
    const status = screen.getByTestId("job-status");
    await waitFor(() => expect(status).toHaveTextContent("Job is running."));
    const mutations: MutationRecord[] = [];
    const obs = new MutationObserver((m) => mutations.push(...m));
    obs.observe(status, { childList: true, characterData: true, subtree: true });
    await act(() => new Promise((r) => setTimeout(r, 60)));
    obs.disconnect();
    expect(mutations).toHaveLength(0);
  });
});
