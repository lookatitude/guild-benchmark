// C8 WorkflowProjection v2 (contracts/guild-stack/v2/schemas/workflow-projection.schema.json).
// Pure types: shared by the server read adapter and the UI inspector.

export type WorkflowClass = "product" | "research" | "debug" | "ops" | "init";
export type NodeEffect = "read" | "write" | "review" | "gate" | "privileged_operation" | "release";
export type GateRole = "d5" | "qa" | "ops" | "d8";
export type ObligationKind = "security" | "adversarial_security" | "ui" | "ux" | "quality" | "project_specific";
export type ObligationStatus = "pending" | "accepted" | "rejected" | "invalidated";
export type InvocationState = "active" | "blocked" | "accepted" | "cancelled";
export type EvidenceAvailability = "available" | "expired" | "redacted" | "missing" | "unsupported";

export interface TypedPort {
  name: string;
  type: string;
}

export interface WorkflowNode {
  id: string;
  component_id: string;
  component_hash: string;
  effect: NodeEffect;
  gate_role: GateRole | null;
  within_gate: GateRole | null;
  role: string;
  capabilities: string[];
  inputs: TypedPort[];
  outputs: TypedPort[];
  required: boolean;
}

export interface WorkflowEvidence {
  source_id: string;
  path: string;
  sha256: string;
  schema_version: string;
  observed_at: string;
  availability: EvidenceAvailability;
  reason: string | null;
}

export interface WorkflowObligation {
  id: string;
  kind: ObligationKind;
  node_id: string;
  subject_hash: string;
  invocation_id: string;
  round: number;
  status: ObligationStatus;
  authority: string;
  evidence: WorkflowEvidence[];
}

export interface WorkflowInvocation {
  id: string;
  node_id: string;
  round: number;
  max_rounds: number;
  unresolved_questions: string[];
  state: InvocationState;
  definition_hash: string;
  subject_hash: string;
}

export interface WorkflowProjectionV2 {
  schema_version: "guild.stack.workflow-projection.v2";
  workflow: { source_id: string; kind: string; id: string; revision: string };
  class: WorkflowClass;
  definition_hash: string;
  compiler_hash: string;
  policy_hash: string;
  expanded_hash: string;
  components: Array<{ id: string; version: string; sha256: string }>;
  nodes: WorkflowNode[];
  edges: Array<{ from: string; to: string; on: string }>;
  entry: string;
  protected_gates: string[];
  obligations: WorkflowObligation[];
  invocations: WorkflowInvocation[];
}

/** GET /api/project/runs/:run_id/workflow. Missing is `unavailable`, never an empty projection. */
export type ProjectRunWorkflowResponse =
  | { status: "available"; run_id: string; projection: WorkflowProjectionV2 }
  | { status: "unavailable"; run_id: string; reason: string }
  | { status: "refused"; run_id: string; issues: string[] };
