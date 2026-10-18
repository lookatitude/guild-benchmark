// RecommendationPanel — explicit accept/reject for guild.recommendation.v1.
//
// The destination and the exact effect show BEFORE any decision. A plugin
// accept writes an accepted local draft; a project accept adds a queued
// proposal. The UI never files a remote issue, never marks anything filed or
// implemented, and never writes files: it only asks the producer through a
// recommendation_decide job, with both expected-context guards. The browser
// eligibility check is feedback; the producer's own refusal is the authority.
// A job that did not succeed proves nothing about the record: the producer
// may have written it before it stopped, so the panel asks for a re-read and
// blocks the row until the parent passes the re-read record.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { isJobClosed, useAnalysisJob, describeJobState, shortHash, type AnalysisJobView } from "./AnalysisJobPanel";

export type RecommendationScope = "plugin" | "project";

export interface RecommendationRow {
  id: string;
  source_id: string;
  source_analysis_id: string;
  scope: RecommendationScope;
  kind: string;
  status: string;
  proposed_action: string;
  confidence: string;
  severity: string;
  evidence_refs: string[];
}

const WRAP: CSSProperties = { overflowWrap: "anywhere", wordBreak: "break-word", minWidth: 0 };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// The server and the producer still disagree on "sha256:<hex>" vs bare hex
// (E03 F3). Accept both and send the hash exactly as the artifact reports it.
const INPUT_HASH = /^(sha256:)?[a-f0-9]{64}$/;

/** Confirmed decision attempts one row allows before it asks for a reload. */
export const MAX_DECISION_ATTEMPTS = 3;

// Attempt counts and unverified blocks must survive remounts: the parent
// unmounts this panel while an analysis re-read is loading, and component
// state alone would reset the cap and reuse attempt-1 idempotency keys.
// Keyed by context|status|row-id, so a changed expected context or row
// status legitimately starts fresh. Bounded: oldest entries drop past 512.
const attemptStore = new Map<string, number>();
const unverifiedStore = new Map<string, Record<string, unknown>>();
function storeSet<V>(store: Map<string, V>, key: string, value: V) {
  if (!store.has(key) && store.size >= 512) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, value);
}
/** Test-only: forget persisted attempt/unverified state. */
export function resetDecisionStores() {
  attemptStore.clear();
  unverifiedStore.clear();
}

const isStr = (v: unknown): v is string => typeof v === "string";

export function toRecommendationRow(v: unknown): RecommendationRow | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (
    !isStr(r.id) ||
    !isStr(r.source_id) ||
    !isStr(r.source_analysis_id) ||
    (r.scope !== "plugin" && r.scope !== "project") ||
    !isStr(r.kind) ||
    !isStr(r.status) ||
    !isStr(r.proposed_action) ||
    !isStr(r.confidence) ||
    !isStr(r.severity) ||
    !Array.isArray(r.evidence_refs) ||
    !r.evidence_refs.every(isStr)
  ) {
    return null;
  }
  return {
    id: r.id,
    source_id: r.source_id,
    source_analysis_id: r.source_analysis_id,
    scope: r.scope,
    kind: r.kind,
    status: r.status,
    proposed_action: r.proposed_action,
    confidence: r.confidence,
    severity: r.severity,
    evidence_refs: r.evidence_refs,
  };
}

/** Where an accept goes, stated before the decision. */
export function destinationText(scope: RecommendationScope): string {
  return scope === "plugin"
    ? "Destination: plugin local draft. Accept writes an accepted local draft in the plugin recommendation store."
    : "Destination: project proposal queue (.guild/recommendations/queue.jsonl). Accept adds a queued proposal.";
}

/** The exact effect of a confirmed decision. Both say what does NOT happen. */
export function decisionEffectText(scope: RecommendationScope, decision: "accept" | "reject"): string {
  if (decision === "reject") {
    return "Reject records the status rejected for this recommendation. Nothing is filed, implemented or changed elsewhere.";
  }
  return scope === "plugin"
    ? "Accept sets the status accepted and writes a local draft only. Nothing is filed to a remote issue tracker. Nothing is implemented. No capability changes."
    : "Accept sets the status queued and adds one proposal to the project queue. Nothing is implemented. No capability changes. Nothing is filed.";
}

/** Status labels for rows already decided. filed/implemented/superseded come
 * only from the producer's record; this UI cannot set them. */
export function statusText(row: RecommendationRow): string {
  switch (row.status) {
    case "proposed":
      return "Proposed. No decision yet.";
    case "accepted":
      return "Accepted local draft. Not filed. Not implemented.";
    case "queued":
      return "Queued proposal. Not implemented.";
    case "rejected":
      return "Rejected.";
    case "filed":
    case "implemented":
    case "superseded":
      return `Recorded as ${row.status} by an operator outside this page.`;
    default:
      return `Unknown status: ${row.status}.`;
  }
}

interface DecisionContext {
  sourceGuild: string;
  sourceKind: "run" | "comparison";
  sourceId: string;
  sourceAnalysisId: string | null;
  sourceInputHash: string | null;
  decisionEligible: boolean | undefined;
}

/** Browser preflight. It can block for feedback; it never authorizes. */
export function decisionBlockedReason(ctx: DecisionContext, row: RecommendationRow): string | null {
  if (row.status !== "proposed") return `status is ${row.status}; only proposed recommendations take a decision here`;
  if (!SAFE_ID.test(row.id)) return `unsupported recommendation id: ${row.id}`;
  if (!SAFE_ID.test(ctx.sourceId)) return `unsupported source id: ${ctx.sourceId}`;
  if (!ctx.sourceAnalysisId) return "the analysis identity is not reported";
  if (!ctx.sourceInputHash || !INPUT_HASH.test(ctx.sourceInputHash)) return "the analysis input hash is not reported";
  if (row.source_id !== ctx.sourceId) return "this recommendation belongs to another source";
  if (row.source_analysis_id !== ctx.sourceAnalysisId) {
    return "this recommendation was made by an older analysis; analyze again first";
  }
  if (ctx.decisionEligible === false) return "the producer reports this analysis is not eligible for decisions";
  return null;
}

type DecisionOutcome = { effect: string; status: string } | null;

function readOutcome(job: AnalysisJobView): DecisionOutcome {
  try {
    const body: unknown = JSON.parse(job.stdout_excerpt);
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      if (isStr(b.effect) && isStr(b.status)) return { effect: b.effect, status: b.status };
    }
  } catch {
    // Excerpt may be truncated; fall through to the generic text.
  }
  return null;
}

/** What a closed decide job means, using only the producer's own result. */
export function decisionResultText(job: AnalysisJobView): string {
  if (!isJobClosed(job)) return describeJobState({ phase: "tracking", job, cancelRequested: false }).text;
  if (job.state !== "succeeded") {
    return `The decision outcome is unverified (${job.state}${job.reason ? `: ${job.reason}` : ""}). The producer may have recorded it before it stopped. Re-read the analysis artifact before you decide again.`;
  }
  const outcome = readOutcome(job);
  if (outcome?.effect === "plugin_draft_written" && outcome.status === "accepted") {
    return "The producer recorded: accepted local draft. Not filed. Not implemented.";
  }
  if (outcome?.effect === "project_proposal_queued" && outcome.status === "queued") {
    return "The producer recorded: queued proposal. Not implemented.";
  }
  if (outcome?.effect === "recommendation_rejected" && outcome.status === "rejected") {
    return "The producer recorded: rejected.";
  }
  return "The producer finished. Reload the analysis to see the recorded status.";
}

// row.id is bounded to 64 chars plus a hash of the full id, so the decision
// and attempt suffix always survive the 128-char limit.
function idempotencyKey(row: RecommendationRow, decision: string, hash: string, attempt: number): string {
  return `decide-${row.id.slice(0, 64)}-${decision}-${hash.replace(/^sha256:/, "").slice(0, 16)}-${shortHash(row.id)}-${attempt}`;
}

function RecommendationItem({
  row,
  source,
  ctx,
  pollIntervalMs,
  onDecided,
  onUnverified,
}: {
  row: RecommendationRow;
  /** The raw record from the parent. A new object means a re-read arrived. */
  source: Record<string, unknown>;
  ctx: DecisionContext;
  pollIntervalMs?: number;
  onDecided?: (job: AnalysisJobView) => void;
  onUnverified?: (job: AnalysisJobView) => void;
}) {
  const { state, start, reset } = useAnalysisJob(pollIntervalMs);
  const [pending, setPending] = useState<"accept" | "reject" | null>(null);
  const notified = useRef<string | null>(null);
  const contextKey = `${ctx.sourceAnalysisId ?? ""}|${ctx.sourceInputHash ?? ""}`;

  // The attempt cap and a 503 block hold until the row or its context changes.
  // Full artifact identity (source guild/kind/id) is part of the key: the same
  // recommendation/analysis/hash ids under a different source are a different
  // decision and must not inherit another source's exhausted cap or block.
  // JSON-encoded tuple: unvalidated fields (sourceGuild, analysis id, status)
  // cannot collide keys with a crafted '|'.
  const rowKey = JSON.stringify([ctx.sourceGuild, ctx.sourceKind, ctx.sourceId, contextKey, row.status]);
  // Remount-persistent identity: the parent unmounts the panel during an
  // analysis re-read, so attempts and the unverified block live in the
  // module stores and component state only mirrors them.
  const persistKey = `${rowKey}|${row.id}`;
  const [attempt, setAttemptState] = useState(() => attemptStore.get(persistKey) ?? 0);
  const setAttempt = (n: number) => {
    storeSet(attemptStore, persistKey, n);
    setAttemptState(n);
  };
  // The record that was current when an outcome became unverified. The row
  // stays blocked while the parent still passes that same record (a re-read
  // delivers a new object and lifts the block).
  const [unverifiedFor, setUnverifiedForState] = useState<Record<string, unknown> | null>(
    () => unverifiedStore.get(persistKey) ?? null,
  );
  const setUnverifiedFor = (rec: Record<string, unknown>) => {
    storeSet(unverifiedStore, persistKey, rec);
    setUnverifiedForState(rec);
  };
  const awaitingReread = unverifiedFor !== null && unverifiedFor === source;
  const seenKey = useRef(rowKey);
  useEffect(() => {
    if (seenKey.current === rowKey) return;
    seenKey.current = rowKey;
    setAttemptState(attemptStore.get(persistKey) ?? 0);
    setUnverifiedForState(unverifiedStore.get(persistKey) ?? null);
    if (state.phase === "unconfigured") reset();
    // persistKey changes exactly when rowKey does (it extends it with row.id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKey, state.phase, reset]);

  const exhausted = attempt >= MAX_DECISION_ATTEMPTS;
  const blocked =
    decisionBlockedReason(ctx, row) ??
    (state.phase === "unconfigured" ? "analysis jobs are unavailable; reload when the analysis package is configured" : null) ??
    (awaitingReread ? "the last decision outcome is unverified; waiting for the re-read analysis artifact" : null) ??
    (exhausted ? `decision attempt limit reached (${MAX_DECISION_ATTEMPTS}); reload the analysis to try again` : null);
  const open = state.phase === "submitting" || (state.phase === "tracking" && !isJobClosed(state.job));

  // A closed job that did not succeed, or an inconsistent report, leaves the
  // outcome unverified.
  const closed = state.phase === "tracking" && isJobClosed(state.job) ? state.job : null;
  const settled = closed ?? (state.phase === "inconsistent" ? state.job : null);
  const verified = closed !== null && closed.state === "succeeded";
  useEffect(() => {
    if (settled && notified.current !== settled.job_id) {
      notified.current = settled.job_id;
      if (verified) {
        onDecided?.(settled);
      } else {
        setUnverifiedFor(source);
        onUnverified?.(settled);
      }
    }
  }, [settled, verified, source, onDecided, onUnverified]);

  const confirm = () => {
    if (!pending || blocked || open || !ctx.sourceAnalysisId || !ctx.sourceInputHash) return;
    const next = attempt + 1;
    setAttempt(next);
    void start(
      {
        source_guild: ctx.sourceGuild,
        operation: "recommendation_decide",
        target_kind: ctx.sourceKind,
        ids: [ctx.sourceId],
        idempotency_key: idempotencyKey(row, pending, ctx.sourceInputHash, next),
        decision: pending,
        recommendation_id: row.id,
        source_analysis_id: ctx.sourceAnalysisId,
        source_input_hash: ctx.sourceInputHash,
      },
      contextKey,
    );
    setPending(null);
  };

  const ask = (decision: "accept" | "reject") => () => {
    if (!blocked && !open) setPending(decision);
  };

  const view = state.phase === "idle" ? null : describeJobState(state);
  const resultText = closed ? decisionResultText(closed) : view?.text ?? "";
  const failure = closed ? closed.state !== "succeeded" : view?.tone === "failure";
  const titleId = `rec-${row.id}-title`;

  return (
    <li className="card" data-testid={`recommendation-${row.id}`} data-scope={row.scope} aria-labelledby={titleId} style={WRAP}>
      <p id={titleId} style={WRAP}>
        <strong>{row.proposed_action}</strong>
      </p>
      <p className="muted">
        {row.kind} · severity {row.severity} · confidence {row.confidence} · {row.evidence_refs.length} evidence ref
        {row.evidence_refs.length === 1 ? "" : "s"}
      </p>
      <p data-testid="recommendation-destination">{destinationText(row.scope)}</p>
      <p data-testid="recommendation-status">{statusText(row)}</p>
      {blocked ? (
        <p className="muted" data-testid="recommendation-blocked">
          Decision disabled: {blocked}
        </p>
      ) : ctx.decisionEligible === undefined ? (
        <p className="muted">The producer checks the expected analysis context when you confirm.</p>
      ) : null}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button type="button" aria-disabled={blocked !== null || open || undefined} onClick={ask("accept")}>
          Accept…
        </button>
        <button type="button" aria-disabled={blocked !== null || open || undefined} onClick={ask("reject")}>
          Reject…
        </button>
      </div>
      {pending ? (
        <div role="group" aria-label={`Confirm ${pending}`} data-testid="decision-prompt">
          <p data-testid="decision-effect">{decisionEffectText(row.scope, pending)}</p>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <button type="button" aria-disabled={blocked !== null || open || undefined} onClick={confirm}>
              Confirm {pending}
            </button>
            <button type="button" onClick={() => setPending(null)}>
              Keep undecided
            </button>
          </div>
        </div>
      ) : null}
      <p role="status" aria-live="polite" data-testid="decision-status">
        {failure ? "" : resultText}
      </p>
      <p role="alert" data-testid="decision-alert">
        {failure ? resultText : ""}
      </p>
    </li>
  );
}

export interface RecommendationPanelProps extends DecisionContext {
  recommendations: Array<Record<string, unknown>>;
  pollIntervalMs?: number;
  onDecided?: (job: AnalysisJobView) => void;
  /** A decide job closed without success or sent an inconsistent report:
   * re-read the analysis artifact and pass the new records. The row stays
   * blocked until a new record object arrives. */
  onUnverified?: (job: AnalysisJobView) => void;
}

export default function RecommendationPanel({ recommendations, pollIntervalMs, onDecided, onUnverified, ...ctx }: RecommendationPanelProps) {
  const rows = recommendations.map((source) => ({ row: toRecommendationRow(source), source }));
  const valid = rows.filter((r): r is { row: RecommendationRow; source: Record<string, unknown> } => r.row !== null);
  const invalid = rows.length - valid.length;
  return (
    <section className="card" data-testid="recommendation-panel" aria-label="Recommendations" style={WRAP}>
      <h3>Recommendations</h3>
      <p className="muted">
        Each decision is explicit. This page never files remote issues and never marks work implemented.
      </p>
      {invalid > 0 ? (
        <p className="muted" data-testid="recommendation-invalid">
          {invalid} recommendation row{invalid === 1 ? "" : "s"} could not be read and {invalid === 1 ? "is" : "are"} not shown.
        </p>
      ) : null}
      {valid.length === 0 ? (
        <div className="empty">No recommendations for this analysis.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {valid.map(({ row, source }) => (
            <RecommendationItem
              key={row.id}
              row={row}
              source={source}
              ctx={ctx}
              pollIntervalMs={pollIntervalMs}
              onDecided={onDecided}
              onUnverified={onUnverified}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
