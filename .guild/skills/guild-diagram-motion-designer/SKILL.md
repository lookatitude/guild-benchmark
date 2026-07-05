---
name: guild-diagram-motion-designer
description: "Design readable static diagrams and animated SVG/CSS diagrams for benchmark workflows, evaluation architecture, proof paths, result explanations, and website handoffs."
when_to_use: "Use when benchmark docs, reports, UI explainers, public website handoffs, or presentations need a diagram, animation, legend, alt text, or reduced-motion behavior."
type: production
derived_from_template: guild.skill_template.v1
external_skills: [impeccable]
consistency_source: /Users/miguelp/Projects/guild/website/.guild/skills/guild-diagram-motion-designer/SKILL.md
---

# Guild Diagram Motion Designer

Use this skill for benchmark diagrams that explain evaluation behavior without
becoming dense technical posters.

For visual design, layout, animation, polish, critique, or frontend interface
work, apply the Impeccable plugin's setup and design laws before file edits.

## Required Reading

Read only what applies:

- Benchmark source refs named in the handoff
- Existing benchmark docs, reports, or UI files being explained
- `/Users/miguelp/Projects/guild/website/.guild/skills/guild-diagram-motion-designer/SKILL.md`
  when the diagram will be reused on the public website
- `/Users/miguelp/Projects/guild/.guild/wiki/standards/product-voice-steward.md`
  when labels or public-facing language are involved

## Diagram Types

- `evaluation_flow`: benchmark setup to run to result.
- `scoring_path`: input, scoring logic, outputs, and evidence.
- `artifact_map`: files, records, traces, exports, or reports.
- `comparison_matrix`: baseline, candidate, model, host, or suite comparison.
- `architecture_slice`: one benchmark subsystem only.
- `proof_path`: claim to evidence to validation gate.
- `animated_svg`: CSS/SVG animation that reveals sequence, state, or flow.

## Motion Rules

- Animate meaning: sequence, status, dependency, gating, or evidence.
- Prefer opacity, transform, stroke-dashoffset, or status highlight changes.
- Do not animate layout properties.
- Include `prefers-reduced-motion` behavior.

## Output Contract

```yaml
diagram_package:
  diagram_id:
  diagram_type:
  source_refs:
  target_surfaces:
  static_output:
  animated_output:
  legend:
  alt_text:
  reduced_motion_behavior:
  impeccable_notes:
  website_reuse_notes:
  validation_notes:
```
