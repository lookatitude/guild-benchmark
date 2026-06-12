// Shared type contracts for benchmark/. Locked by ADR-001 + plans/01-architecture.md §3.
// qa (T3) consumes this file as the type-level test target — every interface here
// is referenced by at least one P1 component.

export const SCHEMA_VERSION = 1;

export type RunStatus = "pass" | "fail" | "timeout" | "errored";

export type StageName =
  | "brainstorm"
  | "team"
  | "plan"
  | "context"
  | "execute"
  | "review"
  | "verify"
  | "reflect";

// Canonical gate set scored by `gates`. Locked by §6.4 + spec acceptance criteria.
export const EXPECTED_GATES: StageName[] = [
  "brainstorm",
  "team",
  "plan",
  "context",
  "execute",
  "review",
  "verify",
  "reflect",
];

export interface ScoringWeights {
  outcome: number;
  delegation: number;
  gates: number;
  evidence: number;
  loop_response: number;
  efficiency: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  outcome: 30,
  delegation: 20,
  gates: 20,
  evidence: 15,
  loop_response: 10,
  efficiency: 5,
};

export interface Case {
  schema_version: number;
  id: string;
  title: string;
  timeout_seconds: number;
  repetitions: number;
  fixture: string;
  prompt: string;
  expected_specialists: string[];
  expected_stage_order: string[];
  acceptance_commands: string[];
  scoring_weights?: Partial<ScoringWeights>;
  wall_clock_budget_ms?: number;
}

export interface RunJson {
  schema_version: number;
  run_id: string;
  case_slug: string;
  plugin_ref: string;
  model_ref: Record<string, string>;
  started_at: string;
  completed_at: string;
  status: RunStatus;
  raw_command?: string;
  wall_clock_ms?: number;
  wall_clock_budget_ms?: number;
  // P4 — operator-supplied SHA-256 hex hash of an opaque identity token,
  // sourced from GUILD_BENCHMARK_AUTH_HINT env var. Validated by runner
  // against ^[a-f0-9]{64}$ (M9); on mismatch, field is omitted and a
  // tool_error event is emitted (M10). Never derived from `claude` CLI
  // auth state (M11). Forensic-only; not surfaced in UI.
  auth_identity_hash?: string;
}

export type EventLine =
  | { ts: string; type: "stage_started"; stage: string }
  | { ts: string; type: "stage_completed"; stage: string; duration_ms: number }
  | { ts: string; type: "specialist_dispatched"; specialist: string; task_id: string }
  | {
      ts: string;
      type: "specialist_completed";
      specialist: string;
      task_id: string;
      status: "complete" | "blocked" | "errored";
    }
  | { ts: string; type: "gate_passed"; gate: string }
  | { ts: string; type: "gate_skipped"; gate: string; reason?: string }
  | { ts: string; type: "tool_error"; tool: string; exit_code: number }
  | { ts: string; type: "acceptance_command"; command: string; exit_code: number }
  | { ts: string; type: "retry"; what: string };

export type LoopLayer = "L1" | "L2" | "L3" | "L4" | "security-review";

export interface LoopRoundMetrics {
  started: number;
  ended: number;
  max_round_number: number;
  cap?: number;
  last_terminated?: "satisfied" | "malformed_termination" | "cap_hit" | "escalation" | "error";
  last_terminator?: string;
}

export type LoopRoundsPerLane = Record<string, Partial<Record<LoopLayer, LoopRoundMetrics>>>;

export interface Stage {
  name: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  status: "passed" | "skipped" | "missing";
  reason?: string;
}

export interface ReceiptSummary {
  task_id: string;
  specialist: string;
  status: string;
  evidence_present: boolean;
  evidence_chars: number;
}

export interface RunRecord {
  run: RunJson;
  events: EventLine[];
  v14_events?: import("./log-jsonl.js").JsonlEvent[];
  runDir: string;
  artifactsRoot: string;
  receipts: ReceiptSummary[];
  hasReview: boolean;
  hasAssumptions: boolean;
  hasReflection: boolean;
  partial: boolean;
  missing_artifacts: string[];
}

export interface ComponentScore {
  weight: number;
  raw_subscore: number;
  max_subscore: number;
  weighted: number;
  reason?: string;
  notes?: string[];
}

export interface ScoreComponents {
  outcome: ComponentScore;
  delegation: ComponentScore;
  gates: ComponentScore;
  evidence: ComponentScore;
  loop_response: ComponentScore;
  efficiency: ComponentScore;
}

export type ComponentKey = keyof ScoreComponents;

export const COMPONENT_KEYS: ComponentKey[] = [
  "outcome",
  "delegation",
  "gates",
  "evidence",
  "loop_response",
  "efficiency",
];

// v1.1 — distinguishes runs that exercise the Guild lifecycle (events.ndjson
// present) from runs that just record raw `claude --print` model behavior
// (no events; outcome/delegation/gates components score 0). See
// .guild/wiki/decisions/benchmark-runs-raw-claude-not-guild-lifecycle.md.
export type RunKind = "guild_lifecycle" | "raw_model";

export interface Score {
  schema_version: number;
  run_id: string;
  case_slug: string;
  plugin_ref: string;
  model_ref: Record<string, string>;
  status: RunStatus;
  scored_at: string;
  partial: boolean;
  missing_artifacts: string[];
  // v1.1 — explicit annotation of what kind of run was scored. When
  // `events.ndjson` is missing, partial scoring is *expected and correct*;
  // `run_kind: "raw_model"` makes that interpretable rather than mysterious.
  run_kind: RunKind;
  components: ScoreComponents;
  guild_score: number;
  // v1.4 — F-7: derived field flagging the Anthropic model family
  // (haiku/sonnet/opus) for cross-tier benchmark aggregation. Computed
  // by the scorer from `model_ref.default` (case-insensitive substring
  // match). Absent when the model_ref carries no recognised tier.
  // Pinned by `scorer.test.ts > model_family derivation`.
  model_family?: string;
}

export interface MetricsJson {
  schema_version: number;
  run_id: string;
  computed_at: string;
  wall_clock_ms?: number;
  wall_clock_budget_ms?: number;
  stages: Stage[];
  dispatched_specialists: string[];
  expected_specialists: string[];
  acceptance_commands: { command: string; passed: boolean }[];
  expected_stage_order: string[];
  observed_stage_order: string[];
  gate_outcomes: Record<string, "passed" | "skipped">;
  loop_rounds_per_lane: LoopRoundsPerLane;
  retry_count: number;
  tool_error_count: number;
}

export interface TrialSetRunSummary {
  run_id: string;
  status: RunStatus;
  guild_score: number;
  plugin_ref: string;
  model_ref: Record<string, string>;
}

export interface TrialSetSummary {
  set_id: string;
  run_count: number;
  pass_count: number;
  fail_count: number;
  timeout_count: number;
  errored_count: number;
  mean_guild_score: number;
  canonical_model_ref: Record<string, string>;
  canonical_plugin_ref: string;
  runs: TrialSetRunSummary[];
}

export interface ComponentDelta {
  baseline: number;
  candidate: number;
  delta: number;
}

export interface ExcludedRun {
  run_id: string;
  side: "baseline" | "candidate";
  reason: string;
}

// v1.1 — runs the comparator scanned but couldn't include because the
// run directory existed but had no `score.json`. Previously the comparator
// only stderr-logged these; v1.1 surfaces them in the comparison artifact
// so callers can tell silence ("no skipped runs") from an empty
// `no_comparable_runs` ("we skipped them all silently").
export interface SkippedRun {
  run_id: string;
  side: "baseline" | "candidate";
  reason: "no_score_json";
}

export interface Comparison {
  schema_version: number;
  baseline: TrialSetSummary;
  candidate: TrialSetSummary;
  status: "ok" | "no_comparable_runs" | "partial";
  excluded_runs: ExcludedRun[];
  // v1.1 — populated when run dirs exist but score.json is missing. When
  // this list is non-empty, callers should treat the comparison as
  // potentially under-counted; the CLI prints a warning when this list is
  // populated.
  skipped_runs: SkippedRun[];
  // v1.2 — F9: when baseline + candidate run_kinds disagree (one set is
  // raw_model, the other guild_lifecycle), the lifecycle-dependent
  // components (outcome/delegation/gates) don't normalize and the delta
  // table is misleading. Comparator emits this counter so callers can
  // surface a clear warning. Counts are by side, raw_model vs lifecycle.
  // 0/0/0/0 means no mismatch; any non-zero value pair across sides
  // signals a cross-kind comparison.
  kind_mix: {
    baseline_raw_model: number;
    baseline_guild_lifecycle: number;
    candidate_raw_model: number;
    candidate_guild_lifecycle: number;
  };
  per_component_delta: Record<ComponentKey, ComponentDelta>;
  guild_score_delta: ComponentDelta;
  generated_at: string;
  // P4 — populated only when compareSets was called with a LoopManifest
  // whose baseline_run_id and candidate_run_id are present in the run
  // sets. Absent for non-loop comparisons (backward-compat with P1/P3).
  reflection_applied?: ReflectionApplied;
}

// ---- P4 learning-loop contracts ----------------------------------------
//
// Locked by `benchmark/plans/p4-learning-loop-architecture.md §3.4 + §4.2`
// and `adr-005-learning-loop-orchestrator.md §Decision`. Backend (T2)
// implements; frontend (T3) renders `reflection_applied` on ComparePage;
// qa (T4) pins the manifest validation tests.

// v1.3 — F2: structured rollback flips a "completed" manifest to
// "rolled-back" after `git revert <plugin_ref_after>` succeeds. The
// state is terminal (no further transitions allowed) and is the audit
// trail for an operator who decided post-comparison that a kept proposal
// should not have been kept. ADR-007 supersession callout in
// `p4-learning-loop-architecture.md §6.1` references this name.
export type LoopManifestState =
  | "awaiting-apply"
  | "completed"
  | "aborted"
  | "rolled-back";

export interface LoopManifestProposal {
  proposal_id: string;     // basename of the reflection .md file (no extension)
  source_path: string;     // advisory: target path declared in proposal frontmatter
  summary: string;         // first non-empty line of body, trimmed to <= 160 chars
}

export interface LoopManifestApplied {
  proposal_id: string;     // mirrors --apply argument
  source_path: string;     // mirrors chosen proposal.source_path
  applied_at: string;      // ISO-8601 — when `loop --continue` ran
  plugin_ref_after: string; // host repo HEAD captured post-apply
  candidate_run_id: string; // run-id the loop produced
}

export interface LoopManifest {
  schema_version: 1;
  baseline_run_id: string;
  case_slug: string;
  plugin_ref_before: string;
  available_proposals: LoopManifestProposal[];
  started_at: string;
  state: LoopManifestState;
  applied_proposal?: LoopManifestApplied;
  abort_reason?: string;
}

export interface ReflectionApplied {
  proposal_id: string;
  source_path: string;
  applied_at: string;
  plugin_ref_before: string;
  plugin_ref_after: string;
  kept: boolean;
  delta_summary: {
    guild_score_delta: number;
    worst_component_delta: number;
    worst_component: string;
  };
}

// Loop CLI option shapes — consumed by loop.ts. Mirrors the argv layout
// from `p4-learning-loop-architecture.md §3.1` and ADR-005 §Decision.
export interface LoopStartOptions {
  caseSlug: string;
  baselineRunId?: string;
  dryRun?: boolean;
}

export interface LoopContinueOptions {
  baselineRunId: string;
  proposalId: string;
  dryRun?: boolean;
}

export interface LoopStatusOptions {
  baselineRunId: string;
  /**
   * P4-polish (2026-04-27) — when set, `loop --status` switches to diff
   * mode for the named proposal. The status report carries a `diff`
   * field containing the proposal's fenced diff/patch blocks, OR a
   * freeform notice when no tagged blocks are present.
   */
  diffProposalId?: string;
}

// v1.2 — F1: structured abort action. Flips manifest state to "aborted"
// and removes the lockfile. Refuses if state is already "completed"
// (irreversible by design). `dryRun` prints the proposed mutation
// without writing.
export interface LoopAbortOptions {
  baselineRunId: string;
  dryRun?: boolean;
}

// v1.2 — F1: shape returned by loopAbort for the dry-run reporter.
export interface LoopAbortReport {
  manifestPath: string;
  manifestStateBefore: LoopManifestState;
  manifestStateAfter: "aborted";
  lockfilePath: string;
  lockfileExisted: boolean;
}

// v1.3 — F2: structured rollback action. Refuses unless manifest state
// is "completed" (you can only rollback a completed application).
// `--dry-run` (default) prints the would-be `git revert` shellout +
// state transition without mutating; `--confirm` (live) runs
// `git revert --no-edit <plugin_ref_after>` and flips state to
// "rolled-back". The candidate-id is validated against PROPOSAL_ID_RE
// (M13 allowlist) before any disk read.
export interface LoopRollbackOptions {
  baselineRunId: string;
  candidateId: string;
  dryRun?: boolean;
  confirm?: boolean;
}

// v1.3 — F2: shape returned by loopRollback. Mirrors LoopAbortReport's
// before/after state pattern; adds the git-revert target SHA the live
// path would shell out against, and the `confirmed` flag distinguishing
// dry-run from live invocations.
export interface LoopRollbackReport {
  manifestPath: string;
  manifestStateBefore: LoopManifestState;
  manifestStateAfter: "rolled-back";
  candidateId: string;
  pluginRefAfter: string;
  hostRepoRoot: string;
  lockfilePath: string;
  lockfileExisted: boolean;
  confirmed: boolean;
}

// HTTP response shapes — server.ts (P2) serializes these; the React UI
// imports them directly. See p2-ui-architecture.md §2.1 for which page
// component consumes which shape.

export interface RunsListRow {
  run_id: string;
  case_slug: string;
  plugin_ref: string;
  status: RunStatus;
  guild_score: number;
  started_at: string;
  // v1.3 — F4: surfaced on the LIST endpoint (in addition to detail) so
  // the frontend's filter UI can group/filter by the operator-supplied
  // auth identity. Optional: omitted on rows whose source `run.json` did
  // not record one (M9: env var absent or invalid sha256-hex shape).
  auth_identity_hash?: string;
}

export interface RunsListResponse {
  runs: RunsListRow[];
  total: number;
}

export interface RunDetailResponse {
  run: RunJson;
  metrics: MetricsJson;
  score: Score;
  events: EventLine[];
}

export interface CaseSummary {
  id: string;
  title: string;
  expected_specialists: string[];
  expected_stage_order: string[];
}

export interface CasesListResponse {
  cases: CaseSummary[];
}

export interface DeferredResponse {
  reason: string;
  docs: string;
}

// ---- SC-12 (v2-gap-closure G-17/G-18) — live-project knowledge routes ----
//
// Served by /api/project/* when `serve --project-root <abs>` is set; produced
// by src/project-reader.ts, consumed by the UI's Knowledge + Wiki views.
// Contract pinned in `.guild/spec/v2-gap-closure.md §The cross-repo dashboard
// contract`.

export interface ProjectSource {
  guild: string;
  path: string;
  kind?: "knowledge-graph" | "codebase-map" | "wiki" | "runs" | "initiatives";
}

/**
 * Lenient pass-through KG shape: nodes/edges keep every unknown field from
 * the source `.guild/indexes/knowledge-graph.json`; the reader only
 * guarantees `source_guild` is stamped on each entry. Well-known fields the
 * UI reads (`id`, `type`, `name`, `source`, `target`) are optional because
 * the reader never validates them away.
 */
export interface ProjectKnowledgeGraphResponse {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  sources: ProjectSource[];
  empty_reason?: string;
}

export interface ProjectOverviewSource {
  guild: string;
  root: string;
  has_runs: boolean;
  has_wiki: boolean;
  has_graph: boolean;
  has_initiatives?: boolean;
  graph_kind?: "knowledge-graph" | "codebase-map";
  run_count: number;
  wiki_count: number;
  initiative_count?: number;
}

export interface ProjectOverviewResponse {
  project_root: string;
  mode: "project" | "workspace";
  sources: ProjectOverviewSource[];
  totals: {
    runs: number;
    initiatives?: number;
    wiki_pages: number;
    graph_nodes: number;
    graph_edges: number;
  };
}

export interface ProjectRunListRow {
  run_id: string;
  source_guild: string;
  command?: string;
  status?: string;
  run_class?: string;
  target_kind?: string;
  started_at?: string;
  closed_at?: string;
  initiative_id?: string;
  benchmark_eligible?: boolean;
  comparison_eligible?: boolean;
  comparison_reasons?: string[];
  event_count?: number;
  has_trace: boolean;
  has_provenance: boolean;
  has_run_yaml: boolean;
  path: string;
}

export interface ProjectRunsListResponse {
  runs: ProjectRunListRow[];
  total: number;
  sources: ProjectSource[];
}

export interface ProjectRunDetailResponse {
  run: ProjectRunListRow;
  run_yaml?: unknown;
  provenance?: unknown;
  event_count: number;
  trace_preview: Record<string, unknown>[];
}

export interface ProjectInitiativeSummary {
  id: string;
  source_guild: string;
  title?: string;
  scope?: string;
  status?: string;
  execution_status?: string;
  run_ids: string[];
  eligible_run_ids: string[];
  comparison_eligible: boolean;
  comparison_reasons: string[];
  path: string;
}

export interface ProjectInitiativesResponse {
  initiatives: ProjectInitiativeSummary[];
  total: number;
  sources: ProjectSource[];
}

export type ProjectComparisonTargetKind = "run" | "initiative";

export interface ProjectComparisonTarget {
  id: string;
  kind: ProjectComparisonTargetKind;
  source_guild: string;
  label: string;
  run_ids: string[];
  run_count: number;
  comparison_eligible: boolean;
  reasons: string[];
}

export interface ProjectComparisonTargetsResponse {
  targets: ProjectComparisonTarget[];
  total: number;
  sources: ProjectSource[];
}

export interface ProjectTargetSummary {
  target: ProjectComparisonTarget;
  status_counts: Record<string, number>;
  total_events: number;
}

export interface ProjectComparisonResponse {
  baseline: ProjectTargetSummary;
  candidate: ProjectTargetSummary;
  status: "ok" | "kind_mismatch" | "no_comparable_runs";
  generated_at: string;
  notes: string[];
}

export interface ProjectAnalysisRequest {
  target_kind: ProjectComparisonTargetKind;
  target_id: string;
  source_guild?: string;
}

export interface ProjectAnalysisAction {
  label: string;
  command: string;
  intent: "learn" | "reflect" | "evolve" | "wiki";
}

export interface ProjectAnalysisResponse {
  target: ProjectComparisonTarget;
  signals: string[];
  actions: ProjectAnalysisAction[];
}

export interface WikiPageSummary {
  /** Path relative to the owning guild's `.guild/wiki/`. */
  path: string;
  /** First H1 of the page, else the filename without extension. */
  title: string;
  /** Sub-guild name in workspace mode; "project" for a plain root. */
  source_guild: string;
  /** Frontmatter labels when trivially parseable. */
  labels?: string[];
}

export interface ProjectWikiListResponse {
  pages: WikiPageSummary[];
}

export interface ProjectWikiPageResponse {
  path: string;
  source_guild: string;
  content: string;
}

// ---- P3 runner contracts (T2 backend; consumed by frontend + qa) -------
//
// `RunOptions` is the input to runner.ts's `runBenchmark` entrypoint —
// callable from the CLI (`benchmark run --case ...`) and from the
// `POST /api/runs` server handler. `RunnerResult` is the synchronous
// return value once a run has fully terminated (clean exit, timeout,
// errored). The two `RunPost*` shapes are the HTTP body shapes for
// `POST /api/runs` (server → frontend contract per architect §5.3 and
// adr-001-runner-ui-boundary §Decision).
export interface RunOptions {
  caseSlug: string;
  runId?: string;
  modelsOverride?: Record<string, string>;
  cleanup?: boolean;
  dryRun?: boolean;
}

export interface RunnerResult {
  run_id: string;
  status: RunStatus;
  exit_code: number | null;
  wall_clock_ms: number;
  stdout_log_path: string;
  stderr_log_path: string;
  artifacts_root: string;
  events_path: string;
  partial: boolean;
}

export interface RunPostRequest {
  case_slug: string;
  run_id?: string;
  models?: Record<string, string>;
}

export interface RunPostResponse {
  run_id: string;
  location: string;
  started_at: string;
}

export interface AuditLogImportRequest {
  run_dir: string;
  run_id?: string;
}

export interface AuditLogImportResponse {
  run_id: string;
  location: string;
  imported_from: string;
  source_run_id: string;
}

// ---- SC-F full-lifecycle import contracts ------------------------------
//
// Locked by `.guild/initiatives/active/learn-knowledge-convergence/artifacts/
// benchmark-import-contract.md` (SC-F). The lifecycle importer consumes ON-DISK
// `run.yaml` (guild.run.v1) + `provenance.json` (guild.provenance.v1) +
// `logs/v1.4-events.jsonl` + optional `learn/harvest-candidates.json` +
// optional `learn/skipped-files.json` + the derived
// `.guild/indexes/knowledge-links.json`. NO plugin module is imported at
// runtime (non-negotiable #9) — the on-disk artifact is the only contract.
//
// Unlike the build-only benchmark runs (run.json), lifecycle runs cover ALL
// run types (learn/ideate/plan/qa/ops/build/status/...). `run.yaml.command`
// classifies the run type; `run_class` + `benchmark_eligible` gate scoring.

// Run type derived from `run.yaml.command`. The §435 entrypoint set plus
// `unknown` for unrecognised commands.
export type RunTypeKind =
  | "learn"
  | "ideate"
  | "plan"
  | "build"
  | "qa"
  | "ops"
  | "status"
  | "wiki"
  | "initiative"
  | "fix"
  | "evolve"
  | "rollback"
  | "audit"
  | "stats"
  | "unknown";

// One entry on the entry-to-close timeline. Merged from `run.yaml.phases_log`
// (the replay backbone) and the v1.4 trace markers + lifecycle markers
// (run_started / run_closed) in `logs/v1.4-events.jsonl`.
export type TimelineKind =
  | "phase"
  | "gate"
  | "specialist_dispatch"
  | "specialist_receipt"
  | "run_started"
  | "run_closed"
  | "tool_call"
  | "escalation";

export interface TimelineEntry {
  at: string; // RFC3339 UTC; empty string when source omitted a timestamp
  kind: TimelineKind;
  label: string;
  duration_ms?: number;
  detail?: Record<string, unknown>;
}

// §488-505 metric set. Every field is optional: a metric whose source
// artifact is absent (e.g. no harvest-candidates.json on a non-learn run,
// or no knowledge-links.json index) is `undefined`, never an error.
export interface LifecycleMetrics {
  time_to_project_understanding_ms?: number;
  file_coverage_count?: number;
  skipped_file_count?: number;
  skipped_file_categories?: Record<string, number>;
  knowledge_candidates_produced?: number;
  decision_candidates_produced?: number;
  graph_node_count?: number;
  graph_edge_count?: number;
  phase_durations_ms?: Record<string, number>;
  gate_count?: number;
  human_questions_asked?: number;
  context_budget_pressure?: number;
  review_rounds?: number;
  verification_outcomes?: Record<string, "pass" | "fail" | "skip">;
  learning_checkpoint_verdicts?: string[];
  reflection_promotion_rate?: number;
  replay_completeness?: "full" | "partial" | "none";
  benchmark_fixture_eligible?: boolean;
}

// Compact summary of the E1 knowledge-links read surface for a run.
export interface KnowledgeLinksSummary {
  skills: string[];
  agents: string[];
  lessons: string[]; // reflection/evolution node ids
  constraining_decisions: string[];
  run_edge_count: number;
}

// Free-shape phase-transition entry from `run.yaml.phases_log`. Lenient:
// only `phase` is depended on; other fields pass through.
export interface LifecyclePhaseLogEntry {
  phase: string;
  proposed?: string;
  detected_from?: string;
  deliverable?: unknown;
  gate?: string;
  at?: string;
  [key: string]: unknown;
}

export interface LifecycleRunRecord {
  run_id: string;
  command: string;
  run_class: "full" | "lightweight";
  run_type: RunTypeKind;
  benchmark_eligible: boolean;
  target_kind?: string;
  started_at: string;
  closed_at: string | null;
  status: string; // run.yaml.status or provenance.status; "open" when no close
  phases_log: LifecyclePhaseLogEntry[];
  timeline: TimelineEntry[];
  metrics: LifecycleMetrics;
  knowledge_links?: KnowledgeLinksSummary;
  partial: boolean; // true when provenance.json (close record) absent
  missing_artifacts: string[];
}

export interface LifecycleImportRequest {
  run_dir: string;
  run_id?: string;
}

export interface LifecycleImportResponse {
  run_id: string;
  location: string;
  imported_from: string;
  source_run_id: string;
  run_type: RunTypeKind;
  benchmark_eligible: boolean;
}
