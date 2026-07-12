// architecture.ts — G12 importance-scale math (dependency-free, pure).
//
// The importance heatmap encodes a node's centrality/importance as a node
// RADIUS and a discrete colour BUCKET. Every function here is a PURE function of
// (value, scale) so the validation gate can assert the encoding is MONOTONIC in
// the input value (a degree-20 node maps to a strictly larger radius and a
// strictly higher colour bucket than a degree-2 node) rather than eyeballing a
// render. The graph-shaped grouping (degree computation, layer/cluster joins by
// composite `(source_guild,id)`) lives next to the other KG helpers in
// KnowledgePage.tsx; this module owns only the scalar scale math.
//
// Degenerate input (all values equal ⇒ `max === min`) is handled explicitly so
// there is never a divide-by-zero or a NaN radius: the span guard returns
// fraction 0 and the legend collapses to a single bucket.

/** Visual node-radius range (px) the importance fraction maps onto. */
export const MIN_RADIUS = 5;
export const MAX_RADIUS = 20;

/** Number of discrete colour buckets in the (non-degenerate) heatmap scale. */
export const HEATMAP_BUCKETS = 5;

export interface ImportanceScale {
  /** Minimum importance value across the encoded node set. */
  min: number;
  /** Maximum importance value across the encoded node set. */
  max: number;
  /** Discrete colour-bucket count (the non-degenerate bucket cardinality). */
  buckets: number;
}

/**
 * Build a scale from a set of importance values. Empty input yields a degenerate
 * `0..0` scale (callers render a single-bucket legend, no crash). Non-finite
 * values are ignored so a stray NaN/Infinity can never poison the bounds.
 */
export function buildImportanceScale(
  values: number[],
  buckets: number = HEATMAP_BUCKETS,
): ImportanceScale {
  const b = Number.isFinite(buckets) && buckets >= 1 ? Math.floor(buckets) : HEATMAP_BUCKETS;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0, buckets: b };
  return { min, max, buckets: b };
}

/** True when the scale has zero span (all values equal / a single value). */
export function isDegenerate(scale: ImportanceScale): boolean {
  return !(scale.max > scale.min);
}

/**
 * Normalised position of `value` within the scale, clamped to [0,1]. Degenerate
 * scales (zero span) return 0 — no divide-by-zero, no NaN. Strictly increasing
 * in `value` across the scale's span (the monotonicity the gate asserts).
 */
export function importanceFraction(value: number, scale: ImportanceScale): number {
  const span = scale.max - scale.min;
  if (!(span > 0)) return 0;
  if (!Number.isFinite(value)) return 0;
  const f = (value - scale.min) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Map an importance value to a node radius in [MIN_RADIUS, MAX_RADIUS].
 * Monotonic non-decreasing in `value`; strictly increasing across the span.
 */
export function importanceRadius(value: number, scale: ImportanceScale): number {
  return MIN_RADIUS + importanceFraction(value, scale) * (MAX_RADIUS - MIN_RADIUS);
}

/**
 * Map an importance value to a discrete colour bucket in `[0, buckets-1]`.
 * Monotonic non-decreasing in `value`; the top of the span lands in the highest
 * bucket. Degenerate scales collapse every value to bucket 0.
 */
export function importanceBucket(value: number, scale: ImportanceScale): number {
  const f = importanceFraction(value, scale);
  const b = Math.floor(f * scale.buckets);
  if (b >= scale.buckets) return scale.buckets - 1;
  return b < 0 ? 0 : b;
}

/**
 * Sequential colour for a bucket: cool (low importance) → warm (high). Pure and
 * monotonic in `bucket` (hue strictly decreases as the bucket rises, so warmer =
 * more important). Guarded so a single-bucket scale never divides by zero.
 */
export function importanceColor(bucket: number, buckets: number): string {
  const denom = Math.max(1, buckets - 1);
  const clamped = bucket < 0 ? 0 : bucket > denom ? denom : bucket;
  const t = clamped / denom;
  const hue = 220 - t * 220; // 220 (blue) → 0 (red)
  return `hsl(${Math.round(hue)}, 70%, 50%)`;
}

export interface ImportanceLegendEntry {
  bucket: number;
  color: string;
  /** Inclusive lower bound of the value range this bucket covers. */
  lo: number;
  /** Upper bound of the value range this bucket covers. */
  hi: number;
}

/**
 * Build the legend rows for the importance scale. A degenerate (all-equal) scale
 * collapses to a SINGLE bucket spanning the lone value — satisfying the gate's
 * "all-equal graph renders with one bucket (no divide-by-zero / NaN)" check.
 */
export function buildImportanceLegend(scale: ImportanceScale): ImportanceLegendEntry[] {
  const span = scale.max - scale.min;
  if (!(span > 0)) {
    return [{ bucket: 0, color: importanceColor(0, scale.buckets), lo: scale.min, hi: scale.max }];
  }
  const out: ImportanceLegendEntry[] = [];
  for (let b = 0; b < scale.buckets; b++) {
    out.push({
      bucket: b,
      color: importanceColor(b, scale.buckets),
      lo: scale.min + (span * b) / scale.buckets,
      hi: scale.min + (span * (b + 1)) / scale.buckets,
    });
  }
  return out;
}
