// c9/trace-read.ts — read path of the plugin's T01 trace capture
// (`guild.trace.analysis.v3` trace.jsonl + capture manifest + payload sidecars),
// ported without the capture/write side and without plugin imports. Read-only.

import * as crypto from "node:crypto";
import { readContainedText } from "./contained-read.js";
import { cpLength, validateTraceAnalysisV3, type TraceAnalysisV3, type TraceCoverage } from "./trace-analysis.js";

export const TRACE_CAPTURE_MANIFEST_SCHEMA = "guild.trace.capture_manifest.v1" as const;

export interface TraceCaptureManifest {
  schema_version: typeof TRACE_CAPTURE_MANIFEST_SCHEMA;
  source_id: string; run_id: string;
  /** Informational counters. Coverage is derived from the durable trace, not from these. */
  events_written: number;
  duplicates: number;
  losses: Record<string, number>;
  upstream_drop_unknown: boolean;
}

const sha = (s: string | Uint8Array) => crypto.createHash("sha256").update(s).digest("hex");
const revision = (s: string) => `sha256:${sha(s)}`;
const isBoundedStr = (v: unknown): v is string => typeof v === "string" && cpLength(v) >= 1 && cpLength(v) <= 4096;
const readContained = readContainedText;

function guildRel(runId: string, ...parts: string[]): string {
  return ["runs", runId, ...parts].join("/");
}
const TRACE_FILE = "trace.jsonl";
const MANIFEST_FILE = "trace-capture-manifest.json";

function emptyManifest(authority: { source_id: string; run_id: string }): TraceCaptureManifest {
  return {
    schema_version: TRACE_CAPTURE_MANIFEST_SCHEMA, source_id: authority.source_id, run_id: authority.run_id,
    events_written: 0, duplicates: 0, losses: {}, upstream_drop_unknown: false,
  };
}

function readManifest(root: string, runId: string, sourceId: string): TraceCaptureManifest {
  const raw = readContained(root, guildRel(runId, MANIFEST_FILE));
  if (raw === null) return emptyManifest({ source_id: sourceId, run_id: runId });
  const m = JSON.parse(raw) as TraceCaptureManifest;
  if (m.schema_version !== TRACE_CAPTURE_MANIFEST_SCHEMA || m.run_id !== runId) throw new Error("capture manifest belongs to another run");
  return m;
}

/**
 * Trace-level coverage derived from the durable trace. Each observation event is
 * eligible and covered only when its capture is complete and its payload is still
 * retained intact; each loss event adds its own eligible count (null = unknown).
 * Losses with no event (cap reached, torn appends, unreadable lines) add from the
 * manifest and from what this read saw.
 */
export function traceCoverageOf(events: readonly TraceAnalysisV3[], m: TraceCaptureManifest, seen: { torn_tail: boolean; invalid_lines: number }): TraceCoverage {
  // `unrecorded` counts losses no trace event could carry (cap reached).
  let eligible: number | null = m.upstream_drop_unknown ? null : (m.losses["unrecorded"] ?? 0) + (m.losses["torn_tail"] ?? 0) + (seen.torn_tail ? 1 : 0) + seen.invalid_lines;
  let covered = 0;
  const lost = new Map<string, number>();
  const note = (k: string, n = 1) => lost.set(k, (lost.get(k) ?? 0) + n);
  for (const k of ["unrecorded", "torn_tail"]) if (m.losses[k]) note(k, m.losses[k]!);
  if (seen.torn_tail) note("torn_tail_unrecovered");
  if (seen.invalid_lines) note("invalid_lines", seen.invalid_lines);
  for (const e of events) {
    if (e.event_class === "loss") {
      const n = e.capture.eligible;
      eligible = eligible === null || n === null ? null : eligible + n;
      if (n !== 0) note(n === null ? "loss_unknown_size" : "loss_events", n ?? 1);
      continue;
    }
    if (eligible !== null) eligible += 1;
    const payloadOk = e.payload_ref === null || e.payload_ref.availability === "available" || e.payload_ref.availability === "redacted";
    if (e.capture.state === "complete" && payloadOk) covered++;
    else note(payloadOk ? "capture_incomplete" : `payload_${e.payload_ref!.availability}`);
  }
  const missing = eligible === null ? null : eligible - covered;
  const complete = eligible !== null && missing === 0;
  const summary = [...lost.entries()].map(([k, n]) => `${k}=${n}`).sort().join(",");
  return {
    eligible, covered, excluded: m.duplicates, missing,
    state: complete ? "complete" : covered === 0 && (eligible === null || eligible > 0) ? "unavailable" : "partial",
    reason: complete ? null : eligible === null ? `unknown loss size; ${summary}` : `losses: ${summary}`,
    exclusion_reasons: m.duplicates > 0 ? [{ code: "duplicate_replay", count: m.duplicates }] : [],
  };
}

export interface TraceRead {
  events: TraceAnalysisV3[];
  invalid_lines: number;
  manifest: TraceCaptureManifest;
  coverage: TraceCoverage;
}

/** Read the trace with each payload's current availability resolved (expired, missing or tampered). */
export function readTrace(root: string, runId: string): TraceRead {
  const raw = readContained(root, guildRel(runId, TRACE_FILE)) ?? "";
  const torn_tail = raw.length > 0 && !raw.endsWith("\n");
  const complete = torn_tail ? raw.slice(0, raw.lastIndexOf("\n") + 1) : raw;
  const events: TraceAnalysisV3[] = [];
  let invalid_lines = 0;
  for (const line of complete.split("\n")) {
    if (!line) continue;
    let e: TraceAnalysisV3;
    try { e = JSON.parse(line) as TraceAnalysisV3; } catch { invalid_lines++; continue; }
    if (!validateTraceAnalysisV3(e).ok || e.lineage.run_id !== runId) { invalid_lines++; continue; }
    if (e.payload_ref) {
      const ref = e.payload_ref;
      const tomb = readContained(root, ref.path.replace(/\.json$/, ".expired.json"));
      // An unreadable sidecar is a missing payload (not covered), as in the plugin.
      const bytes = readContained(root, ref.path, "null");
      if (tomb !== null) {
        const t = JSON.parse(tomb) as { sha256?: string; reason?: string };
        e.payload_ref = { ...ref, availability: "expired", reason: t.sha256 === ref.sha256 && isBoundedStr(t.reason) ? t.reason : "sidecar expired" };
      } else if (bytes === null) e.payload_ref = { ...ref, availability: "missing", reason: "sidecar absent" };
      else if (revision(bytes) !== ref.sha256) e.payload_ref = { ...ref, availability: "missing", reason: "sidecar bytes do not match the recorded hash" };
    }
    events.push(e);
  }
  const sourceId = events[0]?.lineage.source_id ?? "unknown";
  const manifest = readManifest(root, runId, sourceId);
  if (raw === "" && readContained(root, guildRel(runId, MANIFEST_FILE)) === null) {
    // No capture has run: that is unknown coverage, not an empty complete one.
    return { events, invalid_lines, manifest, coverage: { eligible: null, covered: 0, excluded: 0, missing: null, state: "unavailable", reason: "no capture recorded for this run", exclusion_reasons: [] } };
  }
  return { events, invalid_lines, manifest, coverage: traceCoverageOf(events, manifest, { torn_tail, invalid_lines }) };
}

