// benchmark/src/summary-md-regen.ts
//
// Regenerates `<runDir>/logs/summary.md` from the live JSONL log + every
// archived `.jsonl.gz` chunk + per-lane fallback files.
// Output is deterministic given the same input set.
//
// Local benchmark mirror of plugin/scripts/v1.4-summary-md-regen.ts.
// Uses ./log-jsonl.js and ./log-validator.js (local deps, no cross-repo import).
//
// Implements the binding contract from
// `benchmark/plans/v1.4-jsonl-schema.md` §"Post-rotation summary regen
// contract".
//
// Library API:
//   import { regenerateSummary } from "./summary-md-regen.js";
//   const result = await regenerateSummary({ runDir });

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

import {
  readAllEvents,
  summaryPath,
  type JsonlEvent,
  type ToolCallEvent,
  type HookEvent,
  type PhaseStartEvent,
  type PhaseEndEvent,
  type SpecialistDispatchEvent,
  type SpecialistReceiptEvent,
  type LoopRoundEndEvent,
  type GateDecisionEvent,
  type EscalationEvent,
  type AssumptionLoggedEvent,
  type CodexReviewRoundEvent,
} from "./log-jsonl.js";
import { validateEvent } from "./log-validator.js";

// ──────────────────────────────────────────────────────────────────────────
// Latency aggregation helpers — p50 / p99
// ──────────────────────────────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

interface ToolAgg {
  count: number;
  latencies: number[];
  errCount: number;
  okCount: number;
  naCount: number;
}

interface HookAgg {
  count: number;
  latencies: number[];
  errCount: number;
  okCount: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Section builders
// ──────────────────────────────────────────────────────────────────────────

function buildPhasesSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Phases"];
  const pendingByPhase = new Map<string, PhaseStartEvent>();
  const closed: Array<{ start: PhaseStartEvent; end: PhaseEndEvent }> = [];
  for (const e of events) {
    if (e.event === "phase_start") {
      pendingByPhase.set(e.phase, e);
    } else if (e.event === "phase_end") {
      const start = pendingByPhase.get(e.phase);
      if (start) {
        closed.push({ start, end: e });
        pendingByPhase.delete(e.phase);
      }
    }
  }
  if (closed.length === 0 && pendingByPhase.size === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  for (const { start, end } of closed) {
    out.push(`- **${start.phase}** — ${end.duration_ms}ms — ${end.status}`);
  }
  for (const start of pendingByPhase.values()) {
    out.push(`- **${start.phase}** — (started ${start.ts}, no phase_end)`);
  }
  return out.join("\n") + "\n";
}

function buildDispatchesSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Specialist dispatches"];
  const dispatched: Array<SpecialistDispatchEvent> = [];
  const receipts = new Map<string, SpecialistReceiptEvent>();
  for (const e of events) {
    if (e.event === "specialist_dispatch") dispatched.push(e);
    else if (e.event === "specialist_receipt") {
      receipts.set(`${e.lane_id}|${e.specialist}`, e);
    }
  }
  if (dispatched.length === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  for (const d of dispatched) {
    const r = receipts.get(`${d.lane_id}|${d.specialist}`);
    if (r) {
      out.push(`- ${d.specialist} / ${d.lane_id} — receipt: ${r.receipt_path}`);
    } else {
      out.push(`- ${d.specialist} / ${d.lane_id} — (no receipt yet)`);
    }
  }
  return out.join("\n") + "\n";
}

function buildLoopRoundsSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Loop rounds"];
  interface Bucket {
    rounds: number;
    terminators: string[];
    terminations: string[];
  }
  const buckets = new Map<string, Bucket>();
  for (const e of events) {
    if (e.event !== "loop_round_end") continue;
    const lane = e as LoopRoundEndEvent;
    const key = `${lane.lane_id}|${lane.loop_layer}`;
    const b = buckets.get(key) ?? {
      rounds: 0,
      terminators: [],
      terminations: [],
    };
    b.rounds = Math.max(b.rounds, lane.round_number);
    b.terminators.push(lane.terminator);
    b.terminations.push(lane.terminated);
    buckets.set(key, b);
  }
  if (buckets.size === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  out.push("| Lane | Layer | Rounds | Final terminator | Final outcome |");
  out.push("| --- | --- | --: | --- | --- |");
  const keys = [...buckets.keys()].sort();
  for (const key of keys) {
    const [lane, layer] = key.split("|");
    const b = buckets.get(key);
    if (!b) continue;
    const lastTerminator = b.terminators[b.terminators.length - 1] ?? "";
    const lastOutcome = b.terminations[b.terminations.length - 1] ?? "";
    out.push(
      `| ${lane} | ${layer} | ${b.rounds} | ${lastTerminator} | ${lastOutcome} |`,
    );
  }
  return out.join("\n") + "\n";
}

function buildGatesSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Gates"];
  const gates = events.filter(
    (e): e is GateDecisionEvent => e.event === "gate_decision",
  );
  if (gates.length === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  for (const g of gates) {
    out.push(`- ${g.gate} — ${g.decision} — source: ${g.source}`);
  }
  return out.join("\n") + "\n";
}

function buildToolsSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Tools"];
  const aggs = new Map<string, ToolAgg>();
  for (const e of events) {
    if (e.event !== "tool_call") continue;
    const t = e as ToolCallEvent;
    const a = aggs.get(t.tool) ?? {
      count: 0,
      latencies: [],
      errCount: 0,
      okCount: 0,
      naCount: 0,
    };
    a.count += 1;
    a.latencies.push(t.latency_ms);
    if (t.status === "ok") a.okCount += 1;
    else if (t.status === "err") a.errCount += 1;
    else a.naCount += 1;
    aggs.set(t.tool, a);
  }
  if (aggs.size === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  out.push("| Tool | Count | ok | err | n/a | p50 ms | p99 ms |");
  out.push("| --- | --: | --: | --: | --: | --: | --: |");
  const keys = [...aggs.keys()].sort();
  for (const key of keys) {
    const a = aggs.get(key);
    if (!a) continue;
    out.push(
      `| ${key} | ${a.count} | ${a.okCount} | ${a.errCount} | ${a.naCount} | ${percentile(a.latencies, 50)} | ${percentile(a.latencies, 99)} |`,
    );
  }
  return out.join("\n") + "\n";
}

function buildHooksSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Hooks"];
  const aggs = new Map<string, HookAgg>();
  for (const e of events) {
    if (e.event !== "hook_event") continue;
    const h = e as HookEvent;
    const a = aggs.get(h.hook_name) ?? {
      count: 0,
      latencies: [],
      errCount: 0,
      okCount: 0,
    };
    a.count += 1;
    a.latencies.push(h.latency_ms);
    if (h.status === "ok") a.okCount += 1;
    else a.errCount += 1;
    aggs.set(h.hook_name, a);
  }
  if (aggs.size === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  out.push("| Hook | Count | ok | err | p50 ms | p99 ms |");
  out.push("| --- | --: | --: | --: | --: | --: |");
  const keys = [...aggs.keys()].sort();
  for (const key of keys) {
    const a = aggs.get(key);
    if (!a) continue;
    out.push(
      `| ${key} | ${a.count} | ${a.okCount} | ${a.errCount} | ${percentile(a.latencies, 50)} | ${percentile(a.latencies, 99)} |`,
    );
  }
  return out.join("\n") + "\n";
}

function buildEscalationsSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Escalations"];
  const esc = events.filter(
    (e): e is EscalationEvent => e.event === "escalation",
  );
  if (esc.length === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  for (const e of esc) {
    out.push(
      `- ${e.lane_id ?? "(no-lane)"} — reason: ${e.reason} — choice: ${e.user_choice} — options: [${e.options_offered.join(", ")}]`,
    );
  }
  return out.join("\n") + "\n";
}

function buildAssumptionsSection(events: JsonlEvent[]): string {
  const out: string[] = ["## Assumptions"];
  const ass = events.filter(
    (e): e is AssumptionLoggedEvent => e.event === "assumption_logged",
  );
  if (ass.length === 0) {
    out.push("(none)");
    return out.join("\n") + "\n";
  }
  for (const a of ass) {
    out.push(`- ${a.specialist} / ${a.lane_id}: ${a.assumption_text}`);
  }
  return out.join("\n") + "\n";
}

function buildCodexSection(events: JsonlEvent[]): string {
  const codex = events.filter(
    (e): e is CodexReviewRoundEvent => e.event === "codex_review_round",
  );
  if (codex.length === 0) return "";
  const out: string[] = ["## Codex review"];
  for (const c of codex) {
    out.push(
      `- ${c.gate} — round ${c.round_number} — satisfied: ${c.terminated_by_satisfied}`,
    );
  }
  return out.join("\n") + "\n";
}

function buildUnrecognizedSection(events: JsonlEvent[]): string {
  const known = new Set<string>([
    "phase_start",
    "phase_end",
    "specialist_dispatch",
    "specialist_receipt",
    "loop_round_start",
    "loop_round_end",
    "tool_call",
    "hook_event",
    "gate_decision",
    "assumption_logged",
    "escalation",
    "codex_review_round",
  ]);
  const unknown: string[] = [];
  for (const e of events) {
    if (!known.has(e.event)) unknown.push(e.event);
  }
  if (unknown.length === 0) return "";
  const counts = new Map<string, number>();
  for (const u of unknown) counts.set(u, (counts.get(u) ?? 0) + 1);
  const out: string[] = ["## Unrecognized events"];
  for (const k of [...counts.keys()].sort()) {
    out.push(`- ${k}: ${counts.get(k) ?? 0}`);
  }
  return out.join("\n") + "\n";
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export interface RegenOptions {
  /** Run dir under `.guild/runs/<run-id>/`. */
  runDir: string;
  /** Override output path; defaults to `<runDir>/logs/summary.md`. */
  outPath?: string;
}

export interface RegenResult {
  /** The exact bytes written to `summary.md`. */
  markdown: string;
  /** The path written. */
  outPath: string;
  /** Count of events read across all sources. */
  eventCount: number;
  /** Count of skipped lines (validation failures). */
  skipped: number;
}

/**
 * Regenerate the summary.md for a run. Returns the markdown string plus
 * write metadata. Writes to disk by default; pass `outPath` to redirect.
 *
 * Determinism: ordering is by source priority (archives first in
 * <N>-ascending order, then live, then per-lane fallback files alphabetically).
 */
export async function regenerateSummary(
  opts: RegenOptions,
): Promise<RegenResult> {
  let skipped = 0;
  const events = await readAllEvents(opts.runDir, {
    onSkip: () => {
      skipped += 1;
    },
    validate: (parsed) => {
      const result = validateEvent(parsed);
      if (result.ok) return { ok: true };
      return { ok: false, reason: result.errors.join("; ") };
    },
  });
  const ordered = events;

  const sections: string[] = [
    `# Run summary — ${opts.runDir}`,
    "",
    buildPhasesSection(ordered),
    buildDispatchesSection(ordered),
    buildLoopRoundsSection(ordered),
    buildGatesSection(ordered),
    buildToolsSection(ordered),
    buildHooksSection(ordered),
    buildEscalationsSection(ordered),
    buildAssumptionsSection(ordered),
  ];
  const codex = buildCodexSection(ordered);
  if (codex.length > 0) sections.push(codex);
  const unrecognized = buildUnrecognizedSection(ordered);
  if (unrecognized.length > 0) sections.push(unrecognized);

  const md = sections.join("\n");
  const out = opts.outPath ?? summaryPath(opts.runDir);
  if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, md);
  return { markdown: md, outPath: out, eventCount: ordered.length, skipped };
}
