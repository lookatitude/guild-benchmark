// P05 run lineage read adapter (U01).
//
// Read-only consumer of the plugin's R04/R05/T03 on-disk records, validated
// against the frozen A02 v2 shapes (contracts/guild-stack/v2). No plugin source
// import. Every record is checked strictly; an invalid, foreign or misplaced
// record is listed as refused by path only, never echoed and never defaulted.
// Evidence paths, grants, arguments and writer scopes are not projected.

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProjectReadError, resolveProjectRunRow } from "./project-reader.js";
import { readContainedRegularFile } from "./safe-read.js";
import type {
  AuthorityCheck,
  AuthorityCheckCode,
  CloseBlocker,
  EntityRef,
  EvidenceSummary,
  LineageAttempt,
  LineageExecution,
  LineageOperation,
  LineageRun,
  LineageTransfer,
  ProjectRunLineageResponse,
  RefusedRecord,
  StateAxes,
  TransferState,
  UsageView,
} from "./run-lineage-types.js";

export type { ProjectRunLineageResponse } from "./run-lineage-types.js";

export const RECORD_MAX_BYTES = 1024 * 1024;
export const ANALYSIS_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_RECORDS_PER_DIR = 1000;

// ── Strict shape checker (A02 v2 common $defs) ───────────────────────────────

type Spec = (v: unknown) => boolean;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const REL_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\%\x00-\x1f])[^:]+$/;
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

export function isRfc3339(v: string): boolean {
  const m = TIME_RE.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, s, oh, om] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && s <= 59 && oh <= 23 && om <= 59;
}

const str = (max = 4096, re?: RegExp): Spec => (v) =>
  typeof v === "string" && [...v].length >= 1 && [...v].length <= max && (!re || re.test(v));
const id = str(128, ID_RE);
const hash = str(71, HASH_RE);
const time: Spec = (v) => typeof v === "string" && isRfc3339(v);
const relPath = str(1024, REL_PATH_RE);
const int = (min: number): Spec => (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const num0: Spec = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const bool: Spec = (v) => typeof v === "boolean";
const oneOf = (...vals: unknown[]): Spec => (v) => vals.includes(v);
const nullable = (s: Spec): Spec => (v) => v === null || s(v);
const anyObj: Spec = isObj;
const obj = (shape: Record<string, Spec>): Spec => (v) => {
  if (!isObj(v)) return false;
  const keys = Object.keys(shape);
  if (Object.keys(v).length !== keys.length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(v, k) && shape[k](v[k]));
};
const arr = (s: Spec, min: number, max: number): Spec => (v) =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(s);

const KINDS = ["initiative", "run", "execution", "host_session", "goal", "logical_task", "task_attempt", "agent_instance", "request", "operation", "decision", "workflow", "component", "invocation", "obligation", "memory", "knowledge", "candidate", "agent", "skill", "tool", "team", "loop", "config", "evaluation", "report", "benchmark_case", "transfer", "query"];
const entity = obj({ source_id: id, kind: oneOf(...KINDS), id, revision: hash });
const evidence = obj({
  source_id: id,
  path: relPath,
  sha256: hash,
  schema_version: str(),
  observed_at: time,
  availability: oneOf("available", "expired", "redacted", "missing", "unsupported"),
  reason: nullable(str()),
});
const stateAxes = obj({
  lifecycle: oneOf("created", "active", "suspended", "closed", "unknown"),
  outcome: oneOf("pending", "succeeded", "failed", "cancelled", "partial", "unknown"),
  acceptance: oneOf("pending", "verified", "rejected", "not_required", "unknown"),
  observability: oneOf("complete", "partial", "unavailable"),
});
const lineage = obj({
  source_id: id,
  run_id: id,
  execution_id: id,
  host_session_id: nullable(id),
  initiative_id: nullable(id),
  goal_id: nullable(id),
  logical_task_id: nullable(id),
  attempt_id: nullable(id),
  agent_instance_id: nullable(id),
  request_id: nullable(id),
});
const pins = obj({ assignment: hash, definition: hash, configuration: hash, workflow: hash, policy: hash });
const clock = obj({ domain: id, basis: oneOf("controller", "local_monotonic", "provider", "unknown"), comparable: bool, skew_bound_ms: nullable(num0) });
const interval = obj({ start: time, end: nullable(time), duration_ms: nullable(num0), clock });
const authority = obj({
  controller_source_id: id,
  controller_epoch: int(0),
  execution_id: nullable(id),
  attempt_id: nullable(id),
  writer_scope_hash: hash,
  source_disposition_revision: nullable(hash),
});
const budget = obj({
  mode: oneOf("strict_verified", "native_spend_threshold"),
  threshold_usd: num0,
  duration_limit_ms: int(1),
  overshoot_possible: bool,
  qualification: evidence,
  policy_hash: hash,
});
const errorDef = obj({ code: id, message: str(), retryable: bool });

export const isLogicalRun = obj({
  schema_version: oneOf("guild.logical_run.v2"),
  source_id: id,
  run_id: id,
  initiative_id: nullable(id),
  parent_run: nullable(entity),
  created_at: time,
  phase: oneOf("init", "ideate", "plan", "build", "qa", "ops"),
  initial_command: str(),
  initial_prompt_ref: nullable(evidence),
  controller: obj({ source_id: id, host_id: id, epoch: int(0), state: oneOf("active", "suspended"), failover: oneOf("manual_new_run_only") }),
  workflow_hash: hash,
  settings_hash: hash,
  execution_refs: arr(entity, 0, 1000),
  goal_refs: arr(entity, 0, 1000),
  state: stateAxes,
});
export const isExecutionSegment = obj({
  schema_version: oneOf("guild.execution_segment.v1"),
  lineage,
  original_host_id: id,
  host_session_id: nullable(id),
  issued_controller_epoch: int(0),
  adapter_capability_hash: hash,
  pins,
  admission: oneOf("active", "reconcile_only", "revoked", "sealed"),
  interval,
  observation_manifest: hash,
  seal_evidence: nullable(evidence),
});
export const isTaskAttempt = obj({
  schema_version: oneOf("guild.task_attempt.v1"),
  lineage,
  assignment_ref: evidence,
  ordinal: int(1),
  state: stateAxes,
  result_refs: arr(evidence, 0, 100),
  acceptance_subject_hash: nullable(hash),
  accepted_by_controller_epoch: nullable(int(0)),
  receipt_loss_reconciled: bool,
  uncertain_effects: bool,
});
const isSeal = obj({
  schema_version: oneOf("guild.stack.execution_segment_seal.v1"),
  source_id: id,
  run_id: id,
  execution_id: id,
  segment_revision: hash,
  sealed_by: obj({ operation_id: id, attempt_id: id, launch_hash: hash }),
  outcome_state: oneOf("exited", "cancelled", "timed_out"),
  outcome_sha256: hash,
  sealed_at: time,
});
const TRANSFER_STATES: TransferState[] = ["reserved", "target_prepared", "source_committed", "target_activated", "acknowledged", "recovery_needed", "aborted"];
export const isFollowupTransfer = obj({
  schema_version: oneOf("guild.followup_transfer.v1"),
  operation_id: id,
  source_work: entity,
  expected_disposition_revision: hash,
  reserved_disposition_revision: hash,
  destination_work: entity,
  destination_policy_hash: hash,
  payload_hash: hash,
  state: oneOf(...TRANSFER_STATES),
  source_commit: nullable(evidence),
  target_activation: nullable(evidence),
  target_ack: nullable(evidence),
  prepared_target_executable: oneOf(false),
  recorded_at: time,
});
const effect = obj({
  target: entity,
  before_hash: nullable(hash),
  after_hash: nullable(hash),
  action: oneOf("create", "update", "delete", "dispatch", "seal", "transfer"),
});
export const isOperationPreview = obj({
  schema_version: oneOf("guild.stack.operation-preview.v2"),
  operation_id: id,
  operation: id,
  source_id: id,
  session_id: id,
  targets: arr(entity, 1, 100),
  dependencies: arr(entity, 0, 100),
  input_schema_id: str(),
  arguments: anyObj,
  arguments_hash: hash,
  scope_revision: hash,
  capability_revision: hash,
  policy_revision: hash,
  authority,
  budget: nullable(budget),
  effects: arr(effect, 1, 100),
  expires_at: time,
  preview_hash: hash,
});
export const isApprovalRecord = obj({
  schema_version: oneOf("guild.stack.approval-record.v2"),
  decision_id: id,
  operation_id: id,
  source_id: id,
  session_id: id,
  preview_hash: hash,
  authority,
  decision: oneOf("approved", "rejected", "revise"),
  actor_label: str(),
  at: time,
  rationale: str(),
});
export const isOperationReceipt = obj({
  schema_version: oneOf("guild.stack.operation-receipt.v2"),
  operation_id: id,
  idempotency_id: id,
  source_id: id,
  preview_hash: hash,
  authority,
  state: oneOf("accepted", "running", "applied", "failed", "recovery_needed"),
  effect_kind: oneOf("dispatch", "segment_seal", "logical_outcome", "transfer_ack", "domain_write"),
  outcome: nullable(stateAxes),
  touched: arr(entity, 0, 100),
  evidence: arr(evidence, 0, 100),
  error: nullable(errorDef),
  recorded_at: time,
});
const nint = nullable(int(0));
const usage = obj({
  granularity: oneOf("leaf_request", "native_session"),
  observation_id: id,
  revision: int(0),
  final: bool,
  accounting_identity: id,
  parent_accounting_identity: nullable(id),
  inclusion: oneOf("leaf_exclusive", "parent_inclusive", "session_cumulative"),
  input_inclusive: nint,
  output: nint,
  cache_read_subset: nint,
  cache_write_subset: nint,
  total: nint,
  cost_usd: nullable(num0),
  cost_basis: oneOf("measured", "derived_estimate", "native_estimate", "unavailable"),
  currency: oneOf("USD"),
  pricing_version: nullable(str()),
  usage_semantics: oneOf("inclusive_input_cache_subset.v1", "provider_session_only.v1", "unknown"),
  coverage: anyObj,
  native_baseline_usd: nullable(num0),
  native_cumulative_usd: nullable(num0),
});
const isAnalysisPointer = obj({
  schema_version: oneOf("guild.run_analysis_pointer.v2"),
  source_id: id,
  run_id: id,
  analysis_id: id,
  cache_key: str(),
  analysis_sha256: hash,
});
/** Fields the projection reads are checked strictly; metric series are carried opaque and not shown. */
const isRunAnalysis = obj({
  schema_version: oneOf("guild.run_analysis.v2"),
  run: entity,
  analysis_id: id,
  query: anyObj,
  input_evidence: arr(evidence, 0, 1000),
  usage: arr(usage, 0, 1000),
  state: stateAxes,
  metrics: arr(anyObj, 0, 104),
  unallocated_request_ids: arr(id, 0, 1000),
  losses: arr(obj({ code: id, count: nint, reason: str() }), 0, 100),
});

// ── A02 semantic rules for the consumed records (verify_contracts.semantic_errors) ──

/** Success requires verified acceptance, wherever state axes appear. */
const axesOk = (s: unknown) => !isObj(s) || s.outcome !== "succeeded" || s.acceptance === "verified";

export function semanticOk(kind: "logical-run" | "task-attempt" | "operation-preview" | "approval-record" | "operation-receipt", v: Obj): boolean {
  if (kind === "logical-run" || kind === "task-attempt") return axesOk(v.state);
  const auth = v.authority as Obj;
  if (auth.controller_source_id !== v.source_id) return false;
  if (kind === "operation-preview") {
    const owner = v.source_id;
    const targets = v.targets as EntityRef[];
    const effects = v.effects as { target: EntityRef }[];
    const tk = new Set(targets.map((t) => canonicalJson(t)));
    return targets.every((t) => t.source_id === owner)
      && effects.every((e) => e.target.source_id === owner && tk.has(canonicalJson(e.target)))
      && v.arguments_hash === sha256Text(canonicalJson(v.arguments));
  }
  if (kind === "operation-receipt") {
    const refs = [...(v.touched as Obj[]), ...(v.evidence as Obj[])];
    if (!refs.every((x) => x.source_id === v.source_id)) return false;
    if (v.effect_kind === "dispatch" && v.outcome !== null) return false;
    if ((v.state === "failed" || v.state === "recovery_needed") && v.error === null) return false;
    return axesOk(v.outcome);
  }
  return true;
}

// ── Canonical hashing (matches the plugin's stack canonical JSON) ────────────

export const sha256Text = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  throw new Error("unsupported JSON value");
}

export function previewHash(preview: Obj): string {
  return sha256Text(canonicalJson(Object.fromEntries(Object.entries(preview).filter(([k]) => k !== "preview_hash"))));
}

const entityKey = (e: { source_id: string; kind: string; id: string }) => `${e.source_id}\u0000${e.kind}\u0000${e.id}`;

// ── C4/C5 authority revalidation (AT40) ──────────────────────────────────────

export interface CurrentAuthority {
  source_id: string;
  controller_source_id: string;
  controller_epoch: number;
  /** Current revision of every entity this run can vouch for, keyed by (source_id, kind, id). */
  revisions: ReadonlyMap<string, string>;
  now: Date;
}

/**
 * Revalidate a preview and its approval against the run's current state.
 * Pure: reads nothing and writes nothing. Anything it cannot confirm is stale.
 */
export function checkOperationAuthority(preview: Obj, approval: Obj | null, current: CurrentAuthority): AuthorityCheck {
  const codes = new Set<AuthorityCheckCode>();
  const p = preview as {
    preview_hash: string; source_id: string; operation_id: string; session_id: string; expires_at: string;
    authority: { controller_source_id: string; controller_epoch: number };
    targets: EntityRef[]; dependencies: EntityRef[];
  };
  if (previewHash(preview) !== p.preview_hash) codes.add("preview_hash_mismatch");
  if (!(Date.parse(p.expires_at) > current.now.getTime())) codes.add("preview_expired");
  if (p.source_id !== current.source_id || p.authority.controller_source_id !== current.controller_source_id) codes.add("source_mismatch");
  if (p.authority.controller_epoch !== current.controller_epoch) codes.add("controller_epoch_mismatch");
  for (const t of p.targets) if (current.revisions.get(entityKey(t)) !== t.revision) codes.add("target_revision_stale");
  for (const d of p.dependencies) if (current.revisions.get(entityKey(d)) !== d.revision) codes.add("dependency_revision_stale");
  if (!approval) codes.add("approval_missing");
  else {
    const a = approval as { decision: string; operation_id: string; preview_hash: string; source_id: string; session_id: string; authority: unknown };
    if (a.decision !== "approved") codes.add("approval_not_approved");
    if (a.operation_id !== p.operation_id) codes.add("approval_operation_mismatch");
    if (a.preview_hash !== p.preview_hash) codes.add("approval_preview_mismatch");
    if (a.source_id !== p.source_id) codes.add("approval_source_mismatch");
    if (a.session_id !== p.session_id) codes.add("approval_session_mismatch");
    if (canonicalJson(a.authority) !== canonicalJson(p.authority)) codes.add("approval_authority_mismatch");
  }
  return { status: codes.size === 0 ? "pins_current" : "stale", codes: [...codes].sort() };
}

// ── Close blockers (display mirror of R04 evaluateTaskClose) ─────────────────

const isLive = (s: StateAxes) => s.lifecycle === "created" || s.lifecycle === "active";
const isOrphaned = (s: StateAxes) => !isLive(s) && (s.lifecycle !== "closed" || s.outcome === "pending" || s.outcome === "unknown");

export function deriveCloseBlockers(attempts: LineageAttempt[], transfers: LineageTransfer[]): CloseBlocker[] {
  const out: CloseBlocker[] = [];
  for (const t of transfers) if (t.state !== "acknowledged" && t.state !== "aborted") out.push({ code: "transfer_unacknowledged", subject: t.operation_id });
  const byTask = new Map<string, LineageAttempt[]>();
  for (const a of attempts) {
    const k = `${a.source_id}\u0000${a.logical_task_id ?? `attempt:${a.attempt_id}`}`;
    byTask.set(k, [...(byTask.get(k) ?? []), a]);
  }
  for (const group of byTask.values()) {
    group.sort((x, y) => x.ordinal - y.ordinal);
    for (const a of group) {
      if (isLive(a.state)) out.push({ code: "attempt_live", subject: a.attempt_id });
      if (isOrphaned(a.state)) out.push({ code: "attempt_orphaned", subject: a.attempt_id });
      if (!a.receipt_loss_reconciled) out.push({ code: "receipt_loss_unreconciled", subject: a.attempt_id });
      if (a.uncertain_effects) out.push({ code: "uncertain_effects", subject: a.attempt_id });
    }
    const f = group[group.length - 1];
    const accepted = f.state.lifecycle === "closed" && f.state.outcome === "succeeded" && f.state.acceptance === "verified"
      && f.accepted_by_controller_epoch !== null && f.acceptance_subject_hash !== null
      && f.results.length > 0 && f.results.every((r) => r.availability === "available");
    if (!accepted) out.push({ code: "no_accepted_final_evidence", subject: f.logical_task_id ?? f.attempt_id });
  }
  return out;
}

// ── File access ──────────────────────────────────────────────────────────────

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

interface Reader {
  read(rel: string, max?: number): Promise<{ text: string; json: unknown } | "absent" | "unreadable">;
  list(relDir: string, wantDirs: boolean): Promise<string[] | "too_many">;
  inputs: [string, string][];
}

function makeReader(rootReal: string, prefix: string): Reader {
  const inputs: [string, string][] = [];
  return {
    inputs,
    async read(rel, max = RECORD_MAX_BYTES) {
      const abs = join(rootReal, ...rel.split("/"));
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        return "absent";
      }
      if (!inside(rootReal, real)) return "unreadable";
      const got = await readContainedRegularFile(abs, max, rootReal);
      if (!got) return "unreadable";
      inputs.push([`${prefix}${rel}`, sha256Text(got.text)]);
      try {
        return { text: got.text, json: JSON.parse(got.text) };
      } catch {
        return "unreadable";
      }
    },
    async list(relDir, wantDirs) {
      let ents;
      try {
        const real = realpathSync(join(rootReal, ...relDir.split("/")));
        if (!inside(rootReal, real)) return [];
        ents = await readdir(real, { withFileTypes: true });
      } catch {
        return [];
      }
      // Dirent.isFile/isDirectory are false for symlinks, so links are skipped.
      const names = ents
        .filter((e) => (wantDirs ? e.isDirectory() : e.isFile() && e.name.endsWith(".json")) && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort();
      return names.length > MAX_RECORDS_PER_DIR ? "too_many" : names;
    },
  };
}

const summary = (e: Obj): EvidenceSummary => ({
  sha256: e.sha256 as string,
  schema_version: e.schema_version as string,
  availability: e.availability as EvidenceSummary["availability"],
  reason: e.reason as string | null,
});

// ── Projection ───────────────────────────────────────────────────────────────

/** The run directory, confirmed to sit physically where it sits lexically under the project root. */
function containedRunDir(projectRoot: string, runPath: string): string {
  let rootReal: string;
  let runReal: string;
  try {
    rootReal = realpathSync(projectRoot);
    runReal = realpathSync(runPath);
  } catch {
    throw new ProjectReadError("not_found", "run not found");
  }
  if (runReal !== resolve(rootReal, relative(resolve(projectRoot), runPath))) {
    throw new ProjectReadError("bad_request", "run directory escapes the project root");
  }
  return runReal;
}

export async function readProjectRunLineage(
  projectRoot: string,
  runId: string,
  guildName?: string,
  now: Date = new Date(),
): Promise<ProjectRunLineageResponse> {
  const row = await resolveProjectRunRow(projectRoot, runId, guildName);
  const runReal = containedRunDir(projectRoot, row.path);
  const requested = { run_id: runId, guild: guildName ?? null };
  const base = { requested, source_guild: row.source_guild };
  const rd = makeReader(runReal, "");
  const refused: RefusedRecord[] = [];

  const manifestRaw = await rd.read("lineage/logical-run.json");
  const v1Files = (await Promise.all(["run-binding.json", "session-binding.json"].map((f) => rd.read(f, 64 * 1024)))).some((r) => r !== "absent");
  if (manifestRaw === "absent") {
    return v1Files || (await rd.read("run.yaml", 64 * 1024)) !== "absent"
      ? { ...base, status: "legacy", reason: "v1 run: no logical-run v2 manifest; lineage is not reconstructed" }
      : { ...base, status: "unavailable", reason: "no logical-run manifest recorded for this run" };
  }
  if (v1Files) return { ...base, status: "refused", reason: "run holds both v1 binding files and a v2 logical-run manifest" };
  if (manifestRaw === "unreadable" || !isLogicalRun(manifestRaw.json) || !semanticOk("logical-run", manifestRaw.json as Obj)) {
    return { ...base, status: "refused", reason: "logical-run manifest is not a valid guild.logical_run.v2 record" };
  }
  const m = manifestRaw.json as Obj & { source_id: string; run_id: string; controller: Obj; state: StateAxes };
  if (m.run_id !== runId) return { ...base, status: "refused", reason: "logical-run manifest names a different run" };
  const sourceId = m.source_id;
  const revisions = new Map<string, string>();
  const runRevision = sha256Text(manifestRaw.text);
  revisions.set(entityKey({ source_id: sourceId, kind: "run", id: runId }), runRevision);

  /** Read every `<dir>/*.json`; returns (file-stem, record, revision) for records passing `valid` and `owned`. */
  async function readDir<T>(dir: string, valid: Spec, owned: (r: T, stem: string) => RefusedRecord["reason"] | null) {
    const names = await rd.list(dir, false);
    if (names === "too_many") {
      refused.push({ file: dir, reason: "too_many_records" });
      return [];
    }
    const out: { stem: string; rec: T; revision: string }[] = [];
    for (const n of names) {
      const file = `${dir}/${n}`;
      const got = await rd.read(file);
      if (got === "absent" || got === "unreadable") {
        refused.push({ file, reason: "unreadable" });
        continue;
      }
      if (!valid(got.json)) {
        refused.push({ file, reason: "invalid_record" });
        continue;
      }
      const stem = n.slice(0, -".json".length);
      const why = owned(got.json as T, stem);
      if (why) {
        refused.push({ file, reason: why });
        continue;
      }
      out.push({ stem, rec: got.json as T, revision: sha256Text(got.text) });
    }
    return out;
  }

  type Lin = { source_id: string; run_id: string; execution_id: string; attempt_id: string | null };
  const ownLineage = (l: Lin, stem: string, key: "execution_id" | "attempt_id") =>
    l.source_id !== sourceId ? "foreign_source" : l.run_id !== runId || l[key] !== stem ? "misplaced" : null;

  const segs = await readDir<Obj & { lineage: Lin }>("lineage/executions", isExecutionSegment, (r, s) => ownLineage(r.lineage, s, "execution_id"));
  const seals = await readDir<Obj>("lineage/seals", isSeal, (r, s) =>
    r.source_id !== sourceId ? "foreign_source" : r.run_id !== runId || r.execution_id !== s ? "misplaced" : null);
  const sealBy = new Map(seals.map((x) => [x.stem, x.rec]));
  const executions: LineageExecution[] = segs.map(({ rec, revision }) => {
    revisions.set(entityKey({ source_id: sourceId, kind: "execution", id: rec.lineage.execution_id }), revision);
    const seal = sealBy.get(rec.lineage.execution_id);
    const iv = rec.interval as Obj & { clock: { basis: LineageExecution["interval"]["clock_basis"] } };
    return {
      source_id: rec.lineage.source_id,
      execution_id: rec.lineage.execution_id,
      revision,
      original_host_id: rec.original_host_id as string,
      host_session_id: rec.host_session_id as string | null,
      issued_controller_epoch: rec.issued_controller_epoch as number,
      admission: rec.admission as LineageExecution["admission"],
      interval: { start: iv.start as string, end: iv.end as string | null, duration_ms: iv.duration_ms as number | null, clock_basis: iv.clock.basis },
      pins: rec.pins as LineageExecution["pins"],
      seal: seal
        ? {
            outcome_state: seal.outcome_state as "exited" | "cancelled" | "timed_out",
            sealed_at: seal.sealed_at as string,
            operation_id: (seal.sealed_by as Obj).operation_id as string,
            matches_segment: seal.segment_revision === revision,
          }
        : null,
    };
  });
  const execIds = new Set(executions.map((e) => e.execution_id));
  for (const s of seals) if (!execIds.has(s.stem)) refused.push({ file: `lineage/seals/${s.stem}.json`, reason: "misplaced" });

  const atts = await readDir<Obj & { lineage: Lin & Obj }>("lineage/attempts", (v) => isTaskAttempt(v) && semanticOk("task-attempt", v as Obj), (r, s) => ownLineage(r.lineage, s, "attempt_id"));
  const attempts: LineageAttempt[] = atts.map(({ rec, revision }) => {
    revisions.set(entityKey({ source_id: sourceId, kind: "task_attempt", id: rec.lineage.attempt_id as string }), revision);
    return {
      source_id: rec.lineage.source_id,
      attempt_id: rec.lineage.attempt_id as string,
      execution_id: rec.lineage.execution_id,
      logical_task_id: rec.lineage.logical_task_id as string | null,
      goal_id: rec.lineage.goal_id as string | null,
      agent_instance_id: rec.lineage.agent_instance_id as string | null,
      ordinal: rec.ordinal as number,
      state: rec.state as StateAxes,
      assignment: summary(rec.assignment_ref as Obj),
      results: (rec.result_refs as Obj[]).map(summary),
      acceptance_subject_hash: rec.acceptance_subject_hash as string | null,
      accepted_by_controller_epoch: rec.accepted_by_controller_epoch as number | null,
      receipt_loss_reconciled: rec.receipt_loss_reconciled as boolean,
      uncertain_effects: rec.uncertain_effects as boolean,
    };
  });
  attempts.sort((a, b) => (a.logical_task_id ?? "").localeCompare(b.logical_task_id ?? "") || a.ordinal - b.ordinal);

  // R04 transfer journal: runs/<run>/transfers/<op>/NN-<stage>.json, latest stage wins.
  const transfers: LineageTransfer[] = [];
  const ops = await rd.list("transfers", true);
  if (ops === "too_many") refused.push({ file: "transfers", reason: "too_many_records" });
  else {
    for (const op of ops) {
      const stages = await readDir<Obj>(`transfers/${op}`, (v) => isObj(v) && v.schema_version === "guild.followup_transfer.v1" ? isFollowupTransfer(v) : true, () => null);
      const recs = stages.filter((s) => isObj(s.rec) && s.rec.schema_version === "guild.followup_transfer.v1");
      if (recs.length === 0) continue;
      const bad = recs.find((s) => s.rec.operation_id !== op || (s.rec.source_work as EntityRef).source_id !== sourceId);
      if (bad) {
        refused.push({ file: `transfers/${op}/${bad.stem}.json`, reason: (bad.rec.source_work as EntityRef).source_id !== sourceId ? "foreign_source" : "misplaced" });
        continue;
      }
      const order = (s: TransferState) => TRANSFER_STATES.indexOf(s);
      recs.sort((a, b) => order(a.rec.state as TransferState) - order(b.rec.state as TransferState));
      const last = recs[recs.length - 1];
      const r = last.rec;
      revisions.set(entityKey({ source_id: sourceId, kind: "transfer", id: op }), last.revision);
      const ev = (e: unknown) => (e === null ? null : summary(e as Obj));
      transfers.push({
        operation_id: op,
        state: r.state as TransferState,
        stages: recs.map((s) => s.rec.state as TransferState),
        source_work: r.source_work as EntityRef,
        destination_work: r.destination_work as EntityRef,
        recorded_at: r.recorded_at as string,
        source_commit: ev(r.source_commit),
        target_activation: ev(r.target_activation),
        target_ack: ev(r.target_ack),
      });
    }
  }

  // Operations (C4 preview / C5 approval / C6 receipt) live project-wide at
  // `.guild/artifacts/operations/<op>/{preview,approval,receipt}.json`. Only v2
  // records that name this run, one of its executions, attempts or transfers are
  // attributed here; anything else under that tree belongs to another subject.
  const operations: LineageOperation[] = [];
  const guildReal = guildDirOf(runReal);
  if (guildReal) {
    const gd = makeReader(guildReal, ".guild/");
    const opDirs = await gd.list("artifacts/operations", true);
    if (opDirs === "too_many") refused.push({ file: ".guild/artifacts/operations", reason: "too_many_records" });
    else {
      const current: CurrentAuthority = {
        source_id: sourceId,
        controller_source_id: m.controller.source_id as string,
        controller_epoch: m.controller.epoch as number,
        revisions,
        now,
      };
      const mine = new Set<string>([
        entityKey({ source_id: sourceId, kind: "run", id: runId }),
        ...executions.map((e) => entityKey({ source_id: sourceId, kind: "execution", id: e.execution_id })),
        ...attempts.map((a) => entityKey({ source_id: sourceId, kind: "task_attempt", id: a.attempt_id })),
        ...transfers.map((t) => entityKey({ source_id: sourceId, kind: "transfer", id: t.operation_id })),
      ]);
      const names = (r: Obj | null): EntityRef[] =>
        r === null
          ? []
          : r.schema_version === "guild.stack.operation-preview.v2"
            ? [...(r.targets as EntityRef[]), ...(r.dependencies as EntityRef[]), ...(r.effects as { target: EntityRef }[]).map((e) => e.target)]
            : (r.touched as EntityRef[]);
      for (const op of opDirs) {
        const raw: Record<string, { file: string; got: Awaited<ReturnType<Reader["read"]>> }> = {};
        for (const name of ["preview", "approval", "receipt"]) {
          const file = `artifacts/operations/${op}/${name}.json`;
          raw[name] = { file, got: await gd.read(file) };
        }
        const v2 = (name: string, schema: string) => {
          const g = raw[name].got;
          return typeof g === "object" && isObj(g.json) && g.json.schema_version === schema ? (g.json as Obj) : null;
        };
        // Attribution only trusts records that pass the strict shape check.
        const pv = v2("preview", "guild.stack.operation-preview.v2");
        const rv = v2("receipt", "guild.stack.operation-receipt.v2");
        const previewShape = pv && isOperationPreview(pv) ? pv : null;
        const receiptShape = rv && isOperationReceipt(rv) ? rv : null;
        const related = [...names(previewShape), ...names(receiptShape)].some((e) => mine.has(entityKey(e)));
        const looselyRelated = [pv, rv].some((r) => r !== null && JSON.stringify(r).includes(JSON.stringify(runId)));
        if (!related && !looselyRelated) continue;
        let bad = false;
        const part = (name: string, schema: string, valid: Spec): Obj | null => {
          const { file, got } = raw[name];
          if (got === "absent") return null;
          if (got === "unreadable" || !isObj(got.json) || got.json.schema_version !== schema || !valid(got.json)) {
            refused.push({ file: `.guild/${file}`, reason: got === "unreadable" ? "unreadable" : "invalid_record" });
            bad = true;
            return null;
          }
          const rec = got.json as Obj;
          if (rec.operation_id !== op) {
            refused.push({ file: `.guild/${file}`, reason: "misplaced" });
            bad = true;
            return null;
          }
          if (name !== "approval" && rec.source_id !== sourceId) {
            refused.push({ file: `.guild/${file}`, reason: "foreign_source" });
            bad = true;
            return null;
          }
          return rec;
        };
        const preview = part("preview", "guild.stack.operation-preview.v2", (v) => isOperationPreview(v) && semanticOk("operation-preview", v as Obj));
        const approval = part("approval", "guild.stack.approval-record.v2", (v) => isApprovalRecord(v) && semanticOk("approval-record", v as Obj));
        const receipt = part("receipt", "guild.stack.operation-receipt.v2", (v) => isOperationReceipt(v) && semanticOk("operation-receipt", v as Obj));
        if (bad || (!preview && !receipt)) continue;
        const auth: AuthorityCheck = preview
          ? checkOperationAuthority(preview, approval, current)
          : { status: "stale", codes: ["preview_missing"] };
        const pa = preview?.authority as { controller_epoch: number } | undefined;
        operations.push({
          operation_id: op,
          operation: (preview?.operation as string) ?? null,
          session_id: (preview?.session_id as string) ?? null,
          preview_hash: (preview?.preview_hash as string) ?? null,
          expires_at: (preview?.expires_at as string) ?? null,
          controller_epoch: pa ? pa.controller_epoch : null,
          targets: (preview?.targets as EntityRef[]) ?? [],
          dependencies: (preview?.dependencies as EntityRef[]) ?? [],
          effects: ((preview?.effects as Obj[]) ?? []).map((e) => ({ target: e.target as EntityRef, action: e.action as string })),
          approval: approval
            ? { decision: approval.decision as "approved" | "rejected" | "revise", at: approval.at as string, actor_label: approval.actor_label as string }
            : null,
          receipt: receipt
            ? {
                state: receipt.state as NonNullable<LineageOperation["receipt"]>["state"],
                effect_kind: receipt.effect_kind as NonNullable<LineageOperation["receipt"]>["effect_kind"],
                outcome: receipt.outcome as StateAxes | null,
                recorded_at: receipt.recorded_at as string,
                correlation:
                  preview === null ? "absent" : receipt.preview_hash === preview.preview_hash && receipt.source_id === preview.source_id ? "correlated" : "uncorrelated",
              }
            : null,
          authority: auth,
        });
      }
    }
    rd.inputs.push(...gd.inputs);
  }

  const usage = await readUsage(runReal, runId, sourceId, rd.inputs, refused);
  const inputs = [...rd.inputs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const promptRef = m.initial_prompt_ref as Obj | null;
  const run: LineageRun = {
    source_id: sourceId,
    run_id: runId,
    revision: runRevision,
    initiative_id: m.initiative_id as string | null,
    parent_run: m.parent_run as EntityRef | null,
    created_at: m.created_at as string,
    phase: m.phase as string,
    initial_command: m.initial_command as string,
    initial_prompt: promptRef ? summary(promptRef) : null,
    controller: {
      source_id: m.controller.source_id as string,
      host_id: m.controller.host_id as string,
      epoch: m.controller.epoch as number,
      state: m.controller.state as "active" | "suspended",
    },
    workflow_hash: m.workflow_hash as string,
    settings_hash: m.settings_hash as string,
    state: m.state,
  };
  return {
    ...base,
    status: "available",
    input_revision: sha256Text(inputs.map(([p, h]) => `${p}\u0000${h}`).join("\n")),
    run,
    executions,
    attempts,
    transfers,
    operations,
    usage,
    close_blockers: deriveCloseBlockers(attempts, transfers),
    refused,
  };
}

/** The `.guild` directory holding `<guild>/runs/<run>`, or null when the run sits elsewhere. */
function guildDirOf(runReal: string): string | null {
  const runsDir = dirname(runReal);
  return basename(runsDir) === "runs" ? dirname(runsDir) : null;
}

/** T03 run analysis v2: `.guild/analysis/runs/<run>/current.v2.json` → versioned body. Absent stays missing, never zero. */
async function readUsage(runReal: string, runId: string, sourceId: string, inputs: [string, string][], refused: RefusedRecord[]): Promise<UsageView> {
  const guildReal = guildDirOf(runReal);
  if (!guildReal) return { status: "missing", reason: "run directory is not under a .guild/runs tree" };
  const rd = makeReader(guildReal, ".guild/");
  const ptrRel = `analysis/runs/${runId}/current.v2.json`;
  const ptr = await rd.read(ptrRel, 64 * 1024);
  inputs.push(...rd.inputs.splice(0));
  if (ptr === "absent") return { status: "missing", reason: "no run analysis v2 recorded for this run" };
  if (ptr === "unreadable" || !isAnalysisPointer(ptr.json)) {
    refused.push({ file: `.guild/${ptrRel}`, reason: ptr === "unreadable" ? "unreadable" : "invalid_record" });
    return { status: "refused", reason: "run analysis pointer is not valid" };
  }
  const p = ptr.json as Obj;
  if (p.run_id !== runId || p.source_id !== sourceId) {
    refused.push({ file: `.guild/${ptrRel}`, reason: p.source_id !== sourceId ? "foreign_source" : "misplaced" });
    return { status: "refused", reason: "run analysis pointer names a different run or source" };
  }
  const bodyRel = `analysis/runs/${runId}/versions/${p.analysis_id as string}/analysis.json`;
  const body = await rd.read(bodyRel, ANALYSIS_MAX_BYTES);
  inputs.push(...rd.inputs.splice(0));
  if (body === "absent") return { status: "missing", reason: "run analysis body named by the pointer is absent" };
  if (body === "unreadable" || !isRunAnalysis(body.json) || sha256Text(body.text) !== p.analysis_sha256) {
    refused.push({ file: `.guild/${bodyRel}`, reason: body === "unreadable" ? "unreadable" : "invalid_record" });
    return { status: "refused", reason: "run analysis body does not match its pointer or schema" };
  }
  const a = body.json as Obj & { run: EntityRef; usage: Obj[]; losses: { code: string; count: number | null; reason: string }[] };
  if (a.run.id !== runId || a.run.source_id !== sourceId || a.analysis_id !== p.analysis_id) {
    refused.push({ file: `.guild/${bodyRel}`, reason: "misplaced" });
    return { status: "refused", reason: "run analysis names a different run" };
  }
  if (a.usage.length === 0) return { status: "missing", reason: "run analysis recorded no usage observations" };
  const entries = a.usage.map((u) => ({
    accounting_identity: u.accounting_identity as string,
    granularity: u.granularity as "leaf_request" | "native_session",
    inclusion: u.inclusion as "leaf_exclusive" | "parent_inclusive" | "session_cumulative",
    input_inclusive: u.input_inclusive as number | null,
    output: u.output as number | null,
    total: u.total as number | null,
    cost_usd: u.cost_usd as number | null,
    cost_basis: u.cost_basis as "measured" | "derived_estimate" | "native_estimate" | "unavailable",
    final: u.final as boolean,
  }));
  const partial = a.losses.length > 0 || entries.some((e) => e.total === null || e.cost_usd === null || e.cost_basis === "unavailable" || !e.final);
  return {
    status: partial ? "partial" : "available",
    analysis_id: a.analysis_id as string,
    analysis_sha256: p.analysis_sha256 as string,
    entries,
    losses: a.losses,
  };
}
