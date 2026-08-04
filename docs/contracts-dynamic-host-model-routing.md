# Contract consumption note — dynamic host & model routing (fixture set v1)

**Status:** Active · **Date:** 2026-08-02 · **Lane:** T9-docs-reconcile
**Upstream initiative:** `dynamic-host-model-routing`, umbrella run
`run-20260730-131020-dynamic-host-model-routing`
**Scope:** `benchmark/fixtures/contracts/dynamic-host-model-routing/v1/` and
`benchmark/tests/contracts-dynamic-routing.consumer.test.ts`

## What this repo consumes, and how

The benchmark engine is a **consumer** of seven frozen contracts owned by the
plugin. It consumes them as **versioned fixture copies only** — never as a source
import.

| Frozen contract | Fixture files (v1) |
|---|---|
| `guild.session_context.v1` | `session-context.valid.json` + 2 invalid |
| `guild.model_catalog.v1` | `model-catalog.valid.json` + 2 invalid |
| `guild.model_policy.v2` | `model-policy.baseline.json` + 2 invalid |
| `guild.model_resolution.v1` | `model-resolution.{finalized,unfinalized,provider-silent}.json` |
| `guild.team_proposal.v2` | `team-proposal.v2.json` |
| `guild.team_decision.v1` | `team-decision.v1.{approve,restructure}.json` + 2 invalid |
| `guild.team_schedule.v1` | `team-schedule.v1.completed.json` + 2 invalid |

Legacy `guild.team_plan.v1` artifacts are also pinned
(`team-plan.v1.{capped,lossless}.json`) so the migration-window dual-read
behaviour stays covered from the consumer side.

### The independence rule is load-bearing

`module-map §5`: no file in this repo may `import` from `../plugin/**` for these
contracts. The consumer test implements its validators **locally, from the frozen
contract texts**, so a plugin refactor cannot silently satisfy a benchmark
assertion. The consumer test's imports are `vitest`, `node:fs`, and `node:path`
only — that is a checkable property, and it was checked by reading every import
line during the T8 integrated verification.

Anti-vacuity is part of the contract here: for each shape, at least one
*invalid* fixture must be **rejected** by the local validator. A validator that
accepted everything would pass the positive cases and prove nothing.

## Version and freshness

- `fixture_set_version: 1`, hand-authored by lane `T2-tdd-contract-fixtures`
  against the contract texts **frozen 2026-07-30**.
- The frozen texts live in the umbrella run's `contracts/` directory. A contract
  change requires a re-freeze plus re-approval upstream, then a new
  `fixture_set_version` here — never an in-place edit of v1.
- `manifest.json` records `frozen_contracts`, `fixture_set_version`, and
  `provenance`.

## One test fails by design — and why it should stay that way

`published_by_plugin_build` is `false`, and the consumer test asserts it is
`true`. That single failure is the **declared, load-bearing pin** for followup
**F5**: the plugin build does not yet publish checksummed fixture copies, so the
fixtures' integrity currently rests on review rather than on a recomputable
digest.

Do not "fix" it by relaxing the assertion. It is closed by the *plugin* shipping
the fixture-publication pipeline, which then flips the flag to `true` and adds
per-file `sha256` checksums. F5 is deferred to M1-tier work upstream.

Every other case in the suite passes: 17 pass / 1 failing-by-design.

## Upstream ship posture (read before drawing conclusions from a run)

The routing rollout is milestone-gated, and only the first milestone is live:

- **M0 (inspect-only) — LIVE.** Per-run identity, fail-closed run binding,
  discovery adapters + cache, the uncapped team proposal path, and the read-only
  `guild models inspect` surface. **No dispatch selection changes.**
- **M1 (shadow) and M2 (opt-in routing) — GATED**, `model_routing.shadow` and
  `model_routing.enabled` both default `off`.
- **M3 (default-on) — DEFERRED**, not shipped.

**Only four of the seven rollout flags are consumed — do not build an A/B on the
other three.** `model_routing.discovery`, `model_routing.inspect`,
`model_routing.shadow`, and `model_routing.enabled` each have a production code
path that branches on them, so toggling one changes behaviour and is a valid
benchmark variable. `model_routing.identity_v2`, `model_routing.binding_enforce`,
and `teams.proposal_v2` are declared, validated, and printed by
`guild models inspect`, but **no production code reads their value** — the
behaviour they were designed to gate is unconditional. A run with any of those
three set to `off` is byte-identical to a run with them `on`, so an arm built on
them measures nothing. (Upstream: those rollback legs are UNIMPLEMENTED; see
`docs/v2/model-routing.html` §Rollout flags.)

Consequence for benchmark measurement: a recorded run today reflects the
**existing** tier-map selection path, not v2 policy selection. Any comparison
that treats a current run as evidence about v2 routing behaviour is measuring the
wrong thing. Two further upstream gaps bound what can be measured at all — no
production path publishes a catalog snapshot yet, and no production path writes
the finalized served-model evidence a `strong` review-independence verdict
requires, so real runs record `weak` or `unknown`.

## Related

- Design set (canonical, umbrella): `docs/v2/model-routing.html`
- ADR (governing decision): `.guild/wiki/decisions/dynamic-host-model-routing.md`
- Frozen contract texts + module map:
  `.guild/runs/run-20260730-131020-dynamic-host-model-routing/contracts/`
- Integrated verification (SC-1…SC-16) and followup triage:
  `.guild/runs/run-20260730-131020-dynamic-host-model-routing/verification/`
