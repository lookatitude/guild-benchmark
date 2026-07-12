// benchmark/src/run-events-schema.ts
//
// Type-only mirror of the Guild plugin's emitted v1.4 JSONL run-event format.
//
// THE CONTRACT IS THE ON-DISK ARTIFACT, NOT A SHARED CODE IMPORT.
// The plugin RECORDS every run to `<run>/logs/v1.4-events.jsonl`; the benchmark
// engine IMPORTS + analyzes those artifacts by FORMAT. Neither repo imports the
// other (see decisions/telemetry-split-plugin-records-benchmark-analyzes.md).
// This file is the benchmark's named schema surface for the recorded format and
// must track the plugin's canonical recorder
// (plugin/hooks/lib/v1.4/log-jsonl.ts — the Wave-4 recorder carrying the
// guild.trace_event.v2 additive fields). The plugin does NOT import this file.
//
// Per the execution plan §2 sub-decision the benchmark keeps a vendored copy of
// the recorder for its synthetic harness (option B). To keep ONE in-repo
// definition of the event schema, the interfaces are re-exported from that
// vendored copy (`./log-jsonl.js`) rather than duplicated. If the harness later
// shells out to the plugin and stops recording locally (option A), inline the
// interfaces here verbatim and delete the vendored recorder.

export type {
  Phase,
  LoopLayer,
  ToolCallTool,
  HookEventName,
  PhaseStartEvent,
  PhaseEndEvent,
  SpecialistDispatchEvent,
  SpecialistReceiptEvent,
  LoopRoundStartEvent,
  LoopRoundEndEvent,
  ToolCallEvent,
  HookEvent,
  GateDecisionEvent,
  AssumptionLoggedEvent,
  EscalationEvent,
  CodexReviewRoundEvent,
  JsonlEvent,
} from "./log-jsonl.js";

export {
  TOOL_CALL_TOOL_VALUES,
  HOOK_EVENT_NAMES,
  EVENT_TYPES,
} from "./log-jsonl.js";
