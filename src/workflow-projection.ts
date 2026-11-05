// C8 WorkflowProjection v2 read adapter (U02 / P06 inspector).
//
// Strict, read-only consumer of the frozen v2 schema plus the referential and
// overlay rules of contracts/guild-stack/v2/verify_contracts.py. No plugin
// source import. A document that fails any rule is refused whole; nothing is
// defaulted, so the UI never shows a manufactured value.

import { ProjectReadError, readProjectRunArtifact } from "./project-reader.js";
import type { ProjectRunWorkflowResponse, WorkflowProjectionV2 } from "./workflow-projection-types.js";

export type { ProjectRunWorkflowResponse, WorkflowProjectionV2 } from "./workflow-projection-types.js";

/** Run-relative file the inspector reads. Not yet reserved by the A02 storage contract. */
export const WORKFLOW_PROJECTION_FILE = "workflow-projection.json";
export const WORKFLOW_PROJECTION_MAX_BYTES = 2 * 1024 * 1024;

const SCHEMA_VERSION = "guild.stack.workflow-projection.v2";
const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REL_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\%\x00-\x1f])[^:]+$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** RFC 3339 date-time with real calendar dates (Date.parse rolls 02-30 over). */
export function isRfc3339(v: string): boolean {
  const m = TIME.exec(v);
  if (!m) return false;
  const [y, mo, d, h, mi, sec, oh, om] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && sec <= 59 && oh <= 23 && om <= 59;
}
const KINDS = ["initiative", "run", "execution", "host_session", "goal", "logical_task", "task_attempt", "agent_instance", "request", "operation", "decision", "workflow", "component", "invocation", "obligation", "memory", "knowledge", "candidate", "agent", "skill", "tool", "team", "loop", "config", "evaluation", "report", "benchmark_case", "transfer", "query"];
const CLASSES = ["product", "research", "debug", "ops", "init"];
const EFFECTS = ["read", "write", "review", "gate", "privileged_operation", "release"];
const GATES = ["d5", "qa", "ops", "d8"];
const OB_KINDS = ["security", "adversarial_security", "ui", "ux", "quality", "project_specific"];
const OB_STATUS = ["pending", "accepted", "rejected", "invalidated"];
const INV_STATE = ["active", "blocked", "accepted", "cancelled"];
const AVAIL = ["available", "expired", "redacted", "missing", "unsupported"];
const REQUIRED_GATE_ROLES: Record<string, string[]> = { product: ["d5", "qa", "d8"] };
const RELEASE_GATE_ROLES = ["d5", "qa", "d8"];
const RELEASE_CLASS_GATE_ROLES: Record<string, string[]> = { ops: ["ops"] };
const QA_ASSURANCE_KINDS = ["security", "adversarial_security", "ui", "ux"];
const PATH_PROOF_BUDGET = 10_000;

export type ParseResult = { ok: true; projection: WorkflowProjectionV2 } | { ok: false; issues: string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Checker {
  issues: string[] = [];
  fail(at: string, msg: string): false {
    this.issues.push(`${at}: ${msg}`);
    return false;
  }
  obj(v: unknown, at: string, keys: readonly string[]): v is Obj {
    if (!isObj(v)) return this.fail(at, "must be an object");
    let ok = true;
    for (const k of Object.keys(v)) if (!keys.includes(k)) ok = this.fail(`${at}.${k}`, "unknown field");
    for (const k of keys) if (!(k in v)) ok = this.fail(`${at}.${k}`, "required field missing");
    return ok;
  }
  str(v: unknown, at: string, re?: RegExp, max = 4096): boolean {
    // Schema maxLength counts code points, not UTF-16 units.
    const len = typeof v === "string" ? [...v].length : 0;
    if (typeof v !== "string" || len < 1 || len > max) return this.fail(at, "must be a non-empty string");
    if (re && !re.test(v)) return this.fail(at, "has an invalid format");
    return true;
  }
  oneOf(v: unknown, at: string, allowed: readonly string[], nullable = false): boolean {
    if (nullable && v === null) return true;
    if (typeof v !== "string" || !allowed.includes(v)) return this.fail(at, `must be one of ${allowed.join(", ")}`);
    return true;
  }
  int(v: unknown, at: string, min: number): boolean {
    // Unsafe integers lose precision in JSON.parse; refuse rather than show a rounded value.
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) return this.fail(at, `must be a safe integer >= ${min}`);
    return true;
  }
  arr(v: unknown, at: string, min: number, max: number, each: (x: unknown, at: string) => void, unique = false): boolean {
    if (!Array.isArray(v)) return this.fail(at, "must be an array");
    if (v.length < min || v.length > max) return this.fail(at, `must hold ${min}..${max} items`);
    if (unique && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) this.fail(at, "items must be unique");
    v.forEach((x, i) => each(x, `${at}[${i}]`));
    return true;
  }
}

function checkShape(c: Checker, d: unknown): d is WorkflowProjectionV2 {
  const top = ["schema_version", "workflow", "class", "definition_hash", "compiler_hash", "policy_hash", "expanded_hash", "components", "nodes", "edges", "entry", "protected_gates", "obligations", "invocations"];
  if (!c.obj(d, "projection", top)) return false;
  if (d.schema_version !== SCHEMA_VERSION) c.fail("schema_version", `must be ${SCHEMA_VERSION}`);
  if (c.obj(d.workflow, "workflow", ["source_id", "kind", "id", "revision"])) {
    const w = d.workflow;
    c.str(w.source_id, "workflow.source_id", ID);
    c.oneOf(w.kind, "workflow.kind", KINDS);
    c.str(w.id, "workflow.id", ID);
    c.str(w.revision, "workflow.revision", HASH);
  }
  c.oneOf(d.class, "class", CLASSES);
  for (const k of ["definition_hash", "compiler_hash", "policy_hash", "expanded_hash"]) c.str(d[k], k, HASH);
  c.arr(d.components, "components", 1, 100, (x, at) => {
    if (!c.obj(x, at, ["id", "version", "sha256"])) return;
    c.str(x.id, `${at}.id`, ID);
    c.str(x.version, `${at}.version`);
    c.str(x.sha256, `${at}.sha256`, HASH);
  });
  const port = (x: unknown, at: string) => {
    if (!c.obj(x, at, ["name", "type"])) return;
    c.str(x.name, `${at}.name`, ID);
    c.str(x.type, `${at}.type`);
  };
  c.arr(d.nodes, "nodes", 1, 1000, (x, at) => {
    const keys = ["id", "component_id", "component_hash", "effect", "gate_role", "within_gate", "role", "capabilities", "inputs", "outputs", "required"];
    if (!c.obj(x, at, keys)) return;
    c.str(x.id, `${at}.id`, ID);
    c.str(x.component_id, `${at}.component_id`, ID);
    c.str(x.component_hash, `${at}.component_hash`, HASH);
    c.oneOf(x.effect, `${at}.effect`, EFFECTS);
    c.oneOf(x.gate_role, `${at}.gate_role`, GATES, true);
    c.oneOf(x.within_gate, `${at}.within_gate`, GATES, true);
    c.str(x.role, `${at}.role`, ID);
    c.arr(x.capabilities, `${at}.capabilities`, 0, 50, (y, a) => c.str(y, a, ID), true);
    c.arr(x.inputs, `${at}.inputs`, 0, 50, port);
    c.arr(x.outputs, `${at}.outputs`, 0, 50, port);
    if (typeof x.required !== "boolean") c.fail(`${at}.required`, "must be a boolean");
  });
  c.arr(d.edges, "edges", 0, 5000, (x, at) => {
    if (!c.obj(x, at, ["from", "to", "on"])) return;
    c.str(x.from, `${at}.from`, ID);
    c.str(x.to, `${at}.to`, ID);
    c.str(x.on, `${at}.on`, ID);
  });
  c.str(d.entry, "entry", ID);
  c.arr(d.protected_gates, "protected_gates", 0, 10, (x, at) => c.str(x, at, ID), true);
  const evidence = (x: unknown, at: string) => {
    if (!c.obj(x, at, ["source_id", "path", "sha256", "schema_version", "observed_at", "availability", "reason"])) return;
    c.str(x.source_id, `${at}.source_id`, ID);
    c.str(x.path, `${at}.path`, REL_PATH, 1024);
    c.str(x.sha256, `${at}.sha256`, HASH);
    c.str(x.schema_version, `${at}.schema_version`);
    if (c.str(x.observed_at, `${at}.observed_at`) && !isRfc3339(x.observed_at as string)) c.fail(`${at}.observed_at`, "is not an RFC 3339 date-time");
    c.oneOf(x.availability, `${at}.availability`, AVAIL);
    if (x.reason !== null) c.str(x.reason, `${at}.reason`);
  };
  c.arr(d.obligations, "obligations", 0, 200, (x, at) => {
    if (!c.obj(x, at, ["id", "kind", "node_id", "subject_hash", "invocation_id", "round", "status", "authority", "evidence"])) return;
    c.str(x.id, `${at}.id`, ID);
    c.oneOf(x.kind, `${at}.kind`, OB_KINDS);
    c.str(x.node_id, `${at}.node_id`, ID);
    c.str(x.subject_hash, `${at}.subject_hash`, HASH);
    c.str(x.invocation_id, `${at}.invocation_id`, ID);
    c.int(x.round, `${at}.round`, 1);
    c.oneOf(x.status, `${at}.status`, OB_STATUS);
    c.str(x.authority, `${at}.authority`, ID);
    c.arr(x.evidence, `${at}.evidence`, 0, 50, evidence);
  });
  c.arr(d.invocations, "invocations", 0, 100, (x, at) => {
    if (!c.obj(x, at, ["id", "node_id", "round", "max_rounds", "unresolved_questions", "state", "definition_hash", "subject_hash"])) return;
    c.str(x.id, `${at}.id`, ID);
    c.str(x.node_id, `${at}.node_id`, ID);
    c.int(x.round, `${at}.round`, 0);
    c.int(x.max_rounds, `${at}.max_rounds`, 1);
    c.arr(x.unresolved_questions, `${at}.unresolved_questions`, 0, 100, (y, a) => c.str(y, a, ID));
    c.oneOf(x.state, `${at}.state`, INV_STATE);
    c.str(x.definition_hash, `${at}.definition_hash`, HASH);
    c.str(x.subject_hash, `${at}.subject_hash`, HASH);
  });
  return c.issues.length === 0;
}

/** Semantic rules mirrored from verify_contracts.py (workflow-projection). */
function checkRules(c: Checker, p: WorkflowProjectionV2): void {
  const rule = (ok: boolean, at: string, msg: string) => (ok ? true : c.fail(at, msg));
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  rule(nodes.size === p.nodes.length, "nodes", "duplicate expanded node");
  rule(nodes.has(p.entry), "entry", "unknown graph entry");
  rule(p.edges.every((e) => nodes.has(e.from) && nodes.has(e.to)), "edges", "unknown expanded edge endpoint");
  const gates = new Set(p.protected_gates);
  rule([...gates].every((g) => nodes.has(g)), "protected_gates", "unknown protected gate");
  const roles = new Map<string, string>();
  for (const n of p.nodes) {
    if (n.gate_role === null) continue;
    rule(n.effect === "gate", `nodes.${n.id}`, "gate role requires gate effect");
    rule(gates.has(n.id), `nodes.${n.id}`, "gate-role node must be protected");
    rule(!roles.has(n.gate_role), `nodes.${n.id}`, "duplicate gate role");
    roles.set(n.gate_role, n.id);
  }
  const known = [...gates].filter((g) => nodes.has(g)).map((g) => nodes.get(g)!);
  rule(known.every((n) => n.effect === "gate" && n.gate_role !== null), "protected_gates", "protected gate must be a gate-effect node with a semantic gate role");
  rule(known.every((n) => n.required) && p.nodes.every((n) => n.gate_role === null || n.required), "protected_gates", "protected gate cannot be made skippable");
  rule((REQUIRED_GATE_ROLES[p.class] ?? []).every((r) => roles.has(r)), "class", `${p.class} required gate roles missing`);
  if (p.nodes.some((n) => n.effect === "release")) {
    const need = [...RELEASE_GATE_ROLES, ...(RELEASE_CLASS_GATE_ROLES[p.class] ?? [])];
    rule(need.every((r) => roles.has(r)), "nodes", "release effect requires non-waivable protected gate roles in every class");
  }
  for (const n of p.nodes) {
    if (n.within_gate === null) continue;
    rule(n.gate_role === null && roles.has(n.within_gate), `nodes.${n.id}`, "nested gate scope must name an existing protected gate role");
    rule(!["release", "privileged_operation", "gate"].includes(n.effect), `nodes.${n.id}`, "nested gate scope cannot hold release, privileged or gate effects");
  }
  const inQa = (id: string) => {
    const n = nodes.get(id);
    return n !== undefined && (n.gate_role === "qa" || n.within_gate === "qa");
  };
  // Every path from entry to a release node must pass every protected gate.
  const out = new Map<string, string[]>();
  for (const e of p.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const pending: Array<[string, string[]]> = [[p.entry, []]];
  const seen = new Set<string>();
  let bypass = false;
  while (pending.length > 0 && seen.size <= PATH_PROOF_BUDGET) {
    const [id, before] = pending.pop()!;
    const node = nodes.get(id);
    if (!node) continue;
    const passed = gates.has(id) && !before.includes(id) ? [...before, id].sort() : before;
    const key = `${id}\u0000${passed.join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (node.effect === "release" && ![...gates].every((g) => passed.includes(g))) bypass = true;
    for (const to of out.get(id) ?? []) pending.push([to, passed]);
  }
  rule(!bypass, "edges", "release path bypasses protected gate");
  rule(seen.size <= PATH_PROOF_BUDGET, "edges", "path proof budget exceeded");
  const invs = new Map(p.invocations.map((i) => [i.id, i]));
  rule(invs.size === p.invocations.length, "invocations", "duplicate invocation");
  p.invocations.forEach((inv, i) => {
    const at = `invocations[${i}]`;
    rule(inv.round <= inv.max_rounds, at, "round exceeds bound");
    rule(inv.state !== "accepted" || inv.unresolved_questions.length === 0, at, "accepted invocation cannot hold unresolved questions");
    rule(inv.definition_hash === p.definition_hash, at, "invocation definition changed");
    rule(nodes.has(inv.node_id), at, "invocation references unknown node");
  });
  rule(new Set(p.obligations.map((o) => o.id)).size === p.obligations.length, "obligations", "duplicate obligation");
  p.obligations.forEach((ob, i) => {
    const at = `obligations[${i}]`;
    const inv = invs.get(ob.invocation_id);
    rule(nodes.has(ob.node_id), at, "obligation references unknown node");
    rule(inv !== undefined, at, "obligation references unknown invocation");
    if (QA_ASSURANCE_KINDS.includes(ob.kind)) {
      rule(inQa(ob.node_id) && (inv === undefined || inQa(inv.node_id)), at, "assurance must execute inside the semantic QA gate scope");
    }
    if (inv) {
      rule(inv.node_id === ob.node_id, at, "obligation/invocation node mismatch");
      rule(ob.subject_hash === inv.subject_hash, at, "obligation subject differs from invocation subject");
      rule(ob.round <= inv.round, at, "obligation round beyond invocation round");
    }
    if (ob.status === "accepted") {
      rule(inv !== undefined && inv.state === "accepted" && ob.round === inv.round, at, "accepted obligation needs an accepted invocation at the same round");
      rule(ob.evidence.length > 0 && ob.evidence.every((e) => e.availability === "available" && e.source_id === p.workflow.source_id), at, "accepted obligation needs available workflow-owner evidence");
    }
  });
}

export function parseWorkflowProjectionV2(value: unknown): ParseResult {
  const c = new Checker();
  if (!checkShape(c, value)) return { ok: false, issues: c.issues };
  checkRules(c, value);
  return c.issues.length === 0 ? { ok: true, projection: value } : { ok: false, issues: c.issues };
}

/** Read and validate `<run>/workflow-projection.json`. Unknown run throws ProjectReadError(not_found). */
export async function readProjectRunWorkflow(
  projectRoot: string,
  runId: string,
  guildName?: string,
): Promise<ProjectRunWorkflowResponse> {
  let body: Buffer;
  try {
    ({ body } = await readProjectRunArtifact(projectRoot, runId, [WORKFLOW_PROJECTION_FILE], guildName, WORKFLOW_PROJECTION_MAX_BYTES));
  } catch (err) {
    if (!(err instanceof ProjectReadError)) throw err;
    if (err.message === "artifact not found") {
      return { status: "unavailable", run_id: runId, reason: `no ${WORKFLOW_PROJECTION_FILE} recorded for this run` };
    }
    if (err.message === "artifact too large") {
      return { status: "refused", run_id: runId, issues: [`${WORKFLOW_PROJECTION_FILE}: larger than ${WORKFLOW_PROJECTION_MAX_BYTES} bytes`] };
    }
    if (err.message.startsWith("artifact path")) {
      return { status: "refused", run_id: runId, issues: [`${WORKFLOW_PROJECTION_FILE}: not a contained regular file`] };
    }
    throw err;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: "refused", run_id: runId, issues: [`${WORKFLOW_PROJECTION_FILE}: not valid JSON`] };
  }
  const parsed = parseWorkflowProjectionV2(doc);
  return parsed.ok
    ? { status: "available", run_id: runId, projection: parsed.projection }
    : { status: "refused", run_id: runId, issues: parsed.issues.slice(0, 50) };
}
