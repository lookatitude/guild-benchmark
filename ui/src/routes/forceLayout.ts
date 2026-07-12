// forceLayout.ts — G13 force-directed graph layout (dependency-free).
//
// A compact, DETERMINISTIC velocity-Verlet force simulation for the knowledge
// graph canvas. No runtime dep (ADR g13-graph-layout.md, option b): repulsion
// (many-body) + link springs + centering gravity + per-`source_guild` lane
// x-centering. Everything here is a PURE function so the validation gate can
// assert on numbers (overlap ratio, colour mapping, transform reducers) rather
// than eyeballing a render.
//
// Determinism: initial positions come from a golden-angle phyllotaxis spiral
// keyed by node index — no Math.random — so the same input always converges to
// the same layout (required by the automated overlap gate).

export interface LayoutInputNode {
  id: string;
  guild?: string;
}

export interface LayoutInputEdge {
  source: string;
  target: string;
}

export interface LayoutNode {
  id: string;
  guild: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

export interface LayoutOptions {
  width: number;
  height: number;
  iterations: number;
  /** Many-body repulsion magnitude (inverse-square). */
  repulsion: number;
  /** Ideal link (spring) rest length. */
  linkDistance: number;
  /** Spring stiffness in [0,1]. */
  linkStrength: number;
  /** Pull-to-centre strength in [0,1]. */
  gravity: number;
  /** Per-guild x-lane centring strength in [0,1]. */
  guildStrength: number;
  /** Minimum centre-to-centre distance enforced by the collision constraint. */
  collideRadius: number;
  /** Velocity retained each tick (d3 uses 1 - velocityDecay; here it's the multiplier). */
  velocityDecay: number;
  /** Multiplicative alpha cooling per tick. */
  alphaDecay: number;
  /** Optional pre-pinned positions (e.g. user-dragged nodes), keyed by id. */
  pins?: Map<string, { x: number; y: number }>;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  width: 1400,
  height: 900,
  iterations: 320,
  repulsion: 1600,
  linkDistance: 44,
  linkStrength: 0.12,
  gravity: 0.035,
  guildStrength: 0.35,
  collideRadius: 34,
  velocityDecay: 0.6,
  alphaDecay: 0.0228,
};

/** Below this node count the static ring layout is used instead (fallback). */
export const SMALL_GRAPH_MAX = 8;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad

/**
 * Deterministic per-`source_guild` colour. Pure: same guild → same colour,
 * regardless of order or surrounding data. Empty guild hashes like any other
 * string, so callers always get a stable colour.
 */
export function guildColor(guild: string): string {
  let h = 2166136261;
  const s = guild || "project";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue}, 68%, 55%)`;
}

/**
 * Map each distinct guild to an x-lane centre, evenly spaced across the width.
 * Sorted for determinism. A single guild lands in the middle.
 */
export function assignGuildLanes(guilds: string[], width: number): Map<string, number> {
  const distinct = [...new Set(guilds.map((g) => g || "project"))].sort();
  const lanes = new Map<string, number>();
  const n = distinct.length;
  for (let i = 0; i < n; i++) {
    lanes.set(distinct[i], (width * (i + 1)) / (n + 1));
  }
  return lanes;
}

/** Phyllotaxis-spiral seed positions (deterministic, well-spread initial state). */
export function seedPositions(
  nodes: LayoutInputNode[],
  opts: LayoutOptions,
): LayoutNode[] {
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const spacing = Math.min(opts.width, opts.height) / (2.2 * Math.sqrt(Math.max(nodes.length, 1)));
  return nodes.map((n, i) => {
    const r = spacing * Math.sqrt(i + 0.5);
    const a = i * GOLDEN_ANGLE;
    const guild = n.guild || "project";
    const pin = opts.pins?.get(n.id);
    return {
      id: n.id,
      guild,
      x: pin ? pin.x : cx + r * Math.cos(a),
      y: pin ? pin.y : cy + r * Math.sin(a),
      vx: 0,
      vy: 0,
      pinned: !!pin,
    };
  });
}

/**
 * One simulation tick. Mutates `nodes` velocities/positions in place. Pure with
 * respect to (nodes, edges, lanes, alpha): no globals, no randomness.
 */
export function stepSimulation(
  nodes: LayoutNode[],
  edges: LayoutInputEdge[],
  lanes: Map<string, number>,
  opts: LayoutOptions,
  alpha: number,
): void {
  const cx = opts.width / 2;
  const cy = opts.height / 2;

  // Many-body repulsion (O(n²) — bounded by the caller's node cap).
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 0.01) {
        // Deterministic separation nudge for coincident nodes.
        dx = (i - j) * 0.5 + 0.1;
        dy = (i + j) % 2 === 0 ? 0.1 : -0.1;
        d2 = dx * dx + dy * dy;
      }
      const f = (opts.repulsion * alpha) / d2;
      const fx = dx * f;
      const fy = dy * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Link springs.
  const byId = new Map<string, LayoutNode>();
  for (const n of nodes) byId.set(n.id, n);
  for (const e of edges) {
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) continue;
    let dx = t.x - s.x;
    let dy = t.y - s.y;
    let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const diff = ((d - opts.linkDistance) / d) * opts.linkStrength * alpha;
    const fx = dx * diff;
    const fy = dy * diff;
    s.vx += fx;
    s.vy += fy;
    t.vx -= fx;
    t.vy -= fy;
  }

  // Centring gravity + per-guild x-lane bias, then integrate.
  for (const n of nodes) {
    if (n.pinned) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    const laneX = lanes.get(n.guild);
    if (laneX !== undefined) {
      n.vx += (laneX - n.x) * opts.guildStrength * alpha;
    }
    // Weak x-centring (lanes dominate x), gentle y-centring keeps it on-canvas.
    n.vx += (cx - n.x) * opts.gravity * 0.25 * alpha;
    n.vy += (cy - n.y) * opts.gravity * alpha;

    n.x += n.vx;
    n.y += n.vy;
    n.vx *= opts.velocityDecay;
    n.vy *= opts.velocityDecay;

    // Clamp inside the bounding box.
    if (n.x < 0) n.x = 0;
    else if (n.x > opts.width) n.x = opts.width;
    if (n.y < 0) n.y = 0;
    else if (n.y > opts.height) n.y = opts.height;
  }

  // Collision relaxation — a positional constraint that guarantees a hard
  // minimum centre-to-centre distance, eliminating node overlap. Run after
  // integration so it has the final say. Pinned nodes do not move.
  const minDist = opts.collideRadius * 2;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d >= minDist) continue;
      if (d < 1e-6) {
        dx = (i - j) || 1;
        dy = (i + j) % 2 === 0 ? 1 : -1;
        d = Math.sqrt(dx * dx + dy * dy);
      }
      const push = (minDist - d) / d / 2;
      const ox = dx * push;
      const oy = dy * push;
      if (!a.pinned) {
        a.x += ox;
        a.y += oy;
      }
      if (!b.pinned) {
        b.x -= ox;
        b.y -= oy;
      }
    }
  }
}

/** Seed + run the full simulation, returning the converged positions. */
export function runForceLayout(
  nodes: LayoutInputNode[],
  edges: LayoutInputEdge[],
  options: Partial<LayoutOptions> = {},
): LayoutNode[] {
  const opts: LayoutOptions = { ...DEFAULT_LAYOUT_OPTIONS, ...options };
  const sim = seedPositions(nodes, opts);
  const lanes = assignGuildLanes(
    nodes.map((n) => n.guild || "project"),
    opts.width,
  );
  let alpha = 1;
  for (let i = 0; i < opts.iterations; i++) {
    stepSimulation(sim, edges, lanes, opts, alpha);
    alpha *= 1 - opts.alphaDecay;
  }
  return sim;
}

/**
 * Fraction of node pairs whose axis-aligned bounding boxes (side = 2*radius,
 * i.e. the visual node footprint) overlap. Pure metric used by the gate.
 */
export function overlapRatio(
  nodes: Array<{ x: number; y: number }>,
  radius: number,
): number {
  const n = nodes.length;
  if (n < 2) return 0;
  const side = radius * 2;
  let overlapping = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        Math.abs(nodes[i].x - nodes[j].x) < side &&
        Math.abs(nodes[i].y - nodes[j].y) < side
      ) {
        overlapping++;
      }
    }
  }
  return overlapping / ((n * (n - 1)) / 2);
}

/**
 * The legacy static ring layout, extracted as a pure function. Mirrors the
 * original `buildGraphLayout` ring placement. Retained for the small-graph
 * fallback AND as the anti-vacuity baseline (it overlaps badly at scale).
 */
export function legacyRingLayout(
  nodes: LayoutInputNode[],
  isModule: (id: string) => boolean = () => false,
): Array<{ id: string; x: number; y: number }> {
  const center = { x: 460, y: 280 };
  const ids = nodes.map((n) => n.id);
  const modules = ids.filter(isModule);
  const others = ids.filter((id) => !isModule(id));
  const out: Array<{ id: string; x: number; y: number }> = [];

  for (let index = 0; index < modules.length; index++) {
    const angle = (Math.PI * 2 * index) / Math.max(modules.length, 1) - Math.PI / 2;
    out.push({
      id: modules[index],
      x: center.x + Math.cos(angle) * 120,
      y: center.y + Math.sin(angle) * 95,
    });
  }
  const rings = Math.max(1, Math.ceil(others.length / 72));
  for (let index = 0; index < others.length; index++) {
    const ring = Math.floor((index / Math.max(others.length, 1)) * rings);
    const localIndex = index - Math.floor((others.length / rings) * ring);
    const ringCount = Math.max(1, Math.ceil(others.length / rings));
    const angle = (Math.PI * 2 * localIndex) / ringCount + ring * 0.34;
    const rx = 225 + ring * 76;
    const ry = 140 + ring * 48;
    out.push({
      id: others[index],
      x: center.x + Math.cos(angle) * rx,
      y: center.y + Math.sin(angle) * ry,
    });
  }
  return out;
}

/**
 * Drag reducer: returns a new node array with `id` moved to (x,y) and pinned.
 * Pure (no mutation of the input array entries). Used by the canvas pointer
 * drag so a dragged node sticks where the user drops it.
 */
export function pinNode(
  nodes: LayoutNode[],
  id: string,
  x: number,
  y: number,
): LayoutNode[] {
  return nodes.map((n) =>
    n.id === id ? { ...n, x, y, vx: 0, vy: 0, pinned: true } : n,
  );
}

// ---- View transform (zoom / pan) reducers ---------------------------------

export interface ViewTransform {
  x: number;
  y: number;
  k: number;
}

export const IDENTITY_TRANSFORM: ViewTransform = { x: 0, y: 0, k: 1 };

/** Pan by a screen-space delta. Pure. */
export function panTransform(t: ViewTransform, dx: number, dy: number): ViewTransform {
  return { x: t.x + dx, y: t.y + dy, k: t.k };
}

/**
 * Zoom by `factor` around a fixed screen point (cx, cy) so the point under the
 * cursor stays put. Pure; clamps scale to [minK, maxK].
 */
export function zoomTransform(
  t: ViewTransform,
  factor: number,
  cx: number,
  cy: number,
  minK = 0.2,
  maxK = 4,
): ViewTransform {
  const k = Math.min(maxK, Math.max(minK, t.k * factor));
  const ratio = k / t.k;
  // Keep (cx,cy) anchored: world point under cursor is unchanged.
  return {
    x: cx - (cx - t.x) * ratio,
    y: cy - (cy - t.y) * ratio,
    k,
  };
}

/** Convert a screen point to world (layout) coordinates under a transform. */
export function screenToWorld(
  t: ViewTransform,
  sx: number,
  sy: number,
): { x: number; y: number } {
  return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
}
