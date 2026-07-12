// benchmark/src/o3-threshold-analyzer.ts
//
// Usage: node --loader tsx benchmark/src/o3-threshold-analyzer.ts <run-dir>...
//
// O-3 short-output threshold calibration (D-OBS-3 + D-OBS-1).
//
// Reads guild.trace_event.v1/v2 JSONL events from one or more run directories,
// groups `tool_call` events by (task_type, tier), requires ≥30 samples per
// bucket, and derives the p10-output-token baseline per D-OBS-3:
//
//   "activate only once the benchmark analyzer has accumulated ≥30 run
//    samples in a (task_type, tier) bucket and derived the
//    p10-output-token baseline."
//
// task_type  = "{phase}:{specialist}"  (D-OBS-3 / brief §4.3 —
//              actor_id from specialist_dispatch.specialist,
//              phase from the enclosing phase_start.phase)
// tier       = v2 `tier` field on the tool_call event (D-OBS-1 additive);
//              "unknown" when absent (older traces without v2 fields)
// output_tokens = v2 `tokens.output` (nested, D-OBS-1) when present;
//                 falls back to flat `tokens_out` (v1.4 field)
//
// Output: PROPOSED `models.shortOutputThreshold[task_type][tier]` fragment.
//
// PROPOSAL ONLY — this module NEVER writes to settings.json.
// Guild discipline: nothing auto-promotes (D-OBS-3 §"activate after ≥30
// samples"; §10.5.1 write path).

import { readAllEvents } from "./log-jsonl.js";

// ── Minimum samples gate (D-OBS-3) ────────────────────────────────────────────
export const MIN_SAMPLES = 30;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ThresholdBucket {
  taskType: string;
  tier: string;
  /** Number of output-token samples collected. */
  samples: number;
  /** p10-output-token baseline (D-OBS-3 statistic). */
  p10: number;
}

export interface SkippedBucket {
  taskType: string;
  tier: string;
  /** Samples collected — always < MIN_SAMPLES. */
  samples: number;
}

export interface ThresholdProposal {
  /**
   * Proposed `models.shortOutputThreshold` fragment.
   * Shape: Record<task_type, Record<tier, p10_threshold>>.
   *
   * Only populated for buckets with ≥ MIN_SAMPLES.
   * NEVER write this to settings.json directly — it is a proposal/report.
   */
  thresholds: Record<string, Record<string, number>>;
  /** Full per-bucket detail for buckets that met the gate. */
  buckets: ThresholdBucket[];
  /** Buckets omitted because they had < MIN_SAMPLES. */
  skippedBuckets: SkippedBucket[];
}

export interface AnalyzeRunsOptions {
  runDirs: string[];
}

// ── Statistics ─────────────────────────────────────────────────────────────────

/**
 * 10th percentile of a *sorted* numeric array.
 * D-OBS-3 statistic: "p10-output-token baseline".
 *
 * Uses the nearest-rank method (floor(0.1 * (n - 1))).
 * Returns 0 for an empty array.
 */
export function p10(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.floor(0.1 * (sortedValues.length - 1));
  return sortedValues[idx] ?? 0;
}

// ── Field extraction (lenient — v1.4 flat + v2 nested) ────────────────────────

/**
 * Extract output token count from a raw (unknown) event object.
 * Prefers v2 `tokens.output` (D-OBS-1 additive field); falls back to
 * flat `tokens_out` (v1.4 field on ToolCallEvent).
 * Returns undefined when neither field is present / > 0.
 */
function extractOutputTokens(evt: unknown): number | undefined {
  if (typeof evt !== "object" || evt === null) return undefined;
  const e = evt as Record<string, unknown>;
  // v2 nested tokens object (D-OBS-1 additive field — optional, absence valid)
  if (e["tokens"] !== null && typeof e["tokens"] === "object") {
    const t = e["tokens"] as Record<string, unknown>;
    if (typeof t["output"] === "number" && t["output"] > 0) return t["output"];
  }
  // v1.4 flat field
  if (typeof e["tokens_out"] === "number" && e["tokens_out"] > 0) return e["tokens_out"];
  return undefined;
}

/**
 * Extract tier from v2 additive field (D-OBS-1).
 * Returns "unknown" when the field is absent or not a recognised value —
 * matching the coordinator's "trigger stays silent until threshold exists"
 * contract (D-OBS-3).
 */
function extractTier(evt: unknown): string {
  if (typeof evt !== "object" || evt === null) return "unknown";
  const e = evt as Record<string, unknown>;
  const t = e["tier"];
  if (t === "cheap" || t === "mid" || t === "powerful") return t;
  return "unknown";
}

// ── Core analyzer ──────────────────────────────────────────────────────────────

/**
 * Analyze one or more run directories and derive per-(task_type, tier)
 * p10 output-token thresholds from accumulated trace samples.
 *
 * Returns a PROPOSAL — never writes to settings.json.
 * Buckets with < MIN_SAMPLES (30) are reported in `skippedBuckets` only.
 */
export async function analyzeRuns(opts: AnalyzeRunsOptions): Promise<ThresholdProposal> {
  // Map from "task_type||tier" → output-token sample list
  const bucketMap = new Map<string, number[]>();

  for (const runDir of opts.runDirs) {
    // readAllEvents is the canonical reader (archives → live → lane-fallback)
    const events = await readAllEvents(runDir);

    // Track state while walking events in source order
    let currentPhase = "unknown";
    // lane_id → specialist (set by specialist_dispatch; cleared on phase_start)
    const laneSpecialist = new Map<string, string>();

    for (const evt of events) {
      // Cast to unknown so we can read v2 additive fields that are not in the
      // frozen JsonlEvent interface (lenient reader — D-OBS-1: "absence valid").
      const raw = evt as unknown;

      switch (evt.event) {
        case "phase_start":
          currentPhase = evt.phase;
          // A new phase clears the lane→specialist map so stale lane data
          // from a previous phase does not pollute the new phase's task types.
          laneSpecialist.clear();
          break;

        case "specialist_dispatch": {
          const laneId: string = evt.lane_id ?? "default";
          laneSpecialist.set(laneId, evt.specialist);
          break;
        }

        case "tool_call": {
          const outputTokens = extractOutputTokens(raw);
          if (outputTokens === undefined) break; // not an LLM-call event

          const laneId: string = evt.lane_id ?? "default";
          const specialist: string = laneSpecialist.get(laneId) ?? "unknown";
          // task_type derivation: "{phase}:{specialist}" (D-OBS-3 / brief §4.3)
          const taskType = `${currentPhase}:${specialist}`;
          const tier = extractTier(raw);

          const key = `${taskType}||${tier}`;
          if (!bucketMap.has(key)) bucketMap.set(key, []);
          // Non-null assertion is safe: we just ensured the key exists.
          bucketMap.get(key)!.push(outputTokens);
          break;
        }

        default:
          break;
      }
    }
  }

  // Derive thresholds for buckets that meet the ≥30-sample gate (D-OBS-3)
  const thresholds: Record<string, Record<string, number>> = {};
  const buckets: ThresholdBucket[] = [];
  const skippedBuckets: SkippedBucket[] = [];

  for (const [key, samples] of bucketMap.entries()) {
    const sepIdx = key.indexOf("||");
    const taskType = key.slice(0, sepIdx);
    const tier = key.slice(sepIdx + 2);

    if (samples.length < MIN_SAMPLES) {
      skippedBuckets.push({ taskType, tier, samples: samples.length });
      continue;
    }

    // Sort ascending for p10 calculation
    const sorted = [...samples].sort((a, b) => a - b);
    const threshold = p10(sorted);

    buckets.push({ taskType, tier, samples: samples.length, p10: threshold });

    if (thresholds[taskType] === undefined) {
      thresholds[taskType] = {};
    }
    // TypeScript narrowing: thresholds[taskType] is always defined here
    (thresholds[taskType] as Record<string, number>)[tier] = threshold;
  }

  return { thresholds, buckets, skippedBuckets };
}
