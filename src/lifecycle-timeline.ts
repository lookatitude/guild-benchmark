// benchmark/src/lifecycle-timeline.ts — SC-F entry-to-close timeline renderer.
//
// Locked by `.guild/initiatives/active/learn-knowledge-convergence/artifacts/
// benchmark-import-contract.md §4`. Reads ON-DISK artifacts only — the inputs
// to `renderTimeline` are already-parsed shapes from `run.yaml.phases_log`
// (the replay backbone) and `logs/v1.4-events.jsonl` (the trace overlay + the
// run_started/run_closed lifecycle markers). NO plugin module is imported.
//
// The two streams are merged and sorted by `at`, producing a unified
// entry-to-close view covering: phase detection -> ideate/plan/build/learn/
// qa/ops/... -> close, user gates, specialist dispatches + receipts, and the
// run_started / run_closed lifecycle markers. This satisfies the brief's
// "analyze the complete run from entrypoint to close" (§470-486) for ALL run
// types, not just build.

import type {
  JsonlEvent,
  PhaseStartEvent,
  PhaseEndEvent,
  SpecialistDispatchEvent,
  SpecialistReceiptEvent,
  GateDecisionEvent,
  ToolCallEvent,
  EscalationEvent,
} from "./run-events-schema.js";
import type {
  LifecyclePhaseLogEntry,
  TimelineEntry,
} from "./types.js";

// The frozen `guild.trace_event.v1` lifecycle markers (run_started /
// run_closed) are NOT members of the 12-type v1.4 closed union (they are
// appended raw by the plugin's run-trace hook). We read them off-disk as
// loose JSON lines, so model them structurally here rather than importing a
// plugin schema.
export interface LifecycleTraceMarker {
  ts?: string;
  at?: string;
  event?: string;
  event_name?: string;
  run_id?: string;
  [key: string]: unknown;
}

export interface RenderTimelineOpts {
  phasesLog: LifecyclePhaseLogEntry[];
  // The v1.4 closed-union trace events (phase/specialist/gate/tool/escalation).
  traceEvents: JsonlEvent[];
  // Raw lifecycle markers (run_started / run_closed) read loosely off the same
  // jsonl. Optional — absent when the run is still open or pre-spine.
  lifecycleMarkers?: LifecycleTraceMarker[];
}

// Stable sort by `at` (RFC3339 lexicographic == chronological for UTC Z
// timestamps). Entries with an empty `at` sink to the end but keep insertion
// order amongst themselves (deterministic — no wall-clock).
function sortByAt(entries: TimelineEntry[]): TimelineEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const av = a.e.at;
      const bv = b.e.at;
      if (av === bv) return a.i - b.i;
      if (av === "") return 1;
      if (bv === "") return -1;
      return av < bv ? -1 : 1;
    })
    .map((x) => x.e);
}

function phaseLogToEntries(phasesLog: LifecyclePhaseLogEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const p of phasesLog) {
    const detail: Record<string, unknown> = {};
    if (p.proposed !== undefined) detail.proposed = p.proposed;
    if (p.detected_from !== undefined) detail.detected_from = p.detected_from;
    if (p.deliverable !== undefined) detail.deliverable = p.deliverable;
    if (p.gate !== undefined) detail.gate = p.gate;
    out.push({
      at: typeof p.at === "string" ? p.at : "",
      kind: "phase",
      label: p.phase,
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    });
  }
  return out;
}

function traceEventToEntry(e: JsonlEvent): TimelineEntry | null {
  switch (e.event) {
    case "phase_start": {
      const ev = e as PhaseStartEvent;
      return { at: ev.ts, kind: "phase", label: `${ev.phase} (start)` };
    }
    case "phase_end": {
      const ev = e as PhaseEndEvent;
      return {
        at: ev.ts,
        kind: "phase",
        label: `${ev.phase} (end)`,
        duration_ms: ev.duration_ms,
        detail: { status: ev.status },
      };
    }
    case "specialist_dispatch": {
      const ev = e as SpecialistDispatchEvent;
      return {
        at: ev.ts,
        kind: "specialist_dispatch",
        label: ev.specialist,
        detail: { task_id: ev.task_id, lane_id: ev.lane_id },
      };
    }
    case "specialist_receipt": {
      const ev = e as SpecialistReceiptEvent;
      return {
        at: ev.ts,
        kind: "specialist_receipt",
        label: ev.specialist,
        detail: { task_id: ev.task_id, lane_id: ev.lane_id },
      };
    }
    case "gate_decision": {
      const ev = e as GateDecisionEvent;
      return {
        at: ev.ts,
        kind: "gate",
        label: ev.gate,
        detail: { decision: ev.decision, source: ev.source },
      };
    }
    case "tool_call": {
      const ev = e as ToolCallEvent;
      // Only surface errored tool calls on the timeline (signal, not noise).
      if (ev.status !== "err") return null;
      return {
        at: ev.ts,
        kind: "tool_call",
        label: `${ev.tool} (err)`,
        detail: { lane_id: ev.lane_id },
      };
    }
    case "escalation": {
      const ev = e as EscalationEvent;
      return {
        at: ev.ts,
        kind: "escalation",
        label: ev.reason,
        detail: { user_choice: ev.user_choice },
      };
    }
    default:
      // loop_round_*, hook_event, assumption_logged, codex_review_round are
      // not lifecycle-timeline-relevant; omit (metrics read them separately).
      return null;
  }
}

function lifecycleMarkerToEntry(m: LifecycleTraceMarker): TimelineEntry | null {
  const name = m.event_name ?? m.event;
  if (name !== "run_started" && name !== "run_closed") return null;
  const at = typeof m.at === "string" ? m.at : typeof m.ts === "string" ? m.ts : "";
  return {
    at,
    kind: name,
    label: name,
    ...(m.run_id ? { detail: { run_id: m.run_id } } : {}),
  };
}

/**
 * Render the entry-to-close timeline. Merges `phases_log` (replay backbone)
 * with the v1.4 trace overlay and the run_started/run_closed markers, sorted
 * by `at`. Pure + deterministic — no wall-clock, no network, no random.
 */
export function renderTimeline(opts: RenderTimelineOpts): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  entries.push(...phaseLogToEntries(opts.phasesLog));
  for (const e of opts.traceEvents) {
    const mapped = traceEventToEntry(e);
    if (mapped) entries.push(mapped);
  }
  for (const m of opts.lifecycleMarkers ?? []) {
    const mapped = lifecycleMarkerToEntry(m);
    if (mapped) entries.push(mapped);
  }
  return sortByAt(entries);
}

/**
 * Replay completeness heuristic (§488-505 "replay completeness" metric).
 * - "full": phases_log non-empty AND a run_closed marker present.
 * - "partial": phases_log present but no close marker (run open / pre-close).
 * - "none": no phases_log and no trace events at all.
 */
export function deriveReplayCompleteness(
  opts: RenderTimelineOpts,
): "full" | "partial" | "none" {
  const hasPhases = opts.phasesLog.length > 0;
  const hasTrace = opts.traceEvents.length > 0;
  const hasClose = (opts.lifecycleMarkers ?? []).some(
    (m) => (m.event_name ?? m.event) === "run_closed",
  );
  if (!hasPhases && !hasTrace) return "none";
  if (hasClose) return "full";
  return "partial";
}
