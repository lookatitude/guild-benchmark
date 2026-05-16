# Benchmark Knowledge Index

> **Scope note.** This `docs/` tree holds only knowledge that is *exclusively*
> about the benchmark engine (datasets, fixtures, golden outputs, scoring
> rubrics, adversarial repos). Cross-cutting product knowledge — architecture,
> lifecycle, data model, adversarial review, etc. — lives in the root repo at
> `docs/knowledge/` with `applies_to:` listing the repos it covers. Do not
> duplicate root knowledge here; cite it instead.

Follows guild-wiki §10.1.1 conventions: every page carries the extended
frontmatter block (`type`, `owner`, `confidence`, `source_refs`, timestamps,
`sensitivity`, `applies_to`, `related`).

## research

Verbatim deep-research provenance for the benchmark engine.

| Page | Summary |
|---|---|
| [research/benchmark-datasets-fixtures.md](research/benchmark-datasets-fixtures.md) | Fixture taxonomy (code patch, reverse-spec, planning DAG, prompt-injection, memory promotion, skill evolution, human approval), scoring dimensions, dataset versioning, and SWE-bench anchoring for the Guild benchmark engine. |
