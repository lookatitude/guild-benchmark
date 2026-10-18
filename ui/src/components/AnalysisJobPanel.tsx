// AnalysisJobPanel — runs one C-JOBS analysis job and shows its real state.
//
// The panel only reports what the server says. A job is complete only when
// the server reports a terminal state with closed_at set. A poll that returns
// 404 means the server no longer knows the job (restart or eviction): the
// result is unknown, never complete, and nothing restarts on its own.
// Cancel is a request; the job is cancelled only after the server reports
// the real process close. Buttons use aria-disabled (not disabled) so a
// focused control keeps focus while polls update the panel.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../lib/api";

export type AnalysisJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

/** C-JOBS §request_fields. */
export interface AnalysisJobRequestBody {
  source_guild: string;
  operation: "analyze" | "compare" | "recommendation_decide";
  target_kind: "run" | "runs" | "initiative" | "independent" | "comparison";
  ids: string[];
  idempotency_key: string;
  decision?: "accept" | "reject";
  recommendation_id?: string;
  source_analysis_id?: string;
  source_input_hash?: string;
}

/** C-JOBS §response_fields. */
export interface AnalysisJobView {
  job_id: string;
  source_guild: string;
  operation: string;
  state: AnalysisJobState;
  created_at: string;
  started_at: string | null;
  closed_at: string | null;
  exit_code: number | null;
  signal: string | null;
  stdout_excerpt: string;
  stderr_excerpt: string;
  artifact_refs: string[];
  reason: string | null;
}

const STATES: readonly string[] = ["queued", "running", "succeeded", "failed", "cancelled", "timed_out"];
const TERMINAL: readonly string[] = ["succeeded", "failed", "cancelled", "timed_out"];
const WRAP: CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 };

/** How many explicit retries one panel allows before it asks for a reload. */
export const MAX_JOB_RETRIES = 3;
export const DEFAULT_POLL_MS = 1500;

const isStr = (v: unknown): v is string => typeof v === "string";
const isNullableStr = (v: unknown) => v === null || typeof v === "string";
const isNullableNum = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));

export function isAnalysisJobView(v: unknown): v is AnalysisJobView {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const j = v as Record<string, unknown>;
  return (
    isStr(j.job_id) &&
    isStr(j.source_guild) &&
    isStr(j.operation) &&
    isStr(j.state) &&
    STATES.includes(j.state) &&
    isStr(j.created_at) &&
    isNullableStr(j.started_at) &&
    isNullableStr(j.closed_at) &&
    isNullableNum(j.exit_code) &&
    isNullableStr(j.signal) &&
    isStr(j.stdout_excerpt) &&
    isStr(j.stderr_excerpt) &&
    Array.isArray(j.artifact_refs) &&
    j.artifact_refs.every(isStr) &&
    isNullableStr(j.reason)
  );
}

/** Terminal only when the server reports a terminal state AND a real close:
 * closed_at must be a non-empty, parseable timestamp. */
export function isJobClosed(job: AnalysisJobView): boolean {
  return (
    TERMINAL.includes(job.state) &&
    isStr(job.closed_at) &&
    job.closed_at.length > 0 &&
    Number.isFinite(Date.parse(job.closed_at))
  );
}

/** A report whose fields contradict each other is never shown as success. */
export function jobInconsistency(job: AnalysisJobView): string | null {
  if (job.state === "succeeded" && job.exit_code !== null && job.exit_code !== 0) {
    return `the server reported succeeded with exit code ${job.exit_code}`;
  }
  return null;
}

export const analysisJobsApi = {
  session: () => `${api.base}/project/analysis/session`,
  jobs: () => `${api.base}/project/analysis/jobs`,
  job: (id: string) => `${api.base}/project/analysis/jobs/${encodeURIComponent(id)}`,
  cancel: (id: string) => `${api.base}/project/analysis/jobs/${encodeURIComponent(id)}/cancel`,
};

export type JobCallResult =
  | { kind: "job"; job: AnalysisJobView }
  | { kind: "inconsistent"; job: AnalysisJobView; message: string }
  | { kind: "unknown" }
  | { kind: "conflict"; active: AnalysisJobView | null }
  | { kind: "unconfigured"; hint: string | null }
  | { kind: "forbidden"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "malformed" }
  | { kind: "error"; message: string };

function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && isStr((body as Record<string, unknown>).error)) {
    return (body as Record<string, string>).error;
  }
  return fallback;
}

async function classify(res: Response): Promise<JobCallResult> {
  const body: unknown = await res.json().catch(() => undefined);
  if (res.ok) {
    if (!isAnalysisJobView(body)) return { kind: "malformed" };
    const message = jobInconsistency(body);
    return message ? { kind: "inconsistent", job: body, message } : { kind: "job", job: body };
  }
  if (res.status === 404) return { kind: "unknown" };
  if (res.status === 409) {
    const active = body && typeof body === "object" ? (body as Record<string, unknown>).active : undefined;
    return { kind: "conflict", active: isAnalysisJobView(active) ? active : null };
  }
  if (res.status === 503) {
    const hint = body && typeof body === "object" ? (body as Record<string, unknown>).hint : undefined;
    return { kind: "unconfigured", hint: isStr(hint) ? hint : null };
  }
  if (res.status === 403) return { kind: "forbidden", message: errorText(body, "forbidden") };
  if (res.status === 400 || res.status === 413) return { kind: "invalid", message: errorText(body, `HTTP ${res.status}`) };
  return { kind: "error", message: errorText(body, `HTTP ${res.status}`) };
}

/** Action token for mutative routes. Kept in component memory only; it is
 * never written to storage, and a 403 drops it so the next call refetches. */
export function useActionToken() {
  const token = useRef<string | null>(null);
  const get = useCallback(async (): Promise<string | null> => {
    if (token.current) return token.current;
    const res = await fetch(analysisJobsApi.session(), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => undefined);
    const value = body && typeof body === "object" ? (body as Record<string, unknown>).action_token : undefined;
    token.current = isStr(value) && value.length > 0 ? value : null;
    return token.current;
  }, []);
  const drop = useCallback(() => {
    token.current = null;
  }, []);
  return { get, drop };
}

export type JobPanelState =
  | { phase: "idle" }
  | { phase: "submitting" }
  | { phase: "tracking"; job: AnalysisJobView; cancelRequested: boolean }
  | { phase: "inconsistent"; job: AnalysisJobView; message: string }
  | { phase: "unknown"; jobId: string; last: AnalysisJobView | null }
  | { phase: "conflict"; active: AnalysisJobView | null }
  | { phase: "unconfigured"; hint: string | null }
  | { phase: "refused"; message: string };

/** Starts, polls and cancels one job at a time. The job is bound to the
 * context key it started under; a later key marks it stale. */
export function useAnalysisJob(pollIntervalMs: number = DEFAULT_POLL_MS) {
  const [state, setState] = useState<JobPanelState>({ phase: "idle" });
  const [startedKey, setStartedKey] = useState<string | null>(null);
  const { get, drop } = useActionToken();
  // Every start or reset opens a new attempt. A response carries the attempt
  // it was sent under and is dropped when that attempt is no longer current.
  const attemptRef = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // jobId is null only for a new start. A poll or cancel result applies only
  // to the open job it was sent for; it never replaces another job and never
  // downgrades a settled (closed or inconsistent) display.
  const apply = useCallback((result: JobCallResult, jobId: string | null, last: AnalysisJobView | null, attempt: number) => {
    if (!mounted.current || attempt !== attemptRef.current) return;
    if (result.kind === "forbidden") drop();
    const next = (prev: JobPanelState): JobPanelState => {
      switch (result.kind) {
        case "job":
          return {
            phase: "tracking",
            job: result.job,
            cancelRequested: prev.phase === "tracking" && prev.job.job_id === result.job.job_id && prev.cancelRequested,
          };
        case "inconsistent":
          return { phase: "inconsistent", job: result.job, message: result.message };
        case "unknown":
          return { phase: "unknown", jobId: jobId ?? "unknown", last };
        case "conflict":
          return { phase: "conflict", active: result.active };
        case "unconfigured":
          return { phase: "unconfigured", hint: result.hint };
        case "forbidden":
          return { phase: "refused", message: `the server refused the action token (${result.message})` };
        case "invalid":
          return { phase: "refused", message: `the server refused the request (${result.message})` };
        case "malformed":
          return { phase: "refused", message: "the server sent a job response this page cannot read" };
        case "error":
          return { phase: "refused", message: result.message };
      }
    };
    setState((prev) => {
      if (jobId === null) return next(prev);
      const current = prev.phase === "tracking" && prev.job.job_id === jobId && !isJobClosed(prev.job);
      return current ? next(prev) : prev;
    });
  }, [drop]);

  const start = useCallback(
    async (request: AnalysisJobRequestBody, contextKey: string) => {
      const attempt = ++attemptRef.current;
      setState({ phase: "submitting" });
      setStartedKey(contextKey);
      try {
        const token = await get();
        if (!token) {
          apply({ kind: "forbidden", message: "no action token from /api/project/analysis/session" }, null, null, attempt);
          return;
        }
        const res = await fetch(analysisJobsApi.jobs(), {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "X-Guild-Action-Token": token },
          body: JSON.stringify(request),
        });
        apply(await classify(res), null, null, attempt);
      } catch (err) {
        apply({ kind: "error", message: err instanceof Error ? err.message : String(err) }, null, null, attempt);
      }
    },
    [apply, get],
  );

  const cancel = useCallback(async () => {
    if (state.phase !== "tracking" || isJobClosed(state.job)) return;
    const job = state.job;
    const attempt = attemptRef.current;
    setState((prev) =>
      prev.phase === "tracking" && prev.job.job_id === job.job_id && !isJobClosed(prev.job) ? { ...prev, cancelRequested: true } : prev,
    );
    try {
      const token = await get();
      if (!token) {
        apply({ kind: "forbidden", message: "no action token" }, job.job_id, job, attempt);
        return;
      }
      const res = await fetch(analysisJobsApi.cancel(job.job_id), {
        method: "POST",
        headers: { accept: "application/json", "X-Guild-Action-Token": token },
      });
      apply(await classify(res), job.job_id, job, attempt);
    } catch (err) {
      apply({ kind: "error", message: err instanceof Error ? err.message : String(err) }, job.job_id, job, attempt);
    }
  }, [apply, get, state]);

  const reset = useCallback(() => {
    attemptRef.current++;
    setState({ phase: "idle" });
    setStartedKey(null);
  }, []);

  // Poll only while the server reports an open job.
  const pollJob = state.phase === "tracking" && !isJobClosed(state.job) ? state.job : null;
  const pollId = pollJob?.job_id ?? null;
  const lastRef = useRef<AnalysisJobView | null>(null);
  lastRef.current = pollJob;
  useEffect(() => {
    if (!pollId) return;
    let stopped = false;
    const attempt = attemptRef.current;
    const timer = setInterval(() => {
      fetch(analysisJobsApi.job(pollId), { headers: { accept: "application/json" } })
        .then(classify)
        .then((result) => {
          if (!stopped) apply(result, pollId, lastRef.current, attempt);
        })
        .catch((err) => {
          if (!stopped) apply({ kind: "error", message: err instanceof Error ? err.message : String(err) }, pollId, lastRef.current, attempt);
        });
    }, pollIntervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [apply, pollId, pollIntervalMs]);

  return { state, startedKey, start, cancel, reset };
}

export type JobView =
  | { tone: "progress"; text: string }
  | { tone: "done"; text: string }
  | { tone: "failure"; text: string }
  | { tone: "neutral"; text: string };

/** One sentence for the current state. Completion is stated only for a
 * closed job; everything else says what is still unknown. */
export function describeJobState(state: JobPanelState): JobView {
  switch (state.phase) {
    case "idle":
      return { tone: "neutral", text: "No job started." };
    case "submitting":
      return { tone: "progress", text: "Sending the job request." };
    case "tracking": {
      const { job, cancelRequested } = state;
      if (!isJobClosed(job)) {
        if (TERMINAL.includes(job.state)) {
          return { tone: "progress", text: `The server reports ${job.state} but the process has not closed. Waiting for the close.` };
        }
        if (cancelRequested) return { tone: "progress", text: `Cancel requested. The job stays ${job.state} until the process closes.` };
        return { tone: "progress", text: job.state === "queued" ? "Job is queued." : "Job is running." };
      }
      if (job.state === "succeeded") {
        return {
          tone: "done",
          text:
            job.artifact_refs.length > 0
              ? `Job succeeded. The producer reported ${job.artifact_refs.length} artifact${job.artifact_refs.length === 1 ? "" : "s"}.`
              : "Job succeeded. The producer reported no artifact.",
        };
      }
      if (job.state === "cancelled") return { tone: "failure", text: "Job cancelled. The process closed. Partial artifacts are not removed." };
      if (job.state === "timed_out") return { tone: "failure", text: `Job timed out${job.reason ? ` (${job.reason})` : ""}. No result is reported.` };
      return { tone: "failure", text: `Job failed${job.reason ? `: ${job.reason}` : ""}. No result is reported.` };
    }
    case "inconsistent":
      return {
        tone: "failure",
        text: `The server sent an inconsistent job report: ${state.message}. The result is not trusted. Check the saved analysis artifacts.`,
      };
    case "unknown":
      return {
        tone: "failure",
        text: "The server does not know this job any more. The server may have restarted. The result is unknown and nothing was restarted. Check the saved analysis artifacts before you start again.",
      };
    case "conflict":
      return {
        tone: "failure",
        text: `Another analysis job is active for this project${state.active ? ` (${state.active.job_id}, ${state.active.state})` : ""}. Nothing was started. Wait for it to finish, then try again.`,
      };
    case "unconfigured":
      return {
        tone: "neutral",
        text: `Analysis jobs are unavailable: no analysis package is configured${state.hint ? ` (${state.hint})` : ""}. Nothing was started.`,
      };
    case "refused":
      return { tone: "failure", text: `Nothing was started: ${state.message}.` };
  }
}

/** Retry is allowed for a closed failure, an unknown job, an inconsistent
 * report, a conflict or a refusal. Never for an open job, and never past the retry bound. */
function canRetry(state: JobPanelState): boolean {
  if (state.phase === "tracking") return isJobClosed(state.job) && state.job.state !== "succeeded";
  return state.phase === "unknown" || state.phase === "inconsistent" || state.phase === "conflict" || state.phase === "refused";
}

export interface AnalysisJobPanelProps {
  title: string;
  /** Request for the CURRENT context; the panel adds the idempotency key. */
  request: Omit<AnalysisJobRequestBody, "idempotency_key"> | null;
  /** Identity of the current context (e.g. analysis id + input hash). */
  contextKey: string;
  disabledReason: string | null;
  startLabel?: string;
  pollIntervalMs?: number;
  onClosed?: (job: AnalysisJobView) => void;
}

/** 64-bit FNV-1a style hash (two 32-bit lanes) as 16 hex chars. Sync, so key
 * building stays in the click handler. Not a security primitive. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// Bounded readable prefix + hash of the full raw key: long keys that share a
// prefix or tail, or differ only in sanitized characters, stay distinct.
function idempotencyKey(contextKey: string, attempt: number): string {
  const prefix = contextKey.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 64);
  return `ui-${prefix}-${shortHash(contextKey)}-${attempt}`;
}

function buttonGuard(blocked: boolean, action: () => void) {
  return () => {
    if (!blocked) action();
  };
}

export default function AnalysisJobPanel({
  title,
  request,
  contextKey,
  disabledReason,
  startLabel = "Start job",
  pollIntervalMs,
  onClosed,
}: AnalysisJobPanelProps) {
  const { state, startedKey, start, cancel } = useAnalysisJob(pollIntervalMs);
  const [attempts, setAttempts] = useState(0);
  const view = describeJobState(state);
  const stale = startedKey !== null && startedKey !== contextKey;
  const open = state.phase === "submitting" || (state.phase === "tracking" && !isJobClosed(state.job));
  const retriesLeft = MAX_JOB_RETRIES - Math.max(0, attempts - 1);

  const closedJob = state.phase === "tracking" && isJobClosed(state.job) ? state.job : null;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (closedJob && reported.current !== closedJob.job_id) {
      reported.current = closedJob.job_id;
      onClosed?.(closedJob);
    }
  }, [closedJob, onClosed]);

  const run = () => {
    if (!request) return;
    const next = attempts + 1;
    setAttempts(next);
    void start({ ...request, idempotency_key: idempotencyKey(contextKey, next) }, contextKey);
  };

  const startBlocked =
    !request || disabledReason !== null || open || state.phase !== "idle" ? true : false;
  const retryable = canRetry(state) || (stale && closedJob !== null);
  const retryBlocked = !request || disabledReason !== null || open || !retryable || retriesLeft <= 0;
  const cancelBlocked = !(state.phase === "tracking" && !isJobClosed(state.job)) || (state.phase === "tracking" && state.cancelRequested);
  const failure = view.tone === "failure";

  return (
    <section className="card" data-testid="analysis-job-panel" aria-label={title} style={WRAP}>
      <h3>{title}</h3>
      {disabledReason ? (
        <p className="muted" data-testid="job-disabled-reason">
          Disabled: {disabledReason}
        </p>
      ) : null}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          aria-disabled={startBlocked || undefined}
          onClick={buttonGuard(startBlocked, run)}
        >
          {startLabel}
        </button>
        <button
          type="button"
          aria-disabled={cancelBlocked || undefined}
          onClick={buttonGuard(cancelBlocked, () => void cancel())}
        >
          {state.phase === "tracking" && state.cancelRequested && !isJobClosed(state.job) ? "Cancel requested" : "Cancel job"}
        </button>
        <button
          type="button"
          aria-disabled={retryBlocked || undefined}
          onClick={buttonGuard(retryBlocked, run)}
        >
          {stale ? "Retry with current context" : "Retry"}
        </button>
      </div>
      {/* Polite status for progress; failures go to an assertive alert. The
          text only changes when the state changes, so polls do not repeat it. */}
      <p role="status" aria-live="polite" data-testid="job-status" data-job-tone={view.tone}>
        {failure ? "" : view.text}
      </p>
      <p role="alert" data-testid="job-alert">
        {failure ? view.text : ""}
      </p>
      {stale ? (
        <p className="muted" data-testid="job-stale-context">
          This job was started for an older analysis context. Its result does not describe the current context.
        </p>
      ) : null}
      {retryable && retriesLeft <= 0 ? (
        <p className="muted" data-testid="job-retry-exhausted">
          Retry limit reached ({MAX_JOB_RETRIES}). Reload the page to try again.
        </p>
      ) : null}
      {state.phase === "tracking" ? (
        <dl className="kv-grid" data-testid="job-detail">
          <dt>Job</dt>
          <dd style={WRAP}>{state.job.job_id}</dd>
          <dt>State</dt>
          <dd data-testid="job-state">{state.job.state}</dd>
          <dt>Closed</dt>
          <dd>{state.job.closed_at ?? "not closed"}</dd>
          {state.job.exit_code !== null ? (
            <>
              <dt>Exit code</dt>
              <dd>{state.job.exit_code}</dd>
            </>
          ) : null}
          {isJobClosed(state.job) && state.job.artifact_refs.length > 0 ? (
            <>
              <dt>Artifacts</dt>
              <dd>
                <ul data-testid="job-artifacts">
                  {state.job.artifact_refs.map((ref) => (
                    <li key={ref} style={WRAP}>
                      <code>{ref}</code>
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
          {isJobClosed(state.job) && state.job.state !== "succeeded" && state.job.stderr_excerpt ? (
            <>
              <dt>Error output</dt>
              <dd>
                <pre style={{ ...WRAP, whiteSpace: "pre-wrap" }}>{state.job.stderr_excerpt}</pre>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
