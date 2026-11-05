// Response shapes of POST /api/project/metrics/{report,drilldown,analysis,compare}
// (src/c9/metric-report.ts, src/c9/metric-series.ts). Shapes only: the UI
// renders these values and never recomputes them.

export interface Coverage {
  eligible: number | null;
  covered: number;
  excluded: number;
  missing: number | null;
  state: "complete" | "partial" | "unavailable";
  reason: string | null;
  exclusion_reasons: { code: string; count: number }[];
}

export interface Evidence {
  source_id: string;
  path: string;
  sha256: string;
  schema_version: string;
  observed_at: string;
  availability: string;
  reason: string | null;
}

export interface SeriesPoint {
  key: string;
  value: number | null;
  known_subtotal: number | null;
  exact_total: number | null;
  numerator: number | null;
  denominator: number | null;
  coverage: Coverage;
  cost_basis: string;
  reason: string | null;
  evidence: Evidence[];
  drilldown: { query_hash: string; cursor: string | null };
}

export interface QueryFilter {
  dimension: string;
  values: string[];
}

export interface QueryIdentity {
  snapshot: { input_manifest_digest: string; as_of: string; source_ids: string[] };
  filters: QueryFilter[];
  window: { from: string; to: string; basis: string; timezone: string };
  versions: Record<string, string>;
  [k: string]: unknown;
}

interface MetricText {
  metric_id: string;
  name: string;
  formula: string;
  scope: string;
  missingness: string;
  unit: string;
  formula_version: string;
}

export interface ServedEntry extends MetricText {
  state: "served";
  unit_label: string;
  query_hash: string;
  query: QueryIdentity;
  window_basis: string;
  usage_semantics: string;
  pricing: { version: string; currency: string; source_hash: string } | null;
  cost_bases: string[];
  coverage: Coverage;
  points: SeriesPoint[];
}

export interface RefusedEntry extends MetricText {
  state: "refused";
  refusal: { code: string; message: string };
}

export type ReportEntry = ServedEntry | RefusedEntry;

export interface ReportSource {
  source_id: string;
  names: string[];
  state: "available" | "unavailable";
  reason: string | null;
  runs: number;
  run_errors: { run_id: string; reason: string }[];
}

export interface MetricReport {
  schema_version: string;
  generator_version: string;
  snapshot: { input_manifest_digest: string; as_of: string; source_ids: string[] };
  scope: { filters: QueryFilter[]; window: { from: string; to: string; timezone: string }; grain: string; group_by: string };
  sources: ReportSource[];
  omissions: string[];
  metrics: ReportEntry[];
  report_hash: string;
}

export interface Drilldown {
  metric_id: string;
  point_key: string;
  query_hash: string;
  records: Evidence[];
  coverage: Coverage;
  next_cursor: string | null;
}

export interface Ranking {
  ranked: boolean;
  reason: string | null;
  direction: "asc" | "desc";
  strata: { difficulty: string; entries: { key: string; value: number; rank: number }[] }[];
  unranked: { key: string; value: number | null; reason: string }[];
}

export interface CohortSide {
  key: string;
  value: number | null;
  coverage: Coverage;
  cost_basis: string;
}

export interface CohortComparison {
  compatible: boolean;
  incompatibilities: string[];
  label: "descriptive_only" | "refused";
  causal: false;
  statement: string;
  a: CohortSide | null;
  b: CohortSide | null;
  difference: number | null;
  difference_reason: string | null;
  unit: string;
}

export interface Refusal {
  schema_version: "guild.stack.refusal.v2";
  code: string;
  message: string;
}
