# benchmark/design/ — benchmark design deltas

Console-only design decisions on top of the shared workspace design system
(Operational Atlas). The workspace base wins on shared tokens and brand.

- Shared tokens: vendored at `ui/src/styles/system/tokens.css` (see
  `VENDORED.json`); never edit, never redefine a shared `--color-*` token.
- Consumer profile: `.guild/wiki/standards/operational-atlas-benchmark-profile.md`.
- Console styling: `ui/src/styles/global.css` (local aliases + layout only).
- Process: workspace `docs/maintainer-guide.md`.
