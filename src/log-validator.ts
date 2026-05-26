// benchmark/src/log-validator.ts
//
// Local mirror of the JSONL schema validator.  Owns the validation logic
// for events emitted by src/log-jsonl.ts against the binding schema doc
// `benchmark/plans/v1.4-jsonl-schema.md` (12 event types, schema_version: 1).
//
// THE CONTRACT IS THE BENCHMARK PLAN DOC, NOT THE PLUGIN.
// The plugin/scripts/v1.4-log-validator.ts is a companion validator that
// re-implements the same rules against the same schema doc.  Neither file
// imports the other; they share the spec, not the code.  Keeping them
// independent allows each repo to evolve independently — any drift in the
// schema must be reconciled explicitly.
//
// Re-exports TOOL_CALL_TOOL_VALUES and HOOK_EVENT_NAMES from ./log-jsonl.js
// so callers that previously imported from the plugin validator can switch
// to a single local import.
//
// Usage (library):
//   import { validateEvent, validateText } from "./log-validator.js";
//   const result = validateEvent(parsedObject);
//   if (!result.ok) console.error(result.errors);

// ──────────────────────────────────────────────────────────────────────────
// Re-export the closed enums from the benchmark's canonical log-jsonl so
// callers see one source of truth inside this repo.
// ──────────────────────────────────────────────────────────────────────────
export {
  TOOL_CALL_TOOL_VALUES,
  HOOK_EVENT_NAMES,
} from "./log-jsonl.js";

import {
  TOOL_CALL_TOOL_VALUES,
  HOOK_EVENT_NAMES,
  EVENT_TYPES as EVENT_TYPES_SET,
} from "./log-jsonl.js";

// Expose EVENT_TYPES as a sorted ReadonlyArray so callers that relied on
// the plugin validator's array form (e.g. `EVENT_TYPES.length`) continue to
// work.  The benchmark log-jsonl stores this as a ReadonlySet; we derive the
// array here and keep it sorted for deterministic comparisons.
export const EVENT_TYPES: ReadonlyArray<string> = [
  ...EVENT_TYPES_SET,
].sort() as ReadonlyArray<string>;

// ──────────────────────────────────────────────────────────────────────────
// Additional closed enums — copied verbatim from
// `benchmark/plans/v1.4-jsonl-schema.md`.  Expanding any of these requires
// a schema bump.
// ──────────────────────────────────────────────────────────────────────────

export const PHASE_VALUES = [
  "brainstorm",
  "team-compose",
  "plan",
  "context",
  "execute",
  "review",
  "verify",
  "reflect",
] as const;

export const LOOP_LAYER_VALUES = [
  "L1",
  "L2",
  "L3",
  "L4",
  "security-review",
] as const;

export const PHASE_END_STATUS = ["ok", "error", "escalated"] as const;
export const LOOP_TERMINATED = [
  "satisfied",
  "malformed_termination",
  "cap_hit",
  "escalation",
  "error",
] as const;
export const TOOL_CALL_STATUS = ["ok", "err", "n/a"] as const;
export const HOOK_STATUS = ["ok", "err"] as const;
export const GATE_DECISION = ["approved", "rejected", "deferred"] as const;
export const GATE_SOURCE = ["user", "auto-approve-mode"] as const;
export const ESCALATION_REASON = [
  "cap_hit",
  "malformed_termination_x2",
  "restart_cap_hit",
] as const;
export const ESCALATION_LABELS = ["force-pass", "extend-cap", "rework"] as const;
export const FIXED_GATES = ["gate-1-spec", "gate-2-team", "gate-3-plan"] as const;

// ──────────────────────────────────────────────────────────────────────────
// Regex constants
// ──────────────────────────────────────────────────────────────────────────

// ISO-8601 timestamp with millisecond precision (Z-suffixed).
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// gate_decision.gate slug grammar — schema doc §9.
const MID_EXEC_DECISION_RE = /^mid-execution-decision:[a-z][a-z0-9-]{0,63}$/;

// codex_review_round.gate lane-id grammar — schema doc §12.
const G_LANE_RE = /^G-lane:T[0-9]+[a-z]?-[a-z][a-z-]{0,32}$/;

// ──────────────────────────────────────────────────────────────────────────
// Validator result type
// ──────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Primitive helpers
// ──────────────────────────────────────────────────────────────────────────

function isString(v: unknown): v is string {
  return typeof v === "string";
}
function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
}
function isNonNegInt(v: unknown): v is number {
  return isInt(v) && v >= 0;
}
function isPosInt(v: unknown): v is number {
  return isInt(v) && v >= 1;
}
function isBool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function isOneOf<T extends readonly string[]>(
  v: unknown,
  values: T,
): v is T[number] {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}

// ──────────────────────────────────────────────────────────────────────────
// Envelope + field helpers
// ──────────────────────────────────────────────────────────────────────────

function checkEnvelope(
  obj: Record<string, unknown>,
  errs: string[],
  expectedEvent: string,
): void {
  if (!isString(obj.ts) || !ISO_TS_RE.test(obj.ts)) {
    errs.push(
      `ts: expected ISO-8601 millisecond UTC timestamp, got ${JSON.stringify(obj.ts)}`,
    );
  }
  if (obj.event !== expectedEvent) {
    errs.push(
      `event: expected "${expectedEvent}", got ${JSON.stringify(obj.event)}`,
    );
  }
  if (!isString(obj.run_id) || obj.run_id.length === 0) {
    errs.push(`run_id: expected non-empty string`);
  }
}

function checkOptionalString(
  obj: Record<string, unknown>,
  field: string,
  errs: string[],
): void {
  if (field in obj && !isString(obj[field])) {
    errs.push(
      `${field}: expected string when present, got ${typeof obj[field]}`,
    );
  }
}

function checkRequiredString(
  obj: Record<string, unknown>,
  field: string,
  errs: string[],
): void {
  if (!isString(obj[field]) || (obj[field] as string).length === 0) {
    errs.push(`${field}: expected non-empty string`);
  }
}

function checkRequiredEnum(
  obj: Record<string, unknown>,
  field: string,
  values: readonly string[],
  errs: string[],
): void {
  if (!isOneOf(obj[field], values)) {
    errs.push(
      `${field}: expected one of ${JSON.stringify(values)}, got ${JSON.stringify(obj[field])}`,
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Per-event validators
// ──────────────────────────────────────────────────────────────────────────

function validatePhaseStart(o: Record<string, unknown>, errs: string[]): void {
  checkEnvelope(o, errs, "phase_start");
  checkRequiredEnum(o, "phase", PHASE_VALUES, errs);
}
function validatePhaseEnd(o: Record<string, unknown>, errs: string[]): void {
  checkEnvelope(o, errs, "phase_end");
  checkRequiredEnum(o, "phase", PHASE_VALUES, errs);
  if (!isNonNegInt(o.duration_ms))
    errs.push(`duration_ms: expected non-negative integer`);
  checkRequiredEnum(o, "status", PHASE_END_STATUS, errs);
}
function validateSpecialistDispatch(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "specialist_dispatch");
  checkRequiredString(o, "lane_id", errs);
  checkRequiredString(o, "specialist", errs);
  checkRequiredString(o, "task_id", errs);
  checkRequiredString(o, "prompt_excerpt", errs);
}
function validateSpecialistReceipt(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "specialist_receipt");
  checkRequiredString(o, "lane_id", errs);
  checkRequiredString(o, "specialist", errs);
  checkRequiredString(o, "task_id", errs);
  checkRequiredString(o, "receipt_path", errs);
}
function validateLoopRoundStart(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "loop_round_start");
  checkRequiredString(o, "lane_id", errs);
  checkRequiredEnum(o, "loop_layer", LOOP_LAYER_VALUES, errs);
  if (!isPosInt(o.round_number)) errs.push(`round_number: expected integer ≥ 1`);
  if (!isPosInt(o.cap) || (o.cap as number) > 256)
    errs.push(`cap: expected integer in [1, 256]`);
}
function validateLoopRoundEnd(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "loop_round_end");
  checkRequiredString(o, "lane_id", errs);
  checkRequiredEnum(o, "loop_layer", LOOP_LAYER_VALUES, errs);
  if (!isPosInt(o.round_number)) errs.push(`round_number: expected integer ≥ 1`);
  checkRequiredEnum(o, "terminated", LOOP_TERMINATED, errs);
  checkRequiredString(o, "terminator", errs);
}
function validateToolCall(o: Record<string, unknown>, errs: string[]): void {
  checkEnvelope(o, errs, "tool_call");
  checkOptionalString(o, "lane_id", errs);
  checkRequiredEnum(o, "tool", TOOL_CALL_TOOL_VALUES, errs);
  if (!isString(o.command_redacted))
    errs.push(`command_redacted: expected string (may be empty)`);
  checkRequiredEnum(o, "status", TOOL_CALL_STATUS, errs);
  if (!isNonNegInt(o.latency_ms))
    errs.push(`latency_ms: expected non-negative integer`);
  if (!isString(o.result_excerpt_redacted))
    errs.push(`result_excerpt_redacted: expected string (may be empty)`);
  if ("tokens_in" in o && !isNonNegInt(o.tokens_in))
    errs.push(`tokens_in: when present, expected non-negative integer`);
  if ("tokens_out" in o && !isNonNegInt(o.tokens_out))
    errs.push(`tokens_out: when present, expected non-negative integer`);
}
function validateHookEvent(o: Record<string, unknown>, errs: string[]): void {
  checkEnvelope(o, errs, "hook_event");
  checkOptionalString(o, "lane_id", errs);
  checkRequiredEnum(o, "hook_name", HOOK_EVENT_NAMES, errs);
  if (!isString(o.payload_excerpt_redacted))
    errs.push(`payload_excerpt_redacted: expected string (may be empty)`);
  if (!isNonNegInt(o.latency_ms))
    errs.push(`latency_ms: expected non-negative integer`);
  checkRequiredEnum(o, "status", HOOK_STATUS, errs);
}
function validateGateDecision(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "gate_decision");
  if (!isString(o.gate)) {
    errs.push(`gate: expected string`);
  } else {
    const g = o.gate;
    const ok =
      (FIXED_GATES as readonly string[]).includes(g) ||
      MID_EXEC_DECISION_RE.test(g);
    if (!ok)
      errs.push(
        `gate: expected one of ${JSON.stringify(FIXED_GATES)} or "mid-execution-decision:<slug>", got ${JSON.stringify(g)}`,
      );
  }
  checkRequiredEnum(o, "decision", GATE_DECISION, errs);
  checkRequiredEnum(o, "source", GATE_SOURCE, errs);
}
function validateAssumptionLogged(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "assumption_logged");
  checkRequiredString(o, "lane_id", errs);
  checkRequiredString(o, "specialist", errs);
  checkRequiredString(o, "assumption_text", errs);
}
function validateEscalation(o: Record<string, unknown>, errs: string[]): void {
  checkEnvelope(o, errs, "escalation");
  checkOptionalString(o, "lane_id", errs);
  checkRequiredEnum(o, "reason", ESCALATION_REASON, errs);
  const off = o.options_offered;
  if (
    !Array.isArray(off) ||
    off.length !== ESCALATION_LABELS.length ||
    !ESCALATION_LABELS.every((label, i) => off[i] === label)
  ) {
    errs.push(
      `options_offered: expected exactly ${JSON.stringify(ESCALATION_LABELS)}`,
    );
  }
  checkRequiredEnum(o, "user_choice", ESCALATION_LABELS, errs);
}
function validateCodexReviewRound(
  o: Record<string, unknown>,
  errs: string[],
): void {
  checkEnvelope(o, errs, "codex_review_round");
  if (!isString(o.gate)) {
    errs.push(`gate: expected string`);
  } else {
    const g = o.gate;
    const ok =
      g === "G-spec" || g === "G-plan" || g === "G-diagnose" || G_LANE_RE.test(g);
    if (!ok)
      errs.push(
        `gate: expected "G-spec" | "G-plan" | "G-diagnose" | "G-lane:<lane-id>", got ${JSON.stringify(g)}`,
      );
  }
  if (!isPosInt(o.round_number) || (o.round_number as number) > 5)
    errs.push(`round_number: expected integer in [1, 5] (Codex cap = 5)`);
  if (!isBool(o.terminated_by_satisfied))
    errs.push(`terminated_by_satisfied: expected boolean`);
}

const VALIDATORS: Record<
  string,
  (o: Record<string, unknown>, errs: string[]) => void
> = {
  phase_start: validatePhaseStart,
  phase_end: validatePhaseEnd,
  specialist_dispatch: validateSpecialistDispatch,
  specialist_receipt: validateSpecialistReceipt,
  loop_round_start: validateLoopRoundStart,
  loop_round_end: validateLoopRoundEnd,
  tool_call: validateToolCall,
  hook_event: validateHookEvent,
  gate_decision: validateGateDecision,
  assumption_logged: validateAssumptionLogged,
  escalation: validateEscalation,
  codex_review_round: validateCodexReviewRound,
};

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate a single parsed event object. Returns
 * `{ ok: true, errors: [] }` on success, or `{ ok: false, errors: [...] }`
 * on failure with one error string per violation.
 */
export function validateEvent(parsed: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, errors: ["event must be a JSON object"] };
  }
  const o = parsed as Record<string, unknown>;
  if (!isString(o.event)) {
    return { ok: false, errors: ['envelope: "event" field missing or non-string'] };
  }
  if (!EVENT_TYPES.includes(o.event)) {
    return {
      ok: false,
      errors: [
        `event: unknown value ${JSON.stringify(o.event)}; ` +
          `expected one of ${JSON.stringify(EVENT_TYPES)}`,
      ],
    };
  }
  // Schema doc §"Encoding rules" #3 — null is a violation.
  for (const [k, v] of Object.entries(o)) {
    if (v === null) errors.push(`${k}: null is not allowed (omit the field instead)`);
  }
  const validator = VALIDATORS[o.event];
  if (validator) validator(o, errors);
  return { ok: errors.length === 0, errors };
}

/**
 * Validate every line of a JSONL text blob. Returns the per-line
 * results in input order. Empty lines are skipped silently.
 */
export function validateText(text: string): {
  total: number;
  valid: number;
  invalid: number;
  perLine: Array<{ line: number; result: ValidationResult }>;
} {
  const lines = text.split("\n");
  const perLine: Array<{ line: number; result: ValidationResult }> = [];
  let valid = 0;
  let invalid = 0;
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined || raw.length === 0) continue;
    total += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      invalid += 1;
      perLine.push({
        line: i + 1,
        result: {
          ok: false,
          errors: [
            `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
          ],
        },
      });
      continue;
    }
    const result = validateEvent(parsed);
    if (result.ok) valid += 1;
    else invalid += 1;
    perLine.push({ line: i + 1, result });
  }
  return { total, valid, invalid, perLine };
}
