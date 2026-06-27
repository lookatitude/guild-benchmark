# Guild Benchmark — repo orientation

The Guild **benchmark / eval engine** (`@guild/benchmark`). Standalone — extracted from
`plugin/benchmark/`; **no imports from `plugin/` source paths** (keep it that way). It imports
Guild run records (`.guild/runs/`), scores them, and serves the live-project + knowledge-graph/wiki
UI (`benchmark serve --project-root <repo>`).

This `AGENTS.md` is the canonical host-neutral instruction file; `CLAUDE.md` only imports it.

## Workspace context
This repo is a sub-project of the Guild umbrella workspace (`..`). The umbrella holds the
cross-project layer (`.guild/wiki/`, `.guild/workspace-knowledge/`, `.guild/initiatives/`). Read
umbrella + sibling knowledge through workspace federation; never replicate it here.

## v2 knowledge / memory / config
- **Canonical durable knowledge:** this repo's `.guild/wiki/**` (filesystem-only, KnowledgeGraph-
  derived). Benchmark-exclusive knowledge lives here; cross-cutting knowledge lives in the umbrella
  `.guild/wiki/`. `docs/knowledge/` is **retired** (was a v2-design store; harvested 2026-06-27).
- **Config:** `.guild/settings.json` (inherits builtin < workspace < project per the 7-source chain).
- **Runtime `.guild/` state** (runs, raw, indexes) is gitignored; the wiki subset is tracked.

## Discipline
- Branch + PR; no direct commits to `main` (v2 work lands on `release/v2.0.0`).
- Use absolute paths for `.guild/` writes.
