---
name: guild-diagram-motion-designer
description: "Select, design, choreograph, and validate source-backed Operational Atlas explanations for benchmark sequences, transfers, branches, hierarchies, comparisons, states, evidence paths, and architecture boundaries."
when_to_use: "Use when a benchmark relationship is materially clearer through space, shape, timing, or movement than through concise copy or a standard data view."
type: production
derived_from_template: guild.skill_template.v1
external_skills: [impeccable]
canonical_contract: ../.guild/wiki/standards/operational-atlas-visual-contract.md
contract_manifest: ../.guild/artifacts/generated/operational-atlas/contract-manifest.yaml
local_profile: .guild/wiki/standards/operational-atlas-benchmark-profile.md
used_by: [diagram-motion-designer]
---

# Guild Diagram Motion Designer

Use this skill for benchmark explanations that make evaluation behavior,
comparison, evidence, or architecture materially easier to inspect. It does
not create decorative assets or expand benchmark into a marketing system.

For visual design, layout, animation, polish, critique, or frontend interface
work, apply the Impeccable plugin's setup and design laws before file edits.

## Required Reading

Read by pointer, then read only the local source material that applies:

- `../.guild/wiki/standards/operational-atlas-visual-contract.md`
- `../.guild/artifacts/generated/operational-atlas/contract-manifest.yaml`
- `.guild/wiki/standards/operational-atlas-benchmark-profile.md`
- Benchmark code, schemas, tests, reports, and run evidence named in the brief
- `../.guild/wiki/standards/product-voice-steward.md` when labels need the
  shared product vocabulary

The umbrella sources are canonical. The benchmark profile adds only local
consumer details and never overrides the shared contract.

## Trigger Gate

Use a diagram only for sequence, branching, transfer, ownership, hierarchy,
comparison, state, scope, evidence anatomy, or architecture. Do not trigger for
a simple fact, a single number, a decorative gap, or prose that is already
clear. Prefer a standard table or text list when exact comparison is the job
and spatial structure adds nothing.

## Grammar Selection

Choose from the relationship, never from convenience:

1. `route` for one ordered path with stations, gates, receipts, and a terminus.
2. `branch_merge` for alternatives, fan-out, convergence, or conditional paths.
3. `state_loop` for review, retry, recovery, reflection, or governed mutation.
4. `sequence_lifelines` for ordered messages between named participants.
5. `transfer_swimlane` for ownership crossing agents, tools, hosts, or buses.
6. `resolver_matrix` for independent inputs producing one named posture.
7. `layered_stack` for precedence, containment, hierarchy, or ownership.
8. `scope_orbit` for optional coordination around one canonical center.
9. `ledger_file_tree` for durable records and read-only projections.
10. `comparison_field` for baseline and candidate differences that must remain
    visible.
11. `architecture_slice` for one bounded subsystem and its evidence-backed
    boundaries.

Generate at least three plausible grammar candidates for a new explainer. Name
why two were rejected. Check the recent consumer set so adjacent explanations
do not repeat line diagrams, card grids, or node fields without a semantic
reason.

## Operational Atlas Contract

- Dark is the primary expression, but light is a first-class structural twin.
  Both themes use the same nodes, labels, ordering, evidence, and hierarchy.
- Use the exact canonical logo at `../../../../design/images/guildstack-logo.png` only when a
  logo is necessary. Do not redraw, recolor, crop, or generate it. A derived
  size must retain provenance to the canonical source.
- Resolve semantic color tokens from the generated manifest. Live or active,
  selected or executing, verified or passed, human gate or degraded, blocked
  or failed, and neutral states must remain distinct in both themes.
- Pair every semantic color with a label and shape, icon, stroke, or pattern.
  Never encode state through color alone.
- Use real labels and evidence-led copy. A claim sits beside a run id, metric,
  artifact path, gate, verdict, source ref, or support state.
- Never use decorative gradients, vague node clouds, generic AI imagery,
  identical box-and-arrow plates, or equal card grids as explanation.
- A functional knowledge graph may use node-link interaction because graph
  topology is the task. It still needs search or list inspection, readable
  labels, focus behavior, a legend, and a non-decorative evidence purpose.

## Motion Rules

- Define the complete static resolved state before choreography.
- Motion represents packet transfer, state change, selection, gate activity,
  receipt creation, scan, or return. Decorative motion is forbidden.
- For a live explainer, use a calm persistent cycle with a readable resting
  interval. Preserve causal order, make return paths return visibly, and never
  imply that every branch executes.
- Prefer transform, opacity, stroke offset, or semantic state changes. Do not
  animate layout properties.
- Pause or suppress persistent motion when the explainer is offscreen, hidden,
  or not the active inspection target.
- `prefers-reduced-motion` removes choreography and shows the full meaningful
  state. Information never depends on timing alone.

## Validation Gate

An explanation fails until all applicable checks pass:

1. Source check: every claim, label, node, transition, and state has a source.
2. Grammar check: the selected form matches the relationship and two rejected
   alternatives are recorded.
3. Diversity check: the consumer set does not repeat one line, card, or node
   pattern without a semantic reason.
4. Theme check: dark and light have identical semantics, structure, and proof.
5. Logo check: any logo use matches the canonical asset and records provenance.
6. Accessibility check: alt text, semantic fallback, focus behavior for any
   interaction, and non-color state encoding are present.
7. Geometry check: real and longest labels do not overlap, clip, collide with
   paths, or overflow the smallest accepted viewport.
8. Motion check: inspect the cycle at start, quarter, midpoint,
   three-quarters, and reset. Check continuity, occlusion, contrast, and reset.
9. Reduced-motion check: the complete state passes the same geometry and
   contrast checks with moving packets removed.
10. Evidence check: validation records the viewport, themes, labels, frames,
    findings, and exact source refs used.

For projected explanations, primary labels are at least 17px and secondary
labels at least 15px. Prefer five or fewer primary nodes in one field. When
content does not fit, decompose it or change grammar. Never rescue density by
shrinking below the readability floor.

## Benchmark Scope

Owned jobs include evaluation flows, scoring paths, baseline-versus-candidate
comparisons, run ledgers, lifecycle and review states, focused architecture
slices, and evidence-backed knowledge explanations. This skill does not own
website information architecture, brand strategy, marketing copy, campaigns,
or page implementation. Cross-surface reuse produces a pointer and consumer
note only.

## Output Contract

```yaml
diagram_package:
  canonical_contract:
  contract_manifest:
  local_profile:
  diagram_id:
  explanation_job:
  audience:
  source_refs:
  evidence_claims:
  target_surfaces:
  relationship:
  selected_grammar:
  rejected_grammars:
  recent_pattern_check:
  real_labels:
  semantic_shapes:
  semantic_colors:
  canonical_logo:
  dark_state:
  light_state:
  static_state:
  motion_cycle:
  reduced_motion_state:
  alt_text:
  semantic_fallback:
  consumers:
  provenance:
  retirement_condition:
  implementation_notes:
  validation_evidence:
    source_check:
    grammar_check:
    diversity_check:
    theme_check:
    logo_check:
    accessibility_check:
    geometry_check:
    frame_check:
    reduced_motion_check:
  cross_surface_handoff:
```

Do not return a pass when any required validation field is absent,
inconclusive, or contradicted by the implementation.
