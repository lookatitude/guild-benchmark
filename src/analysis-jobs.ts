// D02 — local asynchronous packaged-CLI jobs (C-JOBS endpoints' engine).
// Mutation requests (analyze / compare / recommendation_decide) run the ONE
// validated packaged plugin CLI (D00 descriptor) as a bounded child process:
// shell:false argv map, allowlisted env, byte-counted output caps, timeout
// with SIGTERM→SIGKILL group escalation, terminal state only after the real
// child close. Benchmark never writes canonical files itself and never
// accepts a caller-supplied command, root or executable. Job state is
// process-local and volatile: a server restart yields 404 for old job ids
// (the producer's own lock owns cross-process safety).
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import {
  TRANSPORT_LIMITS,
  isSafeAnalysisId,
  type PackagedRuntime,
} from "./analysis-process.js";

export type AnalysisOperation =
  | "analyze"
  | "compare"
  | "inspect"
  | "recommendation_decide";

export type AnalysisTargetKind =
  | "run"
  | "runs"
  | "initiative"
  | "independent"
  | "comparison";

export type AnalysisJobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

/** C-JOBS §request_fields — the ONLY accepted job request shape. Unknown
 * fields are rejected by the server-side parser (no arbitrary command, root
 * or argv material can ride along). */
export interface AnalysisJobRequest {
  source_guild: string;
  operation: Exclude<AnalysisOperation, "inspect">;
  target_kind: AnalysisTargetKind;
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
  operation: AnalysisOperation;
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

interface JobInternal {
  view: AnalysisJobView;
  request: AnalysisJobRequest;
  canonicalRoot: string;
  dedupeKey: string;
  cancelRequested: boolean;
  child?: ReturnType<typeof spawn>;
  signalTree?: (signal: NodeJS.Signals) => void;
}

export type CreateJobResult =
  | { kind: "created"; job: AnalysisJobView }
  | { kind: "deduplicated"; job: AnalysisJobView }
  | { kind: "conflict"; active: AnalysisJobView }
  | { kind: "invalid"; error: string };

export interface AnalysisJobLimits {
  /** Test override; clamped to the C-JOBS cap, never above it. */
  timeoutMs?: number;
}

// Canonical producer input-hash form is `sha256:<64 lowercase hex>` (the
// artifact's diagnostics.input_hash format; E03 F3 orchestrator ruling). A
// bare hex digest is accepted for compatibility and normalized to canonical.
const SHA256_INPUT_HASH = /^(sha256:)?[a-f0-9]{64}$/;

export function canonicalInputHash(value: string): string {
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function excerpt(buf: string, max = 512): string {
  return buf.length > max ? `${buf.slice(0, max)}…` : buf;
}

/** Light pre-spawn revalidation mirroring D00's (analysis-process owns the
 * full metadata recheck for inspection; jobs recheck the entry identity the
 * descriptor pinned — same contained-regular-file + SHA256 discipline). */
function entryStillValid(runtime: PackagedRuntime): string | null {
  try {
    const st = lstatSync(runtime.entryPath);
    if (!st.isFile()) return "entry is no longer a regular file";
    const phys = realpathSync(runtime.entryPath);
    const rel = relative(runtime.packageRoot, phys);
    if (phys !== runtime.entryPath || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      return "entry path no longer resolves inside the package root";
    }
    const sha = createHash("sha256").update(readFileSync(runtime.entryPath)).digest("hex");
    if (sha !== runtime.entrySha256) return "entry bytes changed since startup validation";
  } catch {
    return "entry no longer exists";
  }
  return null;
}

/** Build the closed C-CLI argv map for a validated request. Returns an error
 * string for any combination outside the fixed mappings. */
export function buildProducerArgv(
  req: AnalysisJobRequest,
  canonicalRoot: string,
  entryPath: string,
): { argv: string[] } | { error: string } {
  const cwdFlag = ["--cwd", canonicalRoot];
  if (req.operation === "analyze") {
    if (req.target_kind === "run" && req.ids.length === 1) {
      return { argv: [entryPath, "run", "analyze", req.ids[0], ...cwdFlag] };
    }
    if (req.target_kind === "initiative" && req.ids.length === 1) {
      return { argv: [entryPath, "initiative", "analyze", req.ids[0], ...cwdFlag] };
    }
    if (req.target_kind === "independent" && req.ids.length === 1) {
      return { argv: [entryPath, "independent-runs", "analyze", req.ids[0], ...cwdFlag] };
    }
    return { error: "analyze requires target_kind run|initiative|independent with exactly one id" };
  }
  if (req.operation === "compare") {
    if (req.target_kind !== "runs" || req.ids.length < 2) {
      return { error: "compare requires target_kind runs with 2..100 ids" };
    }
    if (new Set(req.ids).size !== req.ids.length) {
      return { error: "duplicate comparison ids rejected" };
    }
    return { argv: [entryPath, "run", "compare", ...req.ids, ...cwdFlag] };
  }
  // recommendation_decide — browser-originated consent REQUIRES both expected
  // guards (C-CLI §conditional_decision); the manual no-flag operator CLI
  // authority is deliberately unreachable from this bridge.
  if (req.ids.length !== 1) return { error: "recommendation_decide requires exactly one source id" };
  if (req.decision !== "accept" && req.decision !== "reject") {
    return { error: "decision must be accept or reject" };
  }
  if (typeof req.recommendation_id !== "string" || !isSafeAnalysisId(req.recommendation_id)) {
    return { error: "recommendation_id is required and must be a safe id" };
  }
  if (
    typeof req.source_analysis_id !== "string" ||
    req.source_analysis_id.length === 0 ||
    req.source_analysis_id.length > 256 ||
    // Control characters (NUL above all) would blow up spawn argv (codex F6).
    /[\u0000-\u001f\u007f]/.test(req.source_analysis_id)
  ) {
    return { error: "source_analysis_id (expected analysis identity) is required and must be printable" };
  }
  if (typeof req.source_input_hash !== "string" || !SHA256_INPUT_HASH.test(req.source_input_hash)) {
    return { error: "source_input_hash must be a producer sha256 digest (sha256:<64 lowercase hex> or bare hex)" };
  }
  return {
    argv: [
      entryPath,
      "recommendation",
      "decide",
      req.ids[0],
      req.recommendation_id,
      req.decision,
      "--expected-analysis-id",
      req.source_analysis_id,
      "--expected-input-hash",
      canonicalInputHash(req.source_input_hash),
      ...cwdFlag,
    ],
  };
}

export class AnalysisJobManager {
  private readonly runtime: PackagedRuntime;
  private readonly limits: AnalysisJobLimits;
  private readonly jobs = new Map<string, JobInternal>();
  /** C-JOBS: ONE active analysis job per canonical root, process-local. */
  private readonly activeByRoot = new Map<string, string>();

  constructor(runtime: PackagedRuntime, limits: AnalysisJobLimits = {}) {
    this.runtime = runtime;
    this.limits = limits;
  }

  getJob(jobId: string): AnalysisJobView | undefined {
    return this.jobs.get(jobId)?.view;
  }

  /** Request abort; 202-style semantics — the job turns terminal
   * (`cancelled`) only after the real child close. Idempotent: repeated
   * cancels schedule no further escalation timers. */
  cancelJob(jobId: string): AnalysisJobView | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    if (
      (job.view.state === "queued" || job.view.state === "running") &&
      !job.cancelRequested
    ) {
      job.cancelRequested = true;
      job.signalTree?.("SIGTERM");
      setTimeout(() => job.signalTree?.("SIGKILL"), TRANSPORT_LIMITS.cancel_grace_ms).unref();
    }
    return job.view;
  }

  createJob(req: AnalysisJobRequest, canonicalRoot: string): CreateJobResult {
    const built = buildProducerArgv(req, canonicalRoot, this.runtime.entryPath);
    if ("error" in built) return { kind: "invalid", error: built.error };

    const dedupeKey = [
      canonicalRoot,
      req.operation,
      req.target_kind,
      req.ids.join(","),
      req.idempotency_key,
      req.decision ?? "",
      req.recommendation_id ?? "",
      req.source_analysis_id ?? "",
      // Normalized so `sha256:<hex>` and bare hex dedupe as the same guard.
      req.source_input_hash !== undefined ? canonicalInputHash(req.source_input_hash) : "",
    ].join("\u0000");

    const activeId = this.activeByRoot.get(canonicalRoot);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && (active.view.state === "queued" || active.view.state === "running")) {
        if (active.dedupeKey === dedupeKey) {
          // Same key/action/IDs/guards while in flight → same job, no second
          // spawn (D02-AC1).
          return { kind: "deduplicated", job: active.view };
        }
        return { kind: "conflict", active: active.view };
      }
      this.activeByRoot.delete(canonicalRoot);
    }

    // Completed same-key reuse (200) is allowed by C-JOBS only when the
    // expected context is proven still current. This bridge cannot prove that
    // without a fresh producer inspection, so it always starts a new job for
    // a terminal key: the producer's own lock + expected-context guards stay
    // the authority (honest-over-fast).
    const staleEntry = entryStillValid(this.runtime);
    if (staleEntry) return { kind: "invalid", error: `entry_changed: ${staleEntry}` };

    const jobId = `job-${randomUUID()}`;
    const view: AnalysisJobView = {
      job_id: jobId,
      source_guild: req.source_guild,
      operation: req.operation,
      state: "queued",
      created_at: new Date().toISOString(),
      started_at: null,
      closed_at: null,
      exit_code: null,
      signal: null,
      stdout_excerpt: "",
      stderr_excerpt: "",
      artifact_refs: [],
      reason: null,
    };
    const job: JobInternal = { view, request: req, canonicalRoot, dedupeKey, cancelRequested: false };
    this.jobs.set(jobId, job);
    this.activeByRoot.set(canonicalRoot, jobId);
    this.spawnJob(job, built.argv, canonicalRoot);
    return { kind: "created", job: view };
  }

  private spawnJob(job: JobInternal, argv: string[], canonicalRoot: string): void {
    const timeoutMs = Math.min(
      this.limits.timeoutMs ?? TRANSPORT_LIMITS.timeout_ms,
      TRANSPORT_LIMITS.timeout_ms,
    );
    // Allowlisted child env — same discipline as the D00 transport (no
    // NODE_OPTIONS preloads).
    const childEnv: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
      const v = process.env[key];
      if (v !== undefined) childEnv[key] = v;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.runtime.nodePath, argv, {
        shell: false,
        cwd: canonicalRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv,
        detached: true,
      });
    } catch (err) {
      // A synchronous spawn throw (e.g. invalid argv) must not leave a
      // permanently queued job holding the root (codex F6).
      this.closeJob(job, {
        state: "failed",
        reason: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
      });
      return;
    }
    job.child = child;
    job.view.state = "running";
    job.view.started_at = new Date().toISOString();

    const signalTree = (signal: NodeJS.Signals) => {
      // After close the pid/pgid may be reused by an unrelated process —
      // stale escalation timers must become no-ops (codex r3 / security F2).
      if (job.view.closed_at !== null) return;
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* group gone */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* kill itself failed — close/exit handling owns the outcome */
      }
    };
    job.signalTree = signalTree;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let timedOut = false;

    // Reentrancy guard (codex F3 r2): a kill failure can emit 'error', whose
    // handler aborts again — one abort sequence is enough.
    let aborting = false;
    const abortChild = () => {
      if (aborting) return;
      aborting = true;
      signalTree("SIGTERM");
      setTimeout(() => signalTree("SIGKILL"), TRANSPORT_LIMITS.cancel_grace_ms).unref();
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, TRANSPORT_LIMITS.cancel_grace_ms * 2).unref();
    };
    const killTimer = setTimeout(() => {
      timedOut = true;
      abortChild();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
      if (stdoutBytes > TRANSPORT_LIMITS.stdout_bytes) {
        overflowed = true;
        abortChild();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stderrBytes += chunk.byteLength;
      stderrChunks.push(chunk);
      if (stderrBytes > TRANSPORT_LIMITS.stderr_bytes) {
        overflowed = true;
        abortChild();
      }
    });
    let spawnError: string | null = null;
    child.on("error", (err) => {
      // Do NOT finalize here (codex F3): a signaling error can fire while
      // the child is still alive, and releasing per-root exclusivity early
      // would allow a second concurrent producer. If the process never
      // started (no pid) there will be no close event — finalize directly;
      // otherwise force the child down and let close classify.
      spawnError = err.message;
      if (child.pid === undefined) {
        clearTimeout(killTimer);
        this.closeJob(job, {
          state: "failed",
          reason: `spawn failed: ${err.message}`,
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
        });
        return;
      }
      abortChild();
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      // Terminal classification ONLY here, after the real close (D02-AC2).
      // Overflow is mandatory failed/output_limit (C-JOBS) and outranks
      // cancel/timeout (codex F5).
      if (overflowed) {
        this.closeJob(job, { state: "failed", reason: "output_limit", exitCode: code, signal, stdout, stderr });
        return;
      }
      if (job.cancelRequested) {
        this.closeJob(job, { state: "cancelled", reason: "cancelled by request", exitCode: code, signal, stdout, stderr });
        return;
      }
      if (timedOut) {
        this.closeJob(job, { state: "timed_out", reason: `timeout after ${timeoutMs}ms`, exitCode: code, signal, stdout, stderr });
        return;
      }
      if (spawnError !== null) {
        this.closeJob(job, { state: "failed", reason: `child error: ${spawnError}`, exitCode: code, signal, stdout, stderr });
        return;
      }
      if (code === 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          parsed = undefined;
        }
        const validated =
          parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
            ? { error: "stdout is not a JSON object" }
            : validateProducerSuccess(job.request, parsed as Record<string, unknown>, job.canonicalRoot);
        if ("error" in validated) {
          this.closeJob(job, {
            state: "failed",
            reason: `producer_result_invalid: ${validated.error}`,
            exitCode: code,
            signal,
            stdout,
            stderr,
          });
          return;
        }
        this.closeJob(job, {
          state: "succeeded",
          reason: null,
          exitCode: code,
          signal,
          stdout,
          stderr,
          artifactRefs: validated.refs,
        });
        return;
      }
      this.closeJob(job, {
        state: "failed",
        reason: `producer exited ${code ?? `signal ${signal ?? "unknown"}`}`,
        exitCode: code,
        signal,
        stdout,
        stderr,
      });
    });
  }

  private closeJob(
    job: JobInternal,
    outcome: {
      state: AnalysisJobState;
      reason: string | null;
      exitCode: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      artifactRefs?: string[];
    },
  ): void {
    if (job.view.closed_at !== null) return;
    job.view.state = outcome.state;
    job.view.reason = outcome.reason;
    job.view.closed_at = new Date().toISOString();
    job.view.exit_code = outcome.exitCode;
    job.view.signal = outcome.signal;
    job.view.stdout_excerpt = excerpt(outcome.stdout);
    job.view.stderr_excerpt = excerpt(outcome.stderr);
    job.view.artifact_refs = outcome.artifactRefs ?? [];
    // Release heavyweight references (security F1): the child process,
    // its listeners and the signaling closure are not needed once terminal —
    // only the serializable view survives for polling.
    job.child = undefined;
    job.signalTree = undefined;
    if (this.activeByRoot.get(job.canonicalRoot) === job.view.job_id) {
      this.activeByRoot.delete(job.canonicalRoot);
    }
    // Re-insert so Map order reflects COMPLETION time; pruning then evicts
    // the oldest-finished job, never the most recently closed one.
    this.jobs.delete(job.view.job_id);
    this.jobs.set(job.view.job_id, job);
    this.pruneTerminalJobs();
  }

  /** Bound terminal retention: keep the most recent MAX_TERMINAL_JOBS
   * finished views (Map preserves insertion order); active jobs are never
   * evicted. Evicted ids poll as 404, the same as after a restart. */
  private pruneTerminalJobs(): void {
    const terminalIds: string[] = [];
    for (const [id, job] of this.jobs) {
      if (job.view.closed_at !== null) terminalIds.push(id);
    }
    const excess = terminalIds.length - MAX_TERMINAL_JOBS;
    for (let i = 0; i < excess; i++) this.jobs.delete(terminalIds[i]);
  }
}

/** How many finished jobs stay pollable (security F1 — bounded retention). */
export const MAX_TERMINAL_JOBS = 200;

/** Validate the zero-exit producer JSON AGAINST the request it answers
 * (codex F2): `ok:true` alone is not success. Each operation must carry its
 * identity fields, compare results must cover the requested run ids, and
 * artifact refs must be traversal-free relative paths — pass-through only,
 * never invented. */
export function validateProducerSuccess(
  req: AnalysisJobRequest,
  result: Record<string, unknown>,
  canonicalRoot: string,
): { refs: string[] } | { error: string } {
  if (result.ok !== true) return { error: "ok is not true" };
  if (req.operation === "analyze" && req.target_kind === "run") {
    if (typeof result.analysis_id !== "string" || result.analysis_id.length === 0) {
      return { error: "analyze result missing analysis_id" };
    }
    // Bind the result to THIS run (codex F2 r2): the shipped producer's
    // analysis identity is `analysis:<run-id>:<hash>` (contract example) —
    // another run's analysis cannot satisfy this request.
    if (!result.analysis_id.startsWith(`analysis:${req.ids[0]}:`)) {
      return { error: `analysis_id does not reference the requested run: ${result.analysis_id}` };
    }
    if (typeof result.eligible !== "boolean") {
      return { error: "analyze result missing eligible" };
    }
  } else if (req.operation === "analyze" || req.operation === "compare") {
    // compare / initiative / independent all produce a comparison.
    if (typeof result.comparison_id !== "string" || result.comparison_id.length === 0) {
      return { error: "comparison result missing comparison_id" };
    }
    if (req.operation === "compare") {
      const runIds = Array.isArray(result.run_ids) ? result.run_ids : undefined;
      if (!runIds || !req.ids.every((id) => runIds.includes(id))) {
        return { error: "comparison result does not cover the requested run ids" };
      }
    }
  }
  // recommendation_decide: the producer's own critical section is the
  // authority; ok:true plus a non-error exit is the commit signal, and no
  // artifact refs are expected.
  const refs: string[] = [];
  const written = result.written;
  // The shipped analyze producer emits `written` as an OBJECT of absolute
  // paths ({json, markdown}); string / string[] remain accepted (E03 F4).
  const candidates: unknown[] =
    typeof written === "string"
      ? [written]
      : Array.isArray(written)
        ? written
        : written !== null && typeof written === "object"
          ? Object.values(written)
          : [];
  // Analyze-run refs must live under THAT run's canonical analysis dir; other
  // operations' refs stay inside the canonical analysis tree (codex F2 r2).
  const requiredPrefix =
    req.operation === "analyze" && req.target_kind === "run"
      ? `.guild/analysis/runs/${req.ids[0]}/`
      : ".guild/analysis/";
  for (const w of candidates) {
    if (typeof w !== "string") return { error: "written entries must be strings" };
    // Absolute producer paths are resolved to their PHYSICAL path (codex F1:
    // lexical containment alone would let a symlinked component point outside
    // the root) and relativized against the canonical root, which the server
    // already realpathed; anything outside it is an escape, and an
    // unresolvable path fails closed.
    let ref = w;
    if (isAbsolute(ref)) {
      let phys: string;
      try {
        phys = realpathSync(ref);
      } catch {
        return { error: `artifact ref does not resolve on disk: ${w}` };
      }
      const rel = relative(canonicalRoot, phys);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return { error: `artifact ref escapes the canonical root: ${w}` };
      }
      ref = rel.split(sep).join("/");
    }
    if (ref.split(/[\\/]/).includes("..")) {
      return { error: `artifact ref escapes the canonical root: ${w}` };
    }
    if (!ref.startsWith(requiredPrefix)) {
      return { error: `artifact ref outside ${requiredPrefix}: ${w}` };
    }
    refs.push(ref);
  }
  return { refs };
}

/** Validate the raw POST body against the closed request shape. Unknown
 * fields are REJECTED (no arbitrary command/root/body arguments). */
export function parseAnalysisJobRequest(
  raw: unknown,
): { ok: true; value: AnalysisJobRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const allowed = new Set([
    "source_guild",
    "operation",
    "target_kind",
    "ids",
    "idempotency_key",
    "decision",
    "recommendation_id",
    "source_analysis_id",
    "source_input_hash",
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown field: ${key}` };
  }
  if (typeof obj.source_guild !== "string" || obj.source_guild.length === 0) {
    return { ok: false, error: "source_guild is required" };
  }
  const operation = obj.operation;
  if (operation !== "analyze" && operation !== "compare" && operation !== "recommendation_decide") {
    return { ok: false, error: "operation must be analyze, compare or recommendation_decide" };
  }
  const targetKind = obj.target_kind;
  if (
    targetKind !== "run" &&
    targetKind !== "runs" &&
    targetKind !== "initiative" &&
    targetKind !== "independent" &&
    targetKind !== "comparison"
  ) {
    return { ok: false, error: "target_kind must be run|runs|initiative|independent|comparison" };
  }
  if (!Array.isArray(obj.ids) || obj.ids.length < 1 || obj.ids.length > 100) {
    return { ok: false, error: "ids must contain 1..100 entries" };
  }
  for (const id of obj.ids) {
    if (typeof id !== "string" || !isSafeAnalysisId(id)) {
      return { ok: false, error: "every id must be a safe id (max 128 chars)" };
    }
  }
  if (
    typeof obj.idempotency_key !== "string" ||
    obj.idempotency_key.length === 0 ||
    obj.idempotency_key.length > 128
  ) {
    return { ok: false, error: "idempotency_key must be a nonempty string of at most 128 chars" };
  }
  if (obj.decision !== undefined && obj.decision !== "accept" && obj.decision !== "reject") {
    return { ok: false, error: "decision must be accept or reject" };
  }
  for (const field of ["recommendation_id", "source_analysis_id", "source_input_hash"] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") {
      return { ok: false, error: `${field} must be a string` };
    }
  }
  return {
    ok: true,
    value: {
      source_guild: obj.source_guild,
      operation,
      target_kind: targetKind,
      ids: obj.ids as string[],
      idempotency_key: obj.idempotency_key,
      ...(obj.decision !== undefined ? { decision: obj.decision as "accept" | "reject" } : {}),
      ...(obj.recommendation_id !== undefined ? { recommendation_id: obj.recommendation_id as string } : {}),
      ...(obj.source_analysis_id !== undefined ? { source_analysis_id: obj.source_analysis_id as string } : {}),
      ...(obj.source_input_hash !== undefined ? { source_input_hash: obj.source_input_hash as string } : {}),
    },
  };
}
