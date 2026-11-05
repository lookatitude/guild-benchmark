// Response shape of GET /api/project/runs/:run_id/lineage (U01 / P05).
// Shared with the UI by relative import; no runtime code here.

export type LifecycleAxis = "created" | "active" | "suspended" | "closed" | "unknown";
export type OutcomeAxis = "pending" | "succeeded" | "failed" | "cancelled" | "partial" | "unknown";
export type AcceptanceAxis = "pending" | "verified" | "rejected" | "not_required" | "unknown";
export type ObservabilityAxis = "complete" | "partial" | "unavailable";
export interface StateAxes {
  lifecycle: LifecycleAxis;
  outcome: OutcomeAxis;
  acceptance: AcceptanceAxis;
  observability: ObservabilityAxis;
}

export type Availability = "available" | "expired" | "redacted" | "missing" | "unsupported";

/** An evidence reference with its path withheld: hash, schema and availability only. */
export interface EvidenceSummary {
  sha256: string;
  schema_version: string;
  availability: Availability;
  reason: string | null;
}

export interface EntityRef {
  source_id: string;
  kind: string;
  id: string;
  revision: string;
}

export interface Pins {
  assignment: string;
  definition: string;
  configuration: string;
  workflow: string;
  policy: string;
}

export interface Interval {
  start: string;
  end: string | null;
  duration_ms: number | null;
  clock_basis: "controller" | "local_monotonic" | "provider" | "unknown";
}

export interface LineageRun {
  source_id: string;
  run_id: string;
  revision: string;
  initiative_id: string | null;
  parent_run: EntityRef | null;
  created_at: string;
  phase: string;
  initial_command: string;
  initial_prompt: EvidenceSummary | null;
  controller: { source_id: string; host_id: string; epoch: number; state: "active" | "suspended" };
  workflow_hash: string;
  settings_hash: string;
  state: StateAxes;
}

export interface SegmentSeal {
  outcome_state: "exited" | "cancelled" | "timed_out";
  sealed_at: string;
  operation_id: string;
  matches_segment: boolean;
}

export interface LineageExecution {
  source_id: string;
  execution_id: string;
  revision: string;
  original_host_id: string;
  host_session_id: string | null;
  issued_controller_epoch: number;
  admission: "active" | "reconcile_only" | "revoked" | "sealed";
  interval: Interval;
  pins: Pins;
  seal: SegmentSeal | null;
}

export interface LineageAttempt {
  source_id: string;
  attempt_id: string;
  execution_id: string;
  logical_task_id: string | null;
  goal_id: string | null;
  agent_instance_id: string | null;
  ordinal: number;
  state: StateAxes;
  assignment: EvidenceSummary;
  results: EvidenceSummary[];
  acceptance_subject_hash: string | null;
  accepted_by_controller_epoch: number | null;
  receipt_loss_reconciled: boolean;
  uncertain_effects: boolean;
}

export type TransferState =
  | "reserved"
  | "target_prepared"
  | "source_committed"
  | "target_activated"
  | "acknowledged"
  | "recovery_needed"
  | "aborted";

export interface LineageTransfer {
  operation_id: string;
  state: TransferState;
  stages: TransferState[];
  source_work: EntityRef;
  destination_work: EntityRef;
  recorded_at: string;
  source_commit: EvidenceSummary | null;
  target_activation: EvidenceSummary | null;
  target_ack: EvidenceSummary | null;
}

export type AuthorityCheckCode =
  | "preview_hash_mismatch"
  | "preview_expired"
  | "source_mismatch"
  | "controller_epoch_mismatch"
  | "target_revision_stale"
  | "dependency_revision_stale"
  | "preview_missing"
  | "approval_missing"
  | "approval_not_approved"
  | "approval_operation_mismatch"
  | "approval_preview_mismatch"
  | "approval_source_mismatch"
  | "approval_session_mismatch"
  | "approval_authority_mismatch";

export interface AuthorityCheck {
  /**
   * `pins_current`: every pinned revision, the controller epoch and the approval binding still match.
   * Policy and grant admission are the controller's; this view never reports an operation as authorized.
   */
  status: "pins_current" | "stale";
  codes: AuthorityCheckCode[];
  /** Pins this view has no current record to compare against; they are neither current nor stale here. */
  unverified: ("scope_revision" | "capability_revision" | "policy_revision" | "writer_scope")[];
}

export type ReceiptCorrelation = "correlated" | "uncorrelated" | "absent";

export interface LineageOperation {
  operation_id: string;
  operation: string | null;
  session_id: string | null;
  preview_hash: string | null;
  expires_at: string | null;
  controller_epoch: number | null;
  targets: EntityRef[];
  dependencies: EntityRef[];
  effects: { target: EntityRef; action: string }[];
  approval: { decision: "approved" | "rejected" | "revise"; at: string; actor_label: string } | null;
  receipt: {
    state: "accepted" | "running" | "applied" | "failed" | "recovery_needed";
    effect_kind: "dispatch" | "segment_seal" | "logical_outcome" | "transfer_ack" | "domain_write";
    outcome: StateAxes | null;
    recorded_at: string;
    correlation: ReceiptCorrelation;
  } | null;
  authority: AuthorityCheck;
}

export interface UsageEntry {
  accounting_identity: string;
  granularity: "leaf_request" | "native_session";
  inclusion: "leaf_exclusive" | "parent_inclusive" | "session_cumulative";
  input_inclusive: number | null;
  output: number | null;
  total: number | null;
  cost_usd: number | null;
  cost_basis: "measured" | "derived_estimate" | "native_estimate" | "unavailable";
  final: boolean;
  coverage: { state: "complete" | "partial" | "unavailable"; reason: string | null };
}

export type UsageView =
  | { status: "missing"; reason: string }
  | { status: "refused"; reason: string }
  | {
      status: "available" | "partial";
      analysis_id: string;
      analysis_sha256: string;
      entries: UsageEntry[];
      losses: { code: string; count: number | null; reason: string }[];
    };

export interface CloseBlocker {
  code:
    | "attempt_live"
    | "attempt_orphaned"
    | "receipt_loss_unreconciled"
    | "uncertain_effects"
    | "no_accepted_final_evidence"
    | "transfer_unacknowledged"
    | "record_refused";
  subject: string;
}

export interface RefusedRecord {
  /** Run-relative (or `.guild`-relative for analysis) path of the refused file. */
  file: string;
  reason: "invalid_record" | "unreadable" | "foreign_source" | "misplaced" | "too_many_records";
}

export type ProjectRunLineageResponse =
  | {
      status: "available";
      requested: { run_id: string; guild: string | null };
      source_guild: string;
      /** sha256 over every input file's bytes; the UI keys its cache on (source_guild, run_id, input_revision). */
      input_revision: string;
      run: LineageRun;
      executions: LineageExecution[];
      attempts: LineageAttempt[];
      transfers: LineageTransfer[];
      operations: LineageOperation[];
      usage: UsageView;
      close_blockers: CloseBlocker[];
      refused: RefusedRecord[];
    }
  | {
      status: "legacy" | "unavailable" | "refused";
      requested: { run_id: string; guild: string | null };
      source_guild: string;
      reason: string;
    };
