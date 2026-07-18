# benchmark/design/ — benchmark design deltas

Delta set on top of the shared workspace design system at `../../design/`
(Operational Atlas). Rule: the workspace base wins on shared tokens and brand;
files here **extend, never fork** — benchmark-specific report/UI styling only.

- Shared base: `../../design/` (PRODUCT.md, DESIGN.md, DESIGN.json,
  guildstack.pen, brand assets, verifiers)
- This repo's consumer profile: `.guild/wiki/standards/operational-atlas-benchmark-profile.md`
  (defers to the umbrella contract)
- Live styling implementation: `ui/src/styles/global.css`

Add benchmark-only design decisions (report layouts, chart styling, UI
variants) here as they accrete; keep anything cross-project in the workspace
base.
