# Guild Benchmark — repo orientation

The Guild **benchmark / eval engine** (`@guild/benchmark`). Standalone — extracted from
`plugin/benchmark/`; **no imports from `plugin/` source paths** (keep it that way). It imports
Guild run records (`.guild/runs/`), scores them, and serves the live-project + knowledge-graph/wiki
UI (`benchmark serve --project-root <repo>`).

This `AGENTS.md` is the canonical host-neutral instruction file; `CLAUDE.md` only imports it.

## Workspace context
This repo is a sub-project of the Guild umbrella workspace (`..`). The umbrella holds the
cross-project `.guild/` layer; this repo holds benchmark-specific `.guild/` state in the same
standard layout. Read umbrella + sibling knowledge through workspace federation; never replicate it here.

## v2 knowledge / memory / config
- **Canonical durable knowledge:** this repo's `.guild/wiki/**` (filesystem-only, KnowledgeGraph-
  derived). Benchmark-exclusive knowledge lives here; cross-cutting knowledge lives in the umbrella
  `.guild/wiki/`. `docs/knowledge/` is **retired** (was a v2-design store; harvested 2026-06-27).
- **Shareable project extensions:** benchmark-only agents, skills, workflows, loops, memory,
  initiatives, teams, and artifacts live under this repo's `.guild/{agents,skills,workflows,loops,
  memory,initiatives,teams,artifacts}/`.
- **Config:** `.guild/settings.json` (inherits builtin < workspace < project per the 7-source chain).
- **Runtime `.guild/` state:** operator-local host state remains ignored under `.guild/hosts/`; the
  standard shareable `.guild/` subsets are tracked when intentionally added.

## Discipline
- Create feature branches from `next`; all feature, fix, docs and sync PRs target `next`.
- `main` accepts only the same-repository `next` release PR, using **Create a merge commit**.
- The root package version is the release identity; keep its lockfile in sync.
- `next` carries a prerelease version; a version-only PR removes the suffix before promotion.
- Release publishes the tested source and console bundles on GitHub; it does not publish to npm.
- Install the direct-push guard per clone: `git config core.hooksPath .githooks`.
- Full gates and release steps: workspace `docs/release-workflow.html`.
- Use absolute paths for `.guild/` writes.
