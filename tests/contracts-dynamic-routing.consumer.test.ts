/**
 * tests/contracts-dynamic-routing.consumer.test.ts
 *
 * Versioned CONSUMER checks over the dynamic-host-model-routing contract
 * fixtures (fixtures/contracts/dynamic-host-model-routing/v1/). Lane
 * T2-tdd-contract-fixtures of the umbrella run
 * run-20260730-131020-dynamic-host-model-routing.
 *
 * INDEPENDENCE RULE (module-map §5): this repo consumes versioned fixture
 * COPIES only — no `import ... from '../plugin/...'` anywhere. Validators are
 * implemented locally from the frozen contract texts.
 *
 * One test is FAILING BY DESIGN today: the plugin build does not yet publish
 * checksummed fixture copies (manifest.published_by_plugin_build=false).
 * Every other test PASSES and pins the contract shapes, including anti-vacuity
 * checks that each *invalid* fixture is rejected by the local validators.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "contracts", "dynamic-host-model-routing", "v1");

function fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

// ── Local validators (from the FROZEN contract texts — no plugin imports) ────

const SURFACES = ["cli", "app", "web", "api", "connector", "file", "unknown"];
const FAMILIES = ["claude", "codex", "agents", "pi", "antigravity", "unknown"];
const EVIDENCE_STATES = ["available", "advertised", "unknown", "unavailable"];
const SELECTOR_RE = /^(id:.+|alias:.+|expr:[a-z_]+=[^;=]+(;[a-z_]+=[^;=]+)*)$/;

function validateSessionContext(sc: any): string[] {
  const errors: string[] = [];
  if (sc.schema_version !== "guild.session_context.v1") errors.push("schema_version");
  if (!FAMILIES.includes(sc.host?.family)) errors.push("host.family not in closed enum");
  if (!SURFACES.includes(sc.host?.surface)) errors.push("host.surface not exactly one closed value");
  if (!["asserted", "verified"].includes(sc.identity?.trust)) errors.push("identity.trust");
  // §3 unknown-safety: an unrecognized-input record that still claims claude
  // is the retired repair behavior — reject it.
  if (/unrecognized|defaulted/.test(sc.identity?.evidence ?? "") && sc.host?.family === "claude") {
    errors.push("unknown-safe violation: unrecognized input repaired to claude");
  }
  if (!sc.run_binding?.binding_ref) errors.push("run_binding.binding_ref required");
  return errors;
}

function validateCatalog(cat: any): string[] {
  const errors: string[] = [];
  if (cat.schema_version !== "guild.model_catalog.v1") errors.push("schema_version");
  for (const k of ["target_id", "family", "surface", "provider_kind", "auth_mode", "account_fingerprint", "endpoint_fingerprint", "org_fingerprint", "tool_version", "adapter_id", "adapter_version"]) {
    if (typeof cat.target?.[k] !== "string" || cat.target[k].length === 0) errors.push(`target.${k} required`);
  }
  for (const [i, m] of (cat.models ?? []).entries()) {
    if (!EVIDENCE_STATES.includes(m.evidence?.state)) errors.push(`models[${i}].evidence.state outside closed enum`);
    if (!Number.isInteger(m.catalog_index)) errors.push(`models[${i}].catalog_index required`);
    // §4: static/hint discovery can ground at most `advertised`.
    if (cat.discovery?.method === "static_hint" && m.evidence?.state === "available") {
      errors.push(`models[${i}] static hint grounded 'available' (max advertised)`);
    }
  }
  return errors;
}

function validatePolicy(doc: any): string[] {
  const errors: string[] = [];
  const policy = doc.model_policy;
  if (policy?.version !== 2) errors.push("version");
  const REVIEW = ["advisory", "adversarial", "security", "adversarial-security"];
  for (const [purpose, p] of Object.entries<any>(policy?.purposes ?? {})) {
    if (purpose === "research") {
      if (p.min_effective_complexity !== "hard") errors.push("research floor below hard");
    }
    for (const r of p.routes ?? []) {
      for (const sel of [...(r.preferred ?? []), ...(r.fallbacks ?? [])]) {
        if (!SELECTOR_RE.test(sel.selector ?? "")) errors.push(`malformed selector: ${sel.selector}`);
      }
      if (r.condition && r.condition.kind !== "always" && !REVIEW.includes(purpose)) {
        errors.push("non-always condition on non-review purpose");
      }
      if (r.provider_default === "allow_last_resort" && (purpose === "research" || REVIEW.includes(purpose))) {
        errors.push("provider_default allow_last_resort on research/review purpose");
      }
      if (purpose === "research" && r.complexity !== "hard") errors.push("research route below hard");
    }
  }
  return errors;
}

function validateFinalizedReceipt(r: any): string[] {
  const errors: string[] = [];
  if (r.schema_version !== "guild.model_resolution.v1") errors.push("schema_version");
  if (!r.finalized_at) errors.push("not finalized — consumers accept finalized receipts only (§8)");
  if (!r.receipt_hash) errors.push("receipt_hash missing");
  for (const [i, a] of (r.outcome?.attempted ?? []).entries()) {
    if (a.result === "served") {
      if (a.substitution_class == null) errors.push(`attempted[${i}] served without substitution_class`);
      if (a.actual_model == null) errors.push(`attempted[${i}] served without actual_model`);
      if (a.substitution_class === "provider_silent" && a.actual_model !== "unknown") {
        errors.push(`attempted[${i}] provider_silent must record actual_model unknown`);
      }
    }
    if (a.result === "failed" && a.failure_class == null) errors.push(`attempted[${i}] failed without failure_class`);
  }
  return errors;
}

function validateProposalV2(p: any): string[] {
  const errors: string[] = [];
  if (p.schema_version !== "guild.team_proposal.v2") errors.push("schema_version");
  for (const bad of ["cap", "capped", "dropped_roles", "team_size", "max_team_size"]) {
    if (bad in p) errors.push(`truncation key '${bad}' present (closed schema, uncapped composition)`);
  }
  const ids = new Set((p.participants ?? []).map((x: any) => x.participant_id));
  if (ids.size !== (p.participants ?? []).length) errors.push("duplicate participant_id");
  for (const ob of p.obligations ?? []) {
    const owners = ob.disposition?.owners ?? [];
    const excluded = ob.disposition?.exclusion;
    if (owners.length === 0 && !excluded) errors.push(`obligation ${ob.obligation_id} unowned`);
    if (!owners.every((o: string) => ids.has(o))) errors.push(`obligation ${ob.obligation_id} owner not a participant`);
  }
  // depends_on forms a DAG over resolvable ids:
  const deps = new Map((p.participants ?? []).map((x: any) => [x.participant_id, x.depends_on ?? []]));
  const seen = new Set<string>();
  let progressed = true;
  while (progressed && seen.size < ids.size) {
    progressed = false;
    for (const id of ids) {
      if (!seen.has(id) && (deps.get(id) as string[]).every((d) => seen.has(d))) {
        seen.add(id as string);
        progressed = true;
      }
    }
  }
  if (seen.size !== ids.size) errors.push("depends_on not a resolvable DAG");
  return errors;
}

const HEX64 = /^[0-9a-f]{64}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function validateDecisionV1(d: any): string[] {
  const errors: string[] = [];
  if (d.schema_version !== "guild.team_decision.v1") errors.push("schema_version");
  if (!HEX64.test(d.proposal_hash ?? "")) errors.push("proposal_hash must be sha256 hex (external-reference binding)");
  if (!["approve", "restructure"].includes(d.decision)) errors.push("decision outside closed enum");
  if (typeof d.decided_by !== "string" || d.decided_by.length === 0) errors.push("decided_by required");
  if (!RFC3339.test(d.decided_at ?? "")) errors.push("decided_at not RFC3339");
  // §4: restructure_edits present iff decision=restructure.
  if (d.decision === "restructure" && !(Array.isArray(d.restructure_edits) && d.restructure_edits.length > 0)) {
    errors.push("restructure without restructure_edits");
  }
  if (d.decision === "approve" && d.restructure_edits != null) errors.push("approve must not carry restructure_edits");
  if (d.decision_hash_algorithm !== "sha256") errors.push("decision_hash_algorithm");
  // §1: the EXACT omitted-field scope string — blanked/placeholder conventions rejected.
  if (d.decision_hash_scope !== "canonical_yaml_with_decision_hash_field_omitted") {
    errors.push("decision_hash_scope not the exact omitted-field scope");
  }
  if (!HEX64.test(d.decision_hash ?? "")) errors.push("decision_hash");
  return errors;
}

function validateScheduleV1(s: any, approvedIds: string[]): string[] {
  const errors: string[] = [];
  if (s.schema_version !== "guild.team_schedule.v1") errors.push("schema_version");
  if (!HEX64.test(s.proposal_hash ?? "")) errors.push("proposal_hash");
  if (!HEX64.test(s.decision_hash ?? "")) errors.push("decision_hash");
  const c = s.concurrency ?? {};
  if (c.effective !== Math.min(c.selected_hint ?? c.verified_backend_capacity, c.verified_backend_capacity)) {
    errors.push("concurrency.effective != min(selected_hint, verified_backend_capacity)");
  }
  // §5 set-equality invariants (SETS, not counts), modulo cited explicit removal:
  const approved = new Set(approvedIds);
  const terminalIds: string[] = (s.terminal_outcomes ?? []).map((t: any) => t.participant_id);
  if (new Set(terminalIds).size !== terminalIds.length) errors.push("duplicate terminal outcome (exactly-one violated)");
  if ([...new Set(terminalIds)].sort().join() !== [...approved].sort().join()) errors.push("terminal-outcome id set != approved set");
  const removed = new Set<string>();
  for (const t of s.terminal_outcomes ?? []) {
    if (t.outcome === "explicitly_removed_by_new_decision") {
      if (!HEX64.test(t.via_decision_hash ?? "")) errors.push("explicit removal without citing the new decision hash");
      removed.add(t.participant_id);
    } else if (!["completed", "failed"].includes(t.outcome)) {
      errors.push(`terminal outcome outside closed enum: ${t.outcome}`);
    }
  }
  const expected = approvedIds.filter((id) => !removed.has(id)).sort().join();
  const waveUnion: string[] = (s.base_waves ?? []).flat();
  if (new Set(waveUnion).size !== waveUnion.length) errors.push("participant id in more than one wave");
  if ([...new Set(waveUnion)].sort().join() !== expected) errors.push("base-wave union != approved set");
  for (const w of s.base_waves ?? []) if (w.length > c.effective) errors.push("wave exceeds effective concurrency");
  const receiptIds = [...new Set((s.dispatch_receipts ?? []).map((r: any) => r.participant_id))].sort().join();
  if (receiptIds !== expected) errors.push("dispatch-receipt id set != approved set");
  return errors;
}

/** Derive a fixture-family file prefix from a declared contract id: guild.<family>.vN -> <family> with '_' -> '-'. */
function familyPrefix(contractId: string): string {
  const m = /^guild\.([a-z0-9_]+)\.v\d+$/.exec(contractId);
  if (!m) throw new Error(`unrecognized contract id: ${contractId}`);
  return m[1].replace(/_/g, "-");
}

/** Declared contract families with no fixture file present — the presence-check core. */
function missingFixtureFamilies(declared: string[], files: string[]): string[] {
  return declared.filter((c) => !files.some((f) => f.startsWith(familyPrefix(c))));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("dynamic-host-model-routing contract-fixture consumer (v1)", () => {
  it("finds a fixture for EVERY contract family DECLARED in the manifest (derived — no hard-coded prefix list)", () => {
    const manifest = fixture("manifest.json");
    expect(manifest.fixture_set_version).toBe(1);
    const files = fs.readdirSync(FIXTURE_DIR);
    // All seven frozen contracts are declared, and each DECLARED family must
    // have >=1 fixture file — a future declared-but-absent family fails here.
    expect(manifest.frozen_contracts).toHaveLength(7);
    expect(missingFixtureFamilies(manifest.frozen_contracts, files)).toEqual([]);
    // §7 legacy-migration feedstock (not a frozen contract) must also stay present:
    expect(files.some((f) => f.startsWith("team-plan"))).toBe(true);
  });

  it("[anti-vacuity] a declared-but-absent contract family FAILS the derived presence check", () => {
    const manifest = fixture("manifest.json");
    const files = fs.readdirSync(FIXTURE_DIR);
    const ghost = "guild.ghost_family.v1";
    expect(missingFixtureFamilies([...manifest.frozen_contracts, ghost], files)).toEqual([ghost]);
  });

  it("valid session_context fixture passes the local validator", () => {
    expect(validateSessionContext(fixture("session-context.valid.json"))).toEqual([]);
  });

  it("[anti-vacuity] invalid session_context fixtures are REJECTED (composite surface; claude-default repair)", () => {
    expect(validateSessionContext(fixture("session-context.invalid-composite-surface.json"))).not.toEqual([]);
    expect(validateSessionContext(fixture("session-context.invalid-claude-default.json"))).not.toEqual([]);
  });

  it("valid catalog fixture passes; ranking fields populated per catalog §1", () => {
    const cat = fixture("model-catalog.valid.json");
    expect(validateCatalog(cat)).toEqual([]);
    for (const m of cat.models) {
      expect(EVIDENCE_STATES).toContain(m.evidence.state);
      expect(Number.isInteger(m.catalog_index)).toBe(true);
      expect(typeof m.provider_default).toBe("boolean");
    }
  });

  it("[anti-vacuity] invalid catalog fixtures are REJECTED (open evidence enum; static-hint 'available')", () => {
    expect(validateCatalog(fixture("model-catalog.invalid-open-evidence.json"))).not.toEqual([]);
    expect(validateCatalog(fixture("model-catalog.invalid-static-available.json"))).not.toEqual([]);
  });

  it("baseline model_policy.v2 fixture validates (closed grammar, research floor, forbid on research routes)", () => {
    expect(validatePolicy(fixture("model-policy.baseline.json"))).toEqual([]);
  });

  it("[anti-vacuity] invalid policies are REJECTED (research downgrade; bare selector + misplaced condition)", () => {
    expect(validatePolicy(fixture("model-policy.invalid-research-downgrade.json"))).not.toEqual([]);
    expect(validatePolicy(fixture("model-policy.invalid-bare-selector.json"))).not.toEqual([]);
  });

  it("finalized golden receipt validates; provider-silent golden records actual_model unknown", () => {
    expect(validateFinalizedReceipt(fixture("model-resolution.finalized.json"))).toEqual([]);
    const silent = fixture("model-resolution.provider-silent.json");
    expect(validateFinalizedReceipt(silent)).toEqual([]);
    expect(silent.outcome.actual_model).toBe("unknown");
  });

  it("[anti-vacuity] the unfinalized receipt is REJECTED as evidence (§8 consumers read finalized only)", () => {
    expect(validateFinalizedReceipt(fixture("model-resolution.unfinalized.json"))).not.toEqual([]);
  });

  it("team-proposal.v2 fixture validates: uncapped 9-participant roster, all kinds inside the gate, DAG deps, full coverage", () => {
    const p = fixture("team-proposal.v2.json");
    expect(validateProposalV2(p)).toEqual([]);
    expect(p.participants.length).toBeGreaterThan(6); // larger than the retired cap
    const kinds = new Set(p.participants.map((x: any) => x.participation_kind));
    for (const k of ["worker", "advisor", "challenger", "reviewer_cross_host"]) expect(kinds).toContain(k);
    // Proposed waves exceed backend capacity WITHOUT roster loss:
    expect(p.backend_capacity_evidence.verified_capacity).toBeLessThan(p.participants.length);
    expect(p.proposed_schedule.waves.flat().sort()).toEqual(p.participants.map((x: any) => x.participant_id).sort());
  });

  it("[anti-vacuity] injected truncation of the v2 proposal is REJECTED (dropped participant orphans its obligation)", () => {
    const p = fixture("team-proposal.v2.json");
    p.participants = p.participants.slice(0, 8); // drop p8, keep its obligation
    expect(validateProposalV2(p)).not.toEqual([]);
  });

  it("team_plan.v1 migration fixtures carry the §7 dispositions (capped => recompose; lossless => pending only)", () => {
    const capped = fixture("team-plan.v1.capped.json");
    const lossless = fixture("team-plan.v1.lossless.json");
    const isLossy = (plan: any) => plan.capped === true || (plan.dropped_roles ?? []).length > 0;
    expect(isLossy(capped)).toBe(true);
    expect(isLossy(lossless)).toBe(false);
    expect(capped._migration_expectation).toMatch(/recomposition/);
    expect(lossless._migration_expectation).toMatch(/PENDING/);
  });

  it("team_decision.v1 fixtures validate (approve + restructure) and bind the proposal by ITS declared hash", () => {
    const approve = fixture("team-decision.v1.approve.json");
    const restructure = fixture("team-decision.v1.restructure.json");
    expect(validateDecisionV1(approve)).toEqual([]);
    expect(validateDecisionV1(restructure)).toEqual([]);
    // External-reference binding (§1): both decisions cite the proposal fixture's own hash.
    const proposal = fixture("team-proposal.v2.json");
    expect(approve.proposal_hash).toBe(proposal.proposal_hash);
    expect(restructure.proposal_hash).toBe(proposal.proposal_hash);
    // §4: a restructure yields a NEW proposal version, never mutated bytes.
    expect(restructure.resulting_proposal.version).toBe(2);
    expect(restructure.resulting_proposal.hash).not.toBe(proposal.proposal_hash);
  });

  it("[anti-vacuity] invalid decisions are REJECTED (blanked hash scope; restructure without edits)", () => {
    expect(validateDecisionV1(fixture("team-decision.v1.invalid-blanked-hash-scope.json"))).not.toEqual([]);
    expect(validateDecisionV1(fixture("team-decision.v1.invalid-restructure-without-edits.json"))).not.toEqual([]);
  });

  it("team_schedule.v1 completed fixture validates: four-set equality, exactly-one terminal outcome, retry as attempt 2 on the SAME id", () => {
    const proposal = fixture("team-proposal.v2.json");
    const approvedIds = proposal.participants.map((x: any) => x.participant_id);
    const schedule = fixture("team-schedule.v1.completed.json");
    expect(validateScheduleV1(schedule, approvedIds)).toEqual([]);
    // Chain binding: schedule cites the proposal's hash and the approve decision's hash.
    expect(schedule.proposal_hash).toBe(proposal.proposal_hash);
    expect(schedule.decision_hash).toBe(fixture("team-decision.v1.approve.json").decision_hash);
    // The retry is a second ATTEMPT on p3, not a new participant:
    const p3 = schedule.dispatch_receipts.filter((r: any) => r.participant_id === "p3");
    expect(p3.map((r: any) => r.attempt)).toEqual([1, 2]);
    // failed is a legitimate single terminal outcome (p7):
    expect(schedule.terminal_outcomes.filter((t: any) => t.outcome === "failed")).toHaveLength(1);
  });

  it("[anti-vacuity] invalid schedules are REJECTED (silent roster drop; duplicate terminal outcome)", () => {
    const approvedIds = fixture("team-proposal.v2.json").participants.map((x: any) => x.participant_id);
    const dropped = validateScheduleV1(fixture("team-schedule.v1.invalid-dropped-participant.json"), approvedIds);
    expect(dropped).not.toEqual([]);
    expect(dropped.join()).toMatch(/approved set/);
    const dup = validateScheduleV1(fixture("team-schedule.v1.invalid-duplicate-terminal.json"), approvedIds);
    expect(dup).not.toEqual([]);
    expect(dup.join()).toMatch(/exactly-one/);
  });

  // EXPECTED-FAIL until the publication pipeline ships. Lane T2 defines the
  // fixtures; the plugin build must publish/refresh them with per-file sha256
  // checksums and flip `published_by_plugin_build`. `it.fails` is the honest
  // signal: this PASSES while benchmark consumes hand-copied (not build-
  // published) fixtures, and will turn RED the moment the pipeline ships and the
  // assertions below start passing — prompting removal of `.fails`. (Was a plain
  // failing `it()` that red-blocked CI; converted to the self-correcting idiom.)
  it.fails("EXPECTED-FAIL until the plugin build publishes checksummed fixture copies (module-map §5 publication pipeline)", () => {
    const manifest = fixture("manifest.json");
    expect(manifest.published_by_plugin_build).toBe(true);
    expect(manifest.checksums).toBeDefined();
  });
});
