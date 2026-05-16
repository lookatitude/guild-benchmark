import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  liveLogPath,
  readAllEvents,
  type JsonlEvent,
} from "./log-jsonl.js";
import type {
  EventLine,
  ReceiptSummary,
  RunJson,
  RunRecord,
} from "./types.js";

const runJsonSchema = z.object({
  schema_version: z.number().int().positive(),
  run_id: z.string().min(1),
  case_slug: z.string().min(1),
  plugin_ref: z.string().min(1),
  model_ref: z.record(z.string(), z.string()),
  started_at: z.string().min(1),
  completed_at: z.string().min(1),
  status: z.enum(["pass", "fail", "timeout", "errored"]),
  raw_command: z.string().optional(),
  wall_clock_ms: z.number().int().nonnegative().optional(),
  wall_clock_budget_ms: z.number().int().positive().optional(),
  // P4 — operator-supplied SHA-256 hex hash. Optional. M9 enforces the
  // ^[a-f0-9]{64}$ shape at runner write time; the schema here only
  // pins string-shape so legacy / partial fixtures still validate.
  // v1.3 — F4: pinned in schema so parseRunJson preserves the field
  // through to GET /api/runs (zod's default `.strip` previously dropped it).
  auth_identity_hash: z.string().optional(),
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({ ts: z.string(), type: z.literal("stage_started"), stage: z.string() }),
  z.object({
    ts: z.string(),
    type: z.literal("stage_completed"),
    stage: z.string(),
    duration_ms: z.number().int().nonnegative(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("specialist_dispatched"),
    specialist: z.string(),
    task_id: z.string(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("specialist_completed"),
    specialist: z.string(),
    task_id: z.string(),
    status: z.enum(["complete", "blocked", "errored"]),
  }),
  z.object({ ts: z.string(), type: z.literal("gate_passed"), gate: z.string() }),
  z.object({
    ts: z.string(),
    type: z.literal("gate_skipped"),
    gate: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("tool_error"),
    tool: z.string(),
    exit_code: z.number().int(),
  }),
  z.object({
    ts: z.string(),
    type: z.literal("acceptance_command"),
    command: z.string(),
    exit_code: z.number().int(),
  }),
  z.object({ ts: z.string(), type: z.literal("retry"), what: z.string() }),
]);

export interface ImportFromFixtureOpts {
  fixturePath: string;
  runsDir: string;
  runId?: string;
}

export interface ImportResult {
  runDir: string;
  runId: string;
  partial: boolean;
  missing_artifacts: string[];
}

export interface ImportAuditRunOpts {
  sourceRunDir: string;
  runsDir: string;
  runId?: string;
}

export interface ImportAuditRunResult {
  runDir: string;
  runId: string;
  sourceRunId: string;
  sourceRunDir: string;
}

export interface LoadedRunEvents {
  events: EventLine[];
  v14_events: JsonlEvent[];
  hasEventArtifact: boolean;
  source: "v1.3" | "v1.4" | "none";
}

const SAFE_IMPORT_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Imports a fixture-shaped tree under `fixturePath` into `<runsDir>/<run-id>/`.
// Fixture layout (also the on-disk shape produced by the P3 runner):
//   <fixturePath>/run.json            — required, validated against runJsonSchema
//   <fixturePath>/events.ndjson       — optional; absence sets partial=true
//   <fixturePath>/.guild/             — optional; copied verbatim to artifacts/.guild/
export async function importFixture(opts: ImportFromFixtureOpts): Promise<ImportResult> {
  const fixtureAbs = resolve(opts.fixturePath);
  if (!existsSync(fixtureAbs)) {
    throw new Error(`Fixture path does not exist: ${fixtureAbs}`);
  }
  const fixtureRunPath = join(fixtureAbs, "run.json");
  if (!existsSync(fixtureRunPath)) {
    throw new Error(`Fixture missing run.json at ${fixtureRunPath}`);
  }
  const runJson = parseRunJson(await readFile(fixtureRunPath, "utf8"));
  const runId = opts.runId ?? runJson.run_id;
  const runDir = resolve(opts.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const updatedRun: RunJson = { ...runJson, run_id: runId };
  await writeFile(join(runDir, "run.json"), JSON.stringify(updatedRun, null, 2) + "\n");

  const missing: string[] = [];
  const eventsSource = join(fixtureAbs, "events.ndjson");
  if (existsSync(eventsSource)) {
    await copyFile(eventsSource, join(runDir, "events.ndjson"));
  } else {
    missing.push("events.ndjson");
  }

  const guildSource = join(fixtureAbs, ".guild");
  const artifactsDir = join(runDir, "artifacts", ".guild");
  if (existsSync(guildSource)) {
    await mkdir(artifactsDir, { recursive: true });
    await cp(guildSource, artifactsDir, { recursive: true });
  } else {
    missing.push("artifacts/.guild");
  }

  return { runDir, runId, partial: missing.length > 0, missing_artifacts: missing };
}

export async function importAuditRun(
  opts: ImportAuditRunOpts,
): Promise<ImportAuditRunResult> {
  const sourceRunDir = resolve(opts.sourceRunDir);
  await validateAuditRunSource(sourceRunDir);
  const sourceRunId = basename(sourceRunDir);
  const runId = opts.runId ?? `audit-${sourceRunId}`;
  if (!isSafeImportRunId(runId)) {
    throw new Error("run_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  const runDir = resolve(opts.runsDir, runId);
  if (existsSync(runDir)) {
    throw new Error(`run already exists: ${runId}`);
  }

  const events = await readAllEvents(sourceRunDir);
  if (events.length === 0) {
    throw new Error(`no v1.4 events found at ${sourceRunDir}`);
  }
  await mkdir(runDir, { recursive: true });
  const ts = events.map((e) => e.ts).filter((value) => value.length > 0).sort();
  const startedAt = ts[0] ?? new Date().toISOString();
  const completedAt = ts[ts.length - 1] ?? startedAt;
  const run: RunJson = {
    schema_version: 1,
    run_id: runId,
    case_slug: "plugin-audit-log",
    plugin_ref: "local-audit",
    model_ref: { default: "unknown" },
    started_at: startedAt,
    completed_at: completedAt,
    status: deriveAuditStatus(events),
  };
  await writeFile(join(runDir, "run.json"), JSON.stringify(run, null, 2) + "\n");

  const importedRunDir = join(runDir, "artifacts", ".guild", "runs", sourceRunId);
  await mkdir(dirname(importedRunDir), { recursive: true });
  await cp(sourceRunDir, importedRunDir, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  return { runDir, runId, sourceRunId, sourceRunDir };
}

export async function loadRunRecord(runDir: string): Promise<RunRecord> {
  const abs = resolve(runDir);
  const runPath = join(abs, "run.json");
  if (!existsSync(runPath)) {
    throw new Error(`run.json not found at ${runPath}`);
  }
  const run = parseRunJson(await readFile(runPath, "utf8"));

  const artifactsRoot = join(abs, "artifacts", ".guild");
  const missing: string[] = [];
  const loadedEvents = await loadRunEvents(abs);
  if (!loadedEvents.hasEventArtifact) {
    missing.push("events.ndjson");
  }

  if (!existsSync(artifactsRoot)) {
    missing.push("artifacts/.guild");
  }

  const receipts = existsSync(artifactsRoot) ? await collectReceipts(artifactsRoot) : [];
  const hasReview = await hasArtifact(artifactsRoot, "review");
  const hasAssumptions = await hasArtifact(artifactsRoot, "assumptions");
  const hasReflection = await hasArtifact(artifactsRoot, "reflect");

  return {
    run,
    events: loadedEvents.events,
    v14_events: loadedEvents.v14_events,
    runDir: abs,
    artifactsRoot,
    receipts,
    hasReview,
    hasAssumptions,
    hasReflection,
    partial: missing.length > 0,
    missing_artifacts: missing,
  };
}

export async function loadRunEvents(runDir: string): Promise<LoadedRunEvents> {
  const abs = resolve(runDir);
  const eventsPath = join(abs, "events.ndjson");
  const v14_events = await loadV14Events(abs);
  if (existsSync(eventsPath)) {
    return {
      events: parseEventsNdjson(await readFile(eventsPath, "utf8")),
      v14_events,
      hasEventArtifact: true,
      source: "v1.3",
    };
  }
  if (v14_events.length > 0 || hasV14EventArtifact(abs)) {
    return {
      events: mapV14EventsToEventLines(v14_events),
      v14_events,
      hasEventArtifact: true,
      source: "v1.4",
    };
  }
  return { events: [], v14_events: [], hasEventArtifact: false, source: "none" };
}

export function parseRunJson(raw: string): RunJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`run.json is not valid JSON: ${(err as Error).message}`);
  }
  const validated = runJsonSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`run.json failed schema validation:\n${issues}`);
  }
  return validated.data;
}

export function parseEventsNdjson(raw: string): EventLine[] {
  const out: EventLine[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `events.ndjson line ${i + 1} is not valid JSON: ${(err as Error).message}`,
      );
    }
    const validated = eventSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((iss) => `  - ${iss.path.join(".") || "<root>"}: ${iss.message}`)
        .join("\n");
      throw new Error(`events.ndjson line ${i + 1} failed schema:\n${issues}`);
    }
    out.push(validated.data);
  }
  return out;
}

export function mapV14EventsToEventLines(events: JsonlEvent[]): EventLine[] {
  const out: EventLine[] = [];
  for (const e of events) {
    switch (e.event) {
      case "phase_start":
        out.push({ ts: e.ts, type: "stage_started", stage: phaseToStage(e.phase) });
        break;
      case "phase_end":
        out.push({
          ts: e.ts,
          type: "stage_completed",
          stage: phaseToStage(e.phase),
          duration_ms: e.duration_ms,
        });
        if (e.status === "ok") {
          out.push({ ts: e.ts, type: "gate_passed", gate: phaseToStage(e.phase) });
        } else {
          out.push({
            ts: e.ts,
            type: "gate_skipped",
            gate: phaseToStage(e.phase),
            reason: e.status,
          });
        }
        break;
      case "specialist_dispatch":
        out.push({
          ts: e.ts,
          type: "specialist_dispatched",
          specialist: e.specialist,
          task_id: e.task_id,
        });
        break;
      case "specialist_receipt":
        out.push({
          ts: e.ts,
          type: "specialist_completed",
          specialist: e.specialist,
          task_id: e.task_id,
          status: "complete",
        });
        break;
      case "gate_decision": {
        const gate = gateDecisionToStage(e.gate);
        if (gate !== undefined) {
          out.push({
            ts: e.ts,
            type: e.decision === "approved" ? "gate_passed" : "gate_skipped",
            gate,
            ...(e.decision === "approved" ? {} : { reason: e.decision }),
          });
        }
        break;
      }
      case "tool_call":
        if (e.status === "err") {
          out.push({ ts: e.ts, type: "tool_error", tool: e.tool, exit_code: 1 });
        }
        break;
      case "escalation":
        out.push({ ts: e.ts, type: "retry", what: e.reason });
        break;
      default:
        break;
    }
  }
  return out;
}

async function loadV14Events(runDir: string): Promise<JsonlEvent[]> {
  const candidates = await findV14RunDirs(runDir);
  for (const candidate of candidates) {
    const events = await readAllEvents(candidate);
    if (events.length > 0 || hasV14EventArtifact(candidate)) {
      return events;
    }
  }
  return [];
}

async function findV14RunDirs(runDir: string): Promise<string[]> {
  const out = [runDir];
  const capturedRuns = join(runDir, "artifacts", ".guild", "runs");
  if (!existsSync(capturedRuns)) return out;
  const entries = await readdir(capturedRuns, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) out.push(join(capturedRuns, entry.name));
  }
  return out;
}

function hasV14EventArtifact(runDir: string): boolean {
  return existsSync(liveLogPath(runDir));
}

async function validateAuditRunSource(sourceRunDir: string): Promise<void> {
  const sourceStat = await stat(sourceRunDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`audit run directory not found: ${sourceRunDir}`);
  }
  const sourceRunId = basename(sourceRunDir);
  if (!isSafeImportRunId(sourceRunId)) {
    throw new Error("source run id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
  }
  if (basename(dirname(sourceRunDir)) !== "runs" || basename(dirname(dirname(sourceRunDir))) !== ".guild") {
    throw new Error("run_dir must point to a .guild/runs/<run-id> directory");
  }
}

function isSafeImportRunId(runId: string): boolean {
  return SAFE_IMPORT_RUN_ID_RE.test(runId) && runId !== "." && runId !== "..";
}

function deriveAuditStatus(events: JsonlEvent[]): RunJson["status"] {
  if (events.some((e) => e.event === "loop_round_end" && e.terminated === "error")) {
    return "errored";
  }
  if (
    events.some(
      (e) =>
        (e.event === "tool_call" && e.status === "err") ||
        (e.event === "phase_end" && e.status === "error"),
    )
  ) {
    return "fail";
  }
  return "pass";
}

function phaseToStage(phase: string): string {
  // v1.4 uses `team-compose`; the v1.3 scoring/UI contract calls that stage `team`.
  return phase === "team-compose" ? "team" : phase;
}

function gateDecisionToStage(gate: string): string | undefined {
  if (gate === "gate-1-spec") return "brainstorm";
  if (gate === "gate-2-team") return "team";
  if (gate === "gate-3-plan") return "plan";
  if (gate.startsWith("mid-execution-decision:")) return "execute";
  return undefined;
}

async function collectReceipts(artifactsRoot: string): Promise<ReceiptSummary[]> {
  const summaries: ReceiptSummary[] = [];
  const runsDir = join(artifactsRoot, "runs");
  if (!existsSync(runsDir)) return summaries;
  const innerRuns = await readdir(runsDir, { withFileTypes: true });
  for (const entry of innerRuns) {
    if (!entry.isDirectory()) continue;
    const handoffsDir = join(runsDir, entry.name, "handoffs");
    if (!existsSync(handoffsDir)) continue;
    const files = await readdir(handoffsDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const filePath = join(handoffsDir, f);
      const content = await readFile(filePath, "utf8");
      summaries.push(summariseReceipt(filePath, content));
    }
  }
  return summaries;
}

function summariseReceipt(filePath: string, content: string): ReceiptSummary {
  const taskMatch = content.match(/^task_id:\s*(.+)$/m);
  const specialistMatch = content.match(/^specialist:\s*(.+)$/m);
  const statusMatch = content.match(/^status:\s*(.+)$/m);
  const evidenceMatch = content.match(/##\s*Evidence([\s\S]*?)(?=\n##\s|$)/i);
  const evidenceText = evidenceMatch ? evidenceMatch[1].trim() : "";
  const evidence_chars = evidenceText.length;
  const evidence_present = evidence_chars >= 40;
  const taskId = (taskMatch ? taskMatch[1] : basename(filePath, ".md")).trim();
  return {
    task_id: taskId,
    specialist: (specialistMatch ? specialistMatch[1] : "unknown").trim(),
    status: (statusMatch ? statusMatch[1] : "unknown").trim(),
    evidence_present,
    evidence_chars,
  };
}

async function hasArtifact(
  artifactsRoot: string,
  kind: "review" | "assumptions" | "reflect",
): Promise<boolean> {
  if (!existsSync(artifactsRoot)) return false;
  const runsDir = join(artifactsRoot, "runs");
  if (!existsSync(runsDir)) return false;
  const inner = await readdir(runsDir, { withFileTypes: true });
  for (const entry of inner) {
    if (!entry.isDirectory()) continue;
    const candidates = [
      join(runsDir, entry.name, `${kind}.md`),
      ...(kind === "reflect" ? [join(runsDir, entry.name, "reflection.md")] : []),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        const content = await readFile(c, "utf8");
        if (content.trim().length > 0) return true;
      }
    }
  }
  return false;
}
