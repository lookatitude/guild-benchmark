---
type: standard
owner: diagram-motion-designer
confidence: high
importance: critical
applies_to: [benchmark]
labels:
  domain: [benchmark]
  concern: [visual-explanation, diagrams, motion, validation]
  status: active
source_refs:
  - ../../../../.guild/wiki/standards/operational-atlas-visual-contract.md
  - ../../../../.guild/artifacts/generated/operational-atlas/contract-manifest.yaml
  - ../../../../PRODUCT.md
  - ../../../../DESIGN.md
  - ../../../../images/guildstack-logo.png
  - ../../../ui/src/styles/global.css
  - ../../../ui/src/App.tsx
  - ../../../ui/public/brand/guildstack-logo-128.png
updated_at: 2026-07-17
---

# Operational Atlas benchmark profile

## Authority

The umbrella Operational Atlas visual contract is canonical. Its generated
manifest is the machine-readable token, shape, state, asset, and validation
surface. This page adds benchmark-only implementation details. It does not copy
or override the shared contract.

Resolve these paths from the benchmark repository root:

```text
../.guild/wiki/standards/operational-atlas-visual-contract.md
../.guild/artifacts/generated/operational-atlas/contract-manifest.yaml
../images/guildstack-logo.png
```

## Benchmark explanation jobs

| Job | Default truthful grammars | Evidence anchor |
|---|---|---|
| Evaluation lifecycle | route, branch or state loop | case, run, stage, verdict, receipt |
| Scoring anatomy | layered stack, ledger, focused architecture slice | weight, component score, reason, source record |
| Baseline versus candidate | comparison field or matrix | exact values, delta, regression or improvement |
| Dispatch or handoff | sequence, lifelines, or transfer swimlane | task id, owner, receipt, review result |
| Run reconstruction | ledger or file tree | run record, trace, handoff, review, verification |
| Recovery or reflection | state loop | prior state, trigger, decision, resulting evidence |
| Host, model, or suite resolution | resolver matrix | independent inputs, selected posture, degradation |
| Benchmark subsystem boundary | focused architecture slice | module, consumer, schema, source path |

Do not default to a line diagram because another screen used one. Do not turn
every metric into a card. Do not use a node cloud as visual atmosphere.

The interactive knowledge graph is a narrow exception because graph topology
is itself the inspection task. It remains evidence-led only when search or list
inspection, focus behavior, readable labels, legend semantics, and selected
node evidence remain available.

## Evidence-led copy

Labels and adjacent explanation use current benchmark nouns: case, suite,
baseline, candidate, score, delta, component, run, stage, receipt, verdict,
trace, source, and support state. Prefer exact metric names, run ids, artifact
paths, schema names, and source refs. Mark illustrative sequences. Never invent
product capabilities, support parity, test results, or marketing promises to
complete a visual.

## Local production rules

1. Load the umbrella contract and generated manifest.
2. Read current benchmark sources and name the exact relationship being
   explained.
3. Decide whether a visual materially improves comprehension. Reject decorative
   work.
4. Generate at least three candidate grammars and record why two were rejected.
5. Check recent consumers for repeated route, card, and node patterns.
6. Define the complete static state before motion.
7. Produce dark and light states from the same semantic definition.
8. Use the exact canonical logo only when required, with source provenance.
9. Validate semantics, accessibility, geometry, motion frames, reduced motion,
   and evidence claims.
10. Record consumers, formats, provenance, and retirement condition.

## Acceptance boundary

A benchmark explanation fails when any of these is true:

- dark and light versions differ in structure, labels, evidence, or hierarchy;
- status depends on color alone;
- the logo is redrawn, recolored, cropped, or generated;
- the chosen grammar misstates the relationship;
- a route, card grid, or node field repeats only for visual consistency;
- real or longest labels overlap, clip, collide with paths, or require tiny
  rescue type;
- animation is decorative, one-shot for a live loop, or lacks reduced motion;
- the static state omits a branch, gate, return path, receipt, or evidence cue;
- a claim lacks a current source;
- validation records no viewport, theme, label set, frame checkpoints, or
  finding disposition.

The approved benchmark export is
`ui/public/brand/guildstack-logo-128.png`. It is byte-identical to the approved
website 128px export and must remain a proportional, unmodified copy.

This profile owns explanation and validation only. Website page strategy,
marketing, campaigns, and public asset integration remain outside the benchmark
team.
