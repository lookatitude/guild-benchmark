# ADR G13 — Knowledge-graph layout engine

**Status:** Accepted · **Date:** 2026-06-25 · **Lane:** G13 (codebase-learning-recall-acceleration)
**Owner:** AGENT-3 · **Scope:** `benchmark/ui` knowledge-graph canvas

## Context

The benchmark Knowledge explorer (`ui/src/routes/KnowledgePage.tsx`) renders the
knowledge graph with a **static, hand-placed SVG ring layout** (`buildGraphLayout`):
modules on an inner ellipse, everything else on concentric outer ellipses. Two problems:

1. **Overlap at scale.** Beyond ~80 nodes the rings crowd and node circles overlap, so
   large graphs are unreadable.
2. **No workspace separation.** In workspace mode nodes carry a `source_guild`, but the
   layout ignores it — nodes from different guilds are interleaved with no visual grouping.

G13 requires a **force-directed (physics) layout** with zoom/pan/drag and **per-guild
lane grouping + color** for workspace mode, while honoring the file's standing posture
(`G-18`: *no new heavy graph runtime dep for this view*).

## Options

| Option | What | Bundle delta | Pros | Cons |
|---|---|---|---|---|
| **(a) `d3-force`** | Add the layout-only d3 module; keep our own SVG render | **+~33 KB min** (`d3-force` + `d3-dispatch`/`d3-quadtree`/`d3-timer` transitive) | Battle-tested Barnes–Hut many-body, well-known API | New runtime dep against G-18; pulls 4 transitive packages; quadtree value is marginal at our node counts (≤320 rendered, capped by the existing `graphLimit`) |
| **(b) Hand-rolled simulation** | A compact deterministic velocity-Verlet sim (repulsion + link springs + gravity + per-guild x-centering) as a pure module | **+0 KB** (≈190 LOC, no dep) | Honors G-18; fully deterministic + pure → unit-testable overlap metric; tailored guild-lane force; O(n²) is fine at our capped node counts | We own the physics; no quadtree (O(n²) many-body, acceptable ≤ a few hundred nodes) |

## Decision

**Option (b) — a hand-rolled, dependency-free force simulation.**

Rationale:
- The rendered graph is **already capped** (`graphLimit` ∈ {80,160,320,800}), so the
  O(n²) many-body cost is bounded and runs comfortably in a `useMemo` (200 nodes ×
  ~300 iters ≈ 6M pair-ops, sub-second, off the render path after memoization).
- G-18 explicitly prefers no new runtime dep; a focused ~190-line module is well under
  the lane's "<150 lines if compact" bar for the *core* sim (the extras are the guild
  colour/lane helpers + transform reducers + the retained legacy layout for the
  anti-vacuity test).
- **Determinism** is a hard requirement for the validation gate (an automated overlap
  metric must be reproducible). A hand-rolled sim seeded by a **phyllotaxis spiral**
  (golden-angle, index-based — no `Math.random`) gives a stable, reproducible result;
  d3-force would need the same deterministic seeding bolted on anyway.
- Keeping the physics as **pure functions** (`runForceLayout`, `stepSimulation`,
  `overlapRatio`, `guildColor`, `assignGuildLanes`, `panTransform`, `zoomTransform`)
  makes every gate assertion a unit test, not a DOM eyeball.

## Consequences & tradeoffs

- **Bundle-size delta: 0 KB.** No `package.json` change.
- We maintain the simulation. It is intentionally simple (no quadtree, no collision
  constraint solver). If node counts ever exceed the current caps materially, revisit
  Option (a) or add a Barnes–Hut quadtree.
- **Fallback preserved:** for tiny graphs (≤ `SMALL_GRAPH_MAX` = 8 nodes) the original
  static ring layout (`legacyRingLayout`, extracted as a pure fn) is used — no regression
  for the common small case, and it doubles as the anti-vacuity baseline in tests.
- New module: `ui/src/routes/forceLayout.ts` (pure). `KnowledgePage.tsx` consumes it and
  adds `ViewTransform` state (zoom/pan), a pin map (drag), and a guild-colour legend.

## Validation hook

The overlap metric (`overlapRatio`) is the numeric gate: on a 200-node fixture the
force layout must land **< 2%** overlapping node pairs, while the **same metric on
`legacyRingLayout`** for the same 200 nodes **exceeds** it — proving the gate
distinguishes a good layout from a bad one.
