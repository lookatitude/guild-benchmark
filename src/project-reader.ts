// project-reader.ts — read-only access into a live Guild project's
// knowledge artifacts (.guild/wiki/** + .guild/indexes/knowledge-graph.json).
//
// SC-12 / G-17 (v2-gap-closure): `serve --project-root <abs>` mounts the
// /api/project/* routes on top of this module. Contract pinned in
// `.guild/spec/v2-gap-closure.md §The cross-repo dashboard contract`.
//
// Invariants:
//   - READ-ONLY. This module never writes anywhere, and never copies child
//     artifacts up to the workspace root (docs/v2/04 invariant).
//   - Zero plugin imports (telemetry split) — files are read by format only.
//   - Workspace-aware (codex G-plan finding #3): when
//     `<root>/.guild/workspace.json` (guild.workspace.v1) exists, federate
//     across `sub_guilds` read-only and tag every page/node/edge with
//     `source_guild`. A plain project root reads its own `.guild/` directly
//     with `source_guild = "project"`.
//   - Lenient readers: workspace.json and knowledge-graph.json are accepted
//     when they are "shape-like" ({nodes,edges}-ish); unknown fields pass
//     through untouched.
//   - Path traversal on wiki page reads is rejected with the same
//     safeJoinUnder pattern server.ts uses for artifacts.

import { constants as fsConstants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { open, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { readContainedRegularFile } from "./safe-read.js";
import { SeriesRefusal, queryHash, refusal, validateReadRequestV2, type GroupBy, type QueryFilter, type RefusalV2 } from "./c9/metric-series.js";
import { evaluationReport, openProjectSnapshot, projectQuery, readMetricDrilldown, readMetricSeries, readRequest, type ProjectQuerySpec, type ProjectSnapshot } from "./c9/project-read.js";
import { TRACE_ID_RE, isRfc3339 } from "./c9/trace-analysis.js";
import { canonicalSourceId } from "./c9/source-identity.js";

export const WORKSPACE_JSON_MAX_BYTES = 1024 * 1024;

// D01 — freshness comes ONLY from the packaged producer's inspect transport
// (D00). No plugin source import; no hash/detector reimplementation.
import {
  inspectArtifact,
  isSafeAnalysisId,
  type InspectKind,
  type InspectOutcome,
  type PackagedRuntime,
} from "./analysis-process.js";

// Response shapes live in types.ts next to every other HTTP contract the UI
// imports (see types.ts §"live-project knowledge routes").
import type {
  ProjectAnalysisAction,
  AnalysisArtifactFreshness,
  AnalysisArtifactSummary,
  AnalysisArtifactValidation,
  GuildRecommendationMirror,
  ProjectAnalysisArtifactDetailResponse,
  ProjectAnalysisArtifactsResponse,
  ProjectKnowledgeGraphResponse,
  ProjectAnalysisRequest,
  ProjectAnalysisResponse,
  ProjectComparisonResponse,
  ProjectComparisonTarget,
  ProjectComparisonTargetsResponse,
  ProjectInitiativeSummary,
  ProjectInitiativesResponse,
  ProjectOverviewResponse,
  ProjectOverviewSource,
  ProjectRunDetailResponse,
  ProjectRunListRow,
  ProjectRunsListResponse,
  ProjectSource,
  ProjectWikiListResponse,
  ProjectWikiPageResponse,
  WikiPageSummary,
} from "./types.js";

// Tagged error so the route layer can map reader failures onto HTTP codes
// without string-matching messages.
export type ProjectReadErrorKind =
  | "not_found" // missing file/dir → 404
  | "bad_request" // traversal, missing/ambiguous params → 400
  | "ambiguous_guild"; // workspace mode, >1 wiki source, no &guild= → 400

export class ProjectReadError extends Error {
  kind: ProjectReadErrorKind;
  constructor(kind: ProjectReadErrorKind, message: string) {
    super(message);
    this.name = "ProjectReadError";
    this.kind = kind;
  }
}

// ---- guild-source resolution ----------------------------------------------

export interface GuildSource {
  /** sub-guild name (workspace mode) or "project" (plain root). */
  name: string;
  /** absolute path of the guild's repo root. */
  root: string;
  /** absolute `.guild/wiki` or root docs/knowledge dir — present only when it exists on disk. */
  wikiRoot?: string;
  /** distinguishes project-local wiki pages from workspace canonical docs. */
  wikiKind?: "wiki" | "docs-knowledge";
  /** absolute knowledge-graph.json — present only when it exists on disk. */
  kgPath?: string;
  /** graph-like index path. Falls back to codebase-map.json when no knowledge graph exists. */
  graphPath?: string;
  graphKind?: "knowledge-graph" | "codebase-map";
  /** absolute `.guild/runs` dir — present only when it exists on disk. */
  runsRoot?: string;
  /** absolute `.guild/initiatives` dir — present only when it exists on disk. */
  initiativesRoot?: string;
}

interface WorkspaceSubGuildLike {
  name?: unknown;
  path?: unknown;
  has_wiki?: unknown;
  has_indexes?: unknown;
}

/**
 * Resolve the set of guild sources under a project root.
 *
 * Workspace mode: `<root>/.guild/workspace.json` exists AND parses to an
 * object with a `sub_guilds` array (lenient — any other field is ignored).
 * Each entry contributes a source when its `name` + `path` are strings;
 * wikiRoot is attached when `has_wiki` is truthy OR the dir exists on disk,
 * kgPath when the child index file exists.
 *
 * Plain mode: single source named "project" pointing at the root itself.
 */
export async function resolveGuildSources(projectRoot: string): Promise<GuildSource[]> {
  const root = resolve(projectRoot);
  const workspacePath = join(root, ".guild", "workspace.json");
  if (existsSync(workspacePath)) {
    // Bounded no-follow regular-file read contained in the project root: a
    // symlinked, oversized, or non-regular (FIFO) workspace.json is ignored.
    let parsed: unknown;
    let rootReal: string | undefined;
    try {
      rootReal = realpathSync(root);
    } catch {
      rootReal = undefined;
    }
    const read = rootReal
      ? await readContainedRegularFile(workspacePath, WORKSPACE_JSON_MAX_BYTES, rootReal)
      : undefined;
    try {
      parsed = read ? JSON.parse(read.text) : undefined;
    } catch {
      parsed = undefined;
    }
    const subGuilds =
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { sub_guilds?: unknown }).sub_guilds)
        ? ((parsed as { sub_guilds: unknown[] }).sub_guilds as WorkspaceSubGuildLike[])
        : undefined;
    if (subGuilds) {
      const sources: GuildSource[] = [];
      const workspaceSource = makeSource("workspace", root, {
        includeDocsKnowledge: (parsed as { workspace_knowledge?: unknown }).workspace_knowledge === true,
      });
      if (sourceHasContent(workspaceSource)) sources.push(workspaceSource);
      for (const sg of subGuilds) {
        if (typeof sg?.name !== "string" || typeof sg?.path !== "string") continue;
        const childRoot = resolve(root, sg.path);
        if (!isUnder(root, childRoot)) continue;
        const source = makeSource(sg.name, childRoot);
        sources.push(source);
      }
      return sources;
    }
    // workspace.json exists but is malformed / sub_guilds missing —
    // fall through to plain-root behavior (lenient reader).
  }
  return [makeSource("project", root, { includeDocsKnowledge: existsSync(join(root, "docs", "knowledge")) })];
}

function makeSource(
  name: string,
  root: string,
  opts: { includeDocsKnowledge?: boolean } = {},
): GuildSource {
  const wikiRoot = join(root, ".guild", "wiki");
  const docsKnowledgeRoot = join(root, "docs", "knowledge");
  const runsRoot = join(root, ".guild", "runs");
  const initiativesRoot = join(root, ".guild", "initiatives");
  const kgPath = join(root, ".guild", "indexes", "knowledge-graph.json");
  const codebaseMapPath = join(root, ".guild", "indexes", "codebase-map.json");
  const hasWiki = existsSync(wikiRoot);
  const hasDocsKnowledge = opts.includeDocsKnowledge === true && existsSync(docsKnowledgeRoot);
  const graphPath = existsSync(kgPath)
    ? kgPath
    : existsSync(codebaseMapPath)
      ? codebaseMapPath
      : undefined;
  const graphKind = graphPath === kgPath ? "knowledge-graph" : graphPath ? "codebase-map" : undefined;
  return {
    name,
    root,
    ...(hasWiki
      ? { wikiRoot, wikiKind: "wiki" as const }
      : hasDocsKnowledge
        ? { wikiRoot: docsKnowledgeRoot, wikiKind: "docs-knowledge" as const }
        : {}),
    ...(existsSync(runsRoot) ? { runsRoot } : {}),
    ...(existsSync(initiativesRoot) ? { initiativesRoot } : {}),
    ...(existsSync(kgPath) ? { kgPath } : {}),
    ...(graphPath && graphKind ? { graphPath, graphKind } : {}),
  };
}

function sourceHasContent(source: GuildSource): boolean {
  return Boolean(source.wikiRoot || source.graphPath || source.runsRoot || source.initiativesRoot);
}

function isUnder(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---- knowledge graph -------------------------------------------------------

/**
 * Lenient KG reader: accepts any JSON object; `nodes` / `edges` arrays are
 * taken when present (non-object entries are dropped); unknown fields on each
 * node/edge pass through untouched. Every node/edge is tagged with
 * `source_guild`.
 *
 * Returns an empty graph when no source has either a knowledge graph or a
 * codebase map. Dashboard callers should render that as a known empty state.
 */
export async function readProjectKnowledgeGraph(
  projectRoot: string,
): Promise<ProjectKnowledgeGraphResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const withGraph = sources.filter((s) => s.graphPath);
  if (withGraph.length === 0) {
    return {
      nodes: [],
      edges: [],
      sources: [],
      empty_reason: "no knowledge graph or codebase map found under the project root",
    };
  }
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const out: ProjectSource[] = [];
  for (const src of withGraph) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(src.graphPath!, "utf8"));
    } catch {
      // Unreadable / non-JSON index — skip the source rather than failing
      // the whole federated view (lenient reader).
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    if (src.graphKind === "codebase-map") {
      const converted = codebaseMapToGraph(parsed, src.name);
      nodes.push(...converted.nodes);
      edges.push(...converted.edges);
    } else {
      const graph = parsed as { nodes?: unknown; edges?: unknown };
      for (const n of Array.isArray(graph.nodes) ? graph.nodes : []) {
        if (n !== null && typeof n === "object" && !Array.isArray(n)) {
          nodes.push({ ...(n as Record<string, unknown>), source_guild: src.name });
        }
      }
      for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
        if (e !== null && typeof e === "object" && !Array.isArray(e)) {
          edges.push({ ...(e as Record<string, unknown>), source_guild: src.name });
        }
      }
    }
    out.push({ guild: src.name, path: src.graphPath!, kind: src.graphKind });
  }
  if (out.length === 0) {
    return {
      nodes: [],
      edges: [],
      sources: [],
      empty_reason: "no readable knowledge graph or codebase map found under the project root",
    };
  }
  return { nodes, edges, sources: out };
}

function codebaseMapToGraph(
  parsed: unknown,
  guild: string,
): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const files =
    parsed !== null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { files?: unknown }).files)
      ? (parsed as { files: unknown[] }).files
      : [];
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const modules = new Set<string>();
  for (const item of files) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const file = item as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : undefined;
    if (!path) continue;
    const module = typeof file.module === "string" && file.module ? file.module : "(root)";
    if (!modules.has(module)) {
      modules.add(module);
      nodes.push({
        id: `${guild}:module:${module}`,
        type: "module",
        name: module,
        source_guild: guild,
      });
    }
    nodes.push({
      id: `${guild}:file:${path}`,
      type: "file",
      name: basename(path),
      path,
      module,
      source_guild: guild,
      ...(typeof file.language === "string" ? { language: file.language } : {}),
      ...(typeof file.loc === "number" ? { loc: file.loc } : {}),
      ...(typeof file.complexity === "number" ? { complexity: file.complexity } : {}),
      ...(typeof file.is_entrypoint === "boolean" ? { is_entrypoint: file.is_entrypoint } : {}),
    });
    edges.push({
      id: `${guild}:contains:${module}:${path}`,
      type: "contains",
      source: `${guild}:module:${module}`,
      target: `${guild}:file:${path}`,
      source_guild: guild,
    });
  }
  return { nodes, edges };
}

// ---- project overview + runs ----------------------------------------------

export async function getProjectOverview(projectRoot: string): Promise<ProjectOverviewResponse> {
  const root = resolve(projectRoot);
  const sources = await resolveGuildSources(root);
  const graph = await readProjectKnowledgeGraph(root);
  const overviewSources: ProjectOverviewSource[] = [];
  let runs = 0;
  let initiatives = 0;
  let wikiPages = 0;
  for (const source of sources) {
    const runCount = source.runsRoot ? (await listRunDirs(source.runsRoot)).length : 0;
    const initiativeCount = source.initiativesRoot
      ? (await listInitiativeDirs(source.initiativesRoot)).length
      : 0;
    const wikiCount = source.wikiRoot ? (await walkMarkdownFiles(source.wikiRoot)).length : 0;
    runs += runCount;
    initiatives += initiativeCount;
    wikiPages += wikiCount;
    overviewSources.push({
      guild: source.name,
      root: source.root,
      has_runs: Boolean(source.runsRoot),
      has_wiki: Boolean(source.wikiRoot),
      has_graph: Boolean(source.graphPath),
      has_initiatives: Boolean(source.initiativesRoot),
      ...(source.graphKind ? { graph_kind: source.graphKind } : {}),
      run_count: runCount,
      wiki_count: wikiCount,
      initiative_count: initiativeCount,
    });
  }
  return {
    project_root: root,
    mode: sources.some((s) => s.name === "workspace") ? "workspace" : "project",
    sources: overviewSources,
    totals: {
      runs,
      initiatives,
      wiki_pages: wikiPages,
      graph_nodes: graph.nodes.length,
      graph_edges: graph.edges.length,
    },
  };
}

export async function listProjectRuns(projectRoot: string): Promise<ProjectRunsListResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const rows: ProjectRunListRow[] = [];
  const outSources: ProjectSource[] = [];
  for (const source of sources) {
    if (!source.runsRoot) continue;
    outSources.push({ guild: source.name, path: source.runsRoot, kind: "runs" });
    const dirs = await listRunDirs(source.runsRoot);
    for (const dir of dirs) {
      const row = await readRunRow(source, dir);
      if (row) rows.push(row);
    }
  }
  rows.sort(compareRunRows);
  return { runs: rows, total: rows.length, sources: outSources };
}

export async function listProjectInitiatives(
  projectRoot: string,
): Promise<ProjectInitiativesResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const runs = await listProjectRuns(projectRoot);
  const rows: ProjectInitiativeSummary[] = [];
  const outSources: ProjectSource[] = [];
  for (const source of sources) {
    if (!source.initiativesRoot) continue;
    outSources.push({ guild: source.name, path: source.initiativesRoot, kind: "initiatives" });
    const dirs = await listInitiativeDirs(source.initiativesRoot);
    for (const dir of dirs) {
      const row = await readInitiativeRow(source, dir, runs.runs);
      if (row) rows.push(row);
    }
  }
  rows.sort((a, b) =>
    a.source_guild === b.source_guild
      ? a.id.localeCompare(b.id)
      : sourceRankName(a.source_guild) - sourceRankName(b.source_guild) ||
        a.source_guild.localeCompare(b.source_guild),
  );
  return { initiatives: rows, total: rows.length, sources: outSources };
}

export async function listProjectComparisonTargets(
  projectRoot: string,
): Promise<ProjectComparisonTargetsResponse> {
  const [runs, initiatives] = await Promise.all([
    listProjectRuns(projectRoot),
    listProjectInitiatives(projectRoot),
  ]);
  const targets: ProjectComparisonTarget[] = [];
  for (const run of runs.runs) {
    if (!run.comparison_eligible) continue;
    targets.push({
      id: targetId("run", run.source_guild, run.run_id),
      kind: "run",
      source_guild: run.source_guild,
      label: `${run.source_guild} · ${run.run_id}`,
      run_ids: [run.run_id],
      run_count: 1,
      comparison_eligible: true,
      reasons: run.comparison_reasons ?? [],
    });
  }
  for (const initiative of initiatives.initiatives) {
    if (!initiative.comparison_eligible) continue;
    targets.push({
      id: targetId("initiative", initiative.source_guild, initiative.id),
      kind: "initiative",
      source_guild: initiative.source_guild,
      label: `${initiative.source_guild} · ${initiative.title ?? initiative.id}`,
      run_ids: initiative.eligible_run_ids,
      run_count: initiative.eligible_run_ids.length,
      comparison_eligible: true,
      reasons: initiative.comparison_reasons,
    });
  }
  targets.sort((a, b) =>
    a.kind === b.kind
      ? sourceRankName(a.source_guild) - sourceRankName(b.source_guild) ||
        a.label.localeCompare(b.label)
      : a.kind === "initiative"
        ? -1
        : 1,
  );
  return {
    targets,
    total: targets.length,
    sources: [
      ...runs.sources,
      ...initiatives.sources,
    ],
  };
}

export async function compareProjectTargets(
  projectRoot: string,
  baselineId: string,
  candidateId: string,
): Promise<ProjectComparisonResponse> {
  const [runs, targets] = await Promise.all([
    listProjectRuns(projectRoot),
    listProjectComparisonTargets(projectRoot),
  ]);
  const baseline = targets.targets.find((target) => target.id === baselineId);
  const candidate = targets.targets.find((target) => target.id === candidateId);
  if (!baseline) throw new ProjectReadError("not_found", `comparison target not found: ${baselineId}`);
  if (!candidate) throw new ProjectReadError("not_found", `comparison target not found: ${candidateId}`);
  const baselineSummary = summarizeProjectTarget(baseline, runs.runs);
  const candidateSummary = summarizeProjectTarget(candidate, runs.runs);
  const status =
    baseline.kind !== candidate.kind
      ? "kind_mismatch"
      : baseline.run_count === 0 || candidate.run_count === 0
        ? "no_comparable_runs"
        : "ok";
  return {
    baseline: baselineSummary,
    candidate: candidateSummary,
    status,
    generated_at: new Date().toISOString(),
    notes: buildComparisonNotes(baselineSummary, candidateSummary, status),
  };
}

export async function analyzeProjectTarget(
  projectRoot: string,
  req: ProjectAnalysisRequest,
  runtime?: PackagedRuntime,
): Promise<ProjectAnalysisResponse> {
  const targets = await listProjectComparisonTargets(projectRoot);
  const expectedId = req.target_id.includes(":")
    ? req.target_id
    : req.source_guild
      ? targetId(req.target_kind, req.source_guild, req.target_id)
      : undefined;
  const target = targets.targets.find(
    (candidate) =>
      candidate.kind === req.target_kind &&
      (candidate.id === expectedId || candidate.id === req.target_id),
  );
  if (!target) throw new ProjectReadError("not_found", `analysis target not found: ${req.target_id}`);
  const runs = await listProjectRuns(projectRoot);
  const targetRuns = runs.runs.filter(
    (run) => run.source_guild === target.source_guild && target.run_ids.includes(run.run_id),
  );
  const signals = buildAnalysisSignals(target, targetRuns);
  // D03: producer-authoritative freshness feeds the decide descriptor's
  // enablement when a runtime is configured; without one the descriptor
  // stays disabled (never silently enabled).
  let inspectOutcome: InspectOutcome | undefined;
  if (target.kind === "run" && target.run_ids.length === 1) {
    const sources = await resolveGuildSources(projectRoot);
    const owner = sources.find((s) => s.name === target.source_guild);
    if (owner) {
      inspectOutcome = await inspectArtifact(runtime, owner.root, "run", target.run_ids[0]);
    }
  }
  return {
    target,
    signals,
    actions: buildAnalysisActions(target, inspectOutcome),
  };
}

export async function readProjectRun(
  projectRoot: string,
  runId: string,
  guildName?: string,
): Promise<ProjectRunDetailResponse> {
  if (!isSafeRunId(runId)) {
    throw new ProjectReadError("bad_request", "invalid run_id");
  }
  const run = await resolveProjectRunRow(projectRoot, runId, guildName);
  const runYaml = await readMaybeYaml(join(run.path, "run.yaml"));
  const provenance = await readMaybeJson(join(run.path, "provenance.json"));
  const tracePath = pickTracePath(run.path);
  const tracePreview = tracePath ? await readJsonlPreview(tracePath, 50) : [];
  const eventCount = tracePath ? await countJsonlEvents(tracePath) : 0;
  return {
    run,
    ...(runYaml !== undefined ? { run_yaml: runYaml } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    event_count: eventCount,
    trace_preview: tracePreview,
  };
}

async function resolveProjectRunRow(
  projectRoot: string,
  runId: string,
  guildName?: string,
): Promise<ProjectRunListRow> {
  const list = await listProjectRuns(projectRoot);
  const matches = list.runs.filter(
    (run) => run.run_id === runId && (!guildName || run.source_guild === guildName),
  );
  if (matches.length === 0) {
    throw new ProjectReadError("not_found", `run not found: ${runId}`);
  }
  if (matches.length > 1) {
    throw new ProjectReadError(
      "ambiguous_guild",
      "guild query parameter is required when multiple sources contain the same run_id",
    );
  }
  return matches[0];
}

/**
 * Read one file under a live project run's directory (E01-AC3 followup).
 * `segments` are the already-decoded path segments. Fail closed: any empty,
 * `.`/`..`, slash/backslash/NUL-bearing segment, a scheme/drive-like first
 * segment, a run directory reached through a symlink, or a realpath outside
 * the run directory (symlink escape) is refused; an unknown run is not_found.
 */
export async function readProjectRunArtifact(
  projectRoot: string,
  runId: string,
  segments: readonly string[],
  guildName?: string,
): Promise<{ path: string; body: Buffer }> {
  if (!isSafeRunId(runId)) {
    throw new ProjectReadError("bad_request", "invalid run_id");
  }
  if (
    segments.length === 0 ||
    segments.some((seg) => seg === "" || seg === "." || seg === ".." || /[\\/\0]/.test(seg)) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(segments[0])
  ) {
    throw new ProjectReadError("bad_request", "artifact path refused");
  }
  const run = await resolveProjectRunRow(projectRoot, runId, guildName);
  let rootReal: string;
  let runReal: string;
  let targetReal: string;
  try {
    rootReal = realpathSync(projectRoot);
    runReal = realpathSync(run.path);
    targetReal = realpathSync(join(run.path, ...segments));
  } catch {
    throw new ProjectReadError("not_found", "artifact not found");
  }
  // The run directory must sit physically where it sits lexically under the
  // project root: a symlinked `.guild/runs`, sub-guild, or run dir is refused.
  if (runReal !== resolve(rootReal, relative(resolve(projectRoot), run.path))) {
    throw new ProjectReadError("bad_request", "run directory escapes the project root");
  }
  const rel = relative(runReal, targetReal);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ProjectReadError("bad_request", "artifact path escapes the run directory");
  }
  // Open without following a final symlink, then confirm the lexical path
  // still resolves to the same contained inode, so a component swapped to a
  // symlink between the check and the open is refused.
  let handle;
  try {
    handle = await open(targetReal, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new ProjectReadError("bad_request", "artifact path escapes the run directory");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new ProjectReadError("not_found", "artifact not found");
    let again: string;
    try {
      again = realpathSync(join(run.path, ...segments));
    } catch {
      throw new ProjectReadError("bad_request", "artifact path escapes the run directory");
    }
    const current = statSync(again);
    if (again !== targetReal || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new ProjectReadError("bad_request", "artifact path escapes the run directory");
    }
    return { path: segments.join("/"), body: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function listRunDirs(runsRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "_compare")
    .map((entry) => join(runsRoot, entry.name));
}

async function readRunRow(source: GuildSource, dir: string): Promise<ProjectRunListRow | null> {
  const runYaml = await readMaybeYaml(join(dir, "run.yaml"));
  const provenance = await readMaybeJson(join(dir, "provenance.json"));
  const runState = await readMaybeJson(join(dir, "run-state.json"));
  const runObject = asObject(runYaml);
  const provenanceObject = asObject(provenance);
  const stateObject = asObject(runState);
  const runId =
    stringField(runObject, "run_id") ??
    stringField(provenanceObject, "run_id") ??
    stringField(stateObject, "run_id") ??
    basename(dir);
  if (!isSafeRunId(runId)) return null;
  const tracePath = pickTracePath(dir);
  const eventCount = tracePath ? await countJsonlEvents(tracePath) : 0;
  const initiativeId =
    stringField(runObject, "initiative_attachment") ??
    stringField(runObject, "initiative_id") ??
    stringField(provenanceObject, "initiative");
  const explicitEligible =
    typeof provenanceObject?.benchmark_eligible === "boolean"
      ? provenanceObject.benchmark_eligible
      : undefined;
  const comparisonReasons = runComparisonReasons({
    hasTrace: Boolean(tracePath),
    hasProvenance: provenance !== undefined,
    hasRunYaml: runYaml !== undefined,
    benchmarkEligible: explicitEligible,
    eventCount,
  });
  return {
    run_id: runId,
    source_guild: source.name,
    ...(stringField(runObject, "command") ? { command: stringField(runObject, "command") } : {}),
    ...(stringField(provenanceObject, "status") ?? stringField(stateObject, "status")
      ? { status: stringField(provenanceObject, "status") ?? stringField(stateObject, "status") }
      : {}),
    ...(stringField(runObject, "run_class") ? { run_class: stringField(runObject, "run_class") } : {}),
    ...(stringField(runObject, "target_kind") ? { target_kind: stringField(runObject, "target_kind") } : {}),
    ...(stringField(runObject, "started_at") ? { started_at: stringField(runObject, "started_at") } : {}),
    ...(stringField(provenanceObject, "closed_at") ? { closed_at: stringField(provenanceObject, "closed_at") } : {}),
    ...(initiativeId ? { initiative_id: initiativeId } : {}),
    ...(typeof provenanceObject?.benchmark_eligible === "boolean"
      ? { benchmark_eligible: provenanceObject.benchmark_eligible }
      : {}),
    comparison_eligible: comparisonReasons.length === 0,
    comparison_reasons: comparisonReasons,
    event_count: eventCount,
    has_trace: Boolean(tracePath),
    has_provenance: provenance !== undefined,
    has_run_yaml: runYaml !== undefined,
    path: dir,
  };
}

async function listInitiativeDirs(initiativesRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const bucket of ["active", "archived"]) {
    const bucketRoot = join(initiativesRoot, bucket);
    let entries;
    try {
      entries = await readdir(bucketRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    out.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => join(bucketRoot, entry.name)));
  }
  return out;
}

async function readInitiativeRow(
  source: GuildSource,
  dir: string,
  runs: ProjectRunListRow[],
): Promise<ProjectInitiativeSummary | null> {
  const parsed = await readMaybeYaml(join(dir, "initiative.yaml"));
  const rootObject = asObject(parsed);
  const body = asObject(rootObject?.initiative) ?? rootObject;
  const id = stringField(body, "id") ?? basename(dir);
  if (!isSafeRunId(id)) return null;
  const explicitRunIds = new Set(extractRunIds(body));
  const runIdFile = await readMaybeText(join(dir, ".run-id"));
  if (runIdFile?.trim()) explicitRunIds.add(runIdFile.trim());
  for (const run of runs) {
    if (run.source_guild !== source.name) continue;
    if (run.initiative_id === id) explicitRunIds.add(run.run_id);
  }
  const runIds = [...explicitRunIds].filter(isSafeRunId).sort();
  const eligibleRunIds = runIds.filter((runId) =>
    runs.some(
      (run) =>
        run.source_guild === source.name &&
        run.run_id === runId &&
        run.comparison_eligible === true,
    ),
  );
  const reasons =
    eligibleRunIds.length > 0
      ? []
      : runIds.length > 0
        ? ["no eligible linked runs"]
        : ["no linked runs"];
  return {
    id,
    source_guild: source.name,
    ...(stringField(body, "title") ? { title: stringField(body, "title") } : {}),
    ...(stringField(body, "scope") ? { scope: stringField(body, "scope") } : {}),
    ...(stringField(body, "status") ? { status: stringField(body, "status") } : {}),
    ...(stringField(body, "execution_status") ? { execution_status: stringField(body, "execution_status") } : {}),
    run_ids: runIds,
    eligible_run_ids: eligibleRunIds,
    comparison_eligible: reasons.length === 0,
    comparison_reasons: reasons,
    path: dir,
  };
}

function extractRunIds(value: Record<string, unknown> | undefined): string[] {
  if (!value) return [];
  const out = new Set<string>();
  for (const key of ["run_id", "baseline_run_id", "candidate_run_id"]) {
    const v = value[key];
    if (typeof v === "string" && v) out.add(v);
  }
  for (const key of ["run_ids", "runs", "linked_runs"]) {
    const v = value[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item) out.add(item);
        else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const id = stringField(item as Record<string, unknown>, "run_id") ?? stringField(item as Record<string, unknown>, "id");
          if (id) out.add(id);
        }
      }
    }
  }
  return [...out];
}

function runComparisonReasons(opts: {
  hasTrace: boolean;
  hasProvenance: boolean;
  hasRunYaml: boolean;
  benchmarkEligible?: boolean;
  eventCount: number;
}): string[] {
  const reasons: string[] = [];
  if (opts.benchmarkEligible === false) reasons.push("benchmark_eligible is false");
  if (!opts.hasTrace) reasons.push("no trace events");
  if (opts.eventCount === 0) reasons.push("empty trace");
  if (!opts.hasRunYaml && !opts.hasProvenance) reasons.push("no run manifest or provenance");
  return reasons;
}

function targetId(kind: "run" | "initiative", guild: string, id: string): string {
  return `${kind}:${encodeURIComponent(guild)}:${encodeURIComponent(id)}`;
}

function sourceRankName(guild: string): number {
  if (guild === "workspace") return 0;
  if (guild === "project") return 1;
  return 2;
}

function summarizeProjectTarget(
  target: ProjectComparisonTarget,
  runs: ProjectRunListRow[],
): ProjectComparisonResponse["baseline"] {
  const targetRuns = runs.filter(
    (run) => run.source_guild === target.source_guild && target.run_ids.includes(run.run_id),
  );
  const statusCounts: Record<string, number> = {};
  let totalEvents = 0;
  for (const run of targetRuns) {
    const status = run.status ?? "unknown";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    totalEvents += run.event_count ?? 0;
  }
  return {
    target,
    status_counts: statusCounts,
    total_events: totalEvents,
  };
}

function buildComparisonNotes(
  baseline: ProjectComparisonResponse["baseline"],
  candidate: ProjectComparisonResponse["candidate"],
  status: ProjectComparisonResponse["status"],
): string[] {
  const notes: string[] = [];
  if (status === "kind_mismatch") {
    notes.push("Baseline and candidate are different target kinds. Compare runs to runs or initiatives to initiatives.");
  }
  if (baseline.total_events !== candidate.total_events) {
    notes.push(`Trace volume changed by ${candidate.total_events - baseline.total_events} events.`);
  }
  notes.push("For score deltas, import selected runs into the benchmark corpus or run the Guild learning/evolution commands below.");
  return notes;
}

function buildAnalysisSignals(target: ProjectComparisonTarget, runs: ProjectRunListRow[]): string[] {
  const signals: string[] = [];
  const statuses = new Set(runs.map((run) => run.status ?? "unknown"));
  if (statuses.size > 0) signals.push(`Statuses observed: ${[...statuses].join(", ")}.`);
  const traceEvents = runs.reduce((sum, run) => sum + (run.event_count ?? 0), 0);
  signals.push(`${traceEvents} trace events available for analysis across ${runs.length} run${runs.length === 1 ? "" : "s"}.`);
  if (runs.some((run) => !run.has_provenance)) signals.push("Some runs lack provenance; reflect can still inspect traces, but causality will be weaker.");
  if (target.kind === "initiative") signals.push("Initiative-level analysis should inspect linked runs together before proposing skill or workflow evolution.");
  return signals;
}

// ---- D03 — versioned action descriptors (C-CLI / C-JOBS) ---------------------
//
// Replaces the stale `/guild:reflect` and print-only `/guild:evolve`
// suggestions (both retired surfaces — C06/KTD14) with descriptors bound to
// the packaged run-analysis CLI's closed mappings and the live `/guild:maintain`
// route. Three invariants:
//   AC1 — every copyable command parses against the packaged CLI / maintain
//         route (argv below is the exact C-CLI mapping, minus --cwd).
//   AC2 — only safe ids are ever interpolated and NO descriptor carries a
//         root: the server appends the ONE server-selected canonical root at
//         execution time, so a rendered command cannot pick another root or
//         smuggle shell flags.
//   AC3 — the recommendation-decide descriptor is enabled ONLY for a current,
//         decision-eligible producer inspection carrying both expected
//         guards; every other context (stale/missing/unsupported/refused/
//         unavailable/error or ineligible) stays disabled with the reason.

export const ANALYSIS_ACTION_VERSION = "guild.analysis_action.v1";

export interface AnalysisActionDescriptor extends ProjectAnalysisAction {
  descriptor_version: typeof ANALYSIS_ACTION_VERSION;
  /**
   * Packaged-CLI argv for the C-JOBS bridge (C-CLI mapping WITHOUT --cwd —
   * the server appends the server-selected canonical root). Empty for
   * host-dispatcher commands (/guild:learn, /guild:wiki, /guild:maintain
   * evolve) that do not go through the packaged CLI.
   */
  argv: string[];
  enabled: boolean;
  disabled_reason?: string;
}

function descriptor(
  base: ProjectAnalysisAction,
  argv: string[],
  enabled: boolean,
  disabledReason?: string,
): AnalysisActionDescriptor {
  return {
    ...base,
    descriptor_version: ANALYSIS_ACTION_VERSION,
    argv,
    enabled,
    ...(enabled ? {} : { disabled_reason: disabledReason ?? "disabled" }),
  };
}

/**
 * Decide-action descriptor for ONE recommendation (AC3). Consent context is
 * the producer's INSPECT outcome: current state, decision-eligible, and both
 * expected guards present — anything else is a disabled descriptor naming
 * why. The descriptive label never doubles as the executable form.
 */
export function buildRecommendationActionDescriptor(
  sourceId: string,
  recommendationId: string,
  decision: "accept" | "reject",
  outcome: InspectOutcome | undefined,
): AnalysisActionDescriptor {
  const base: ProjectAnalysisAction = {
    label: `Record your ${decision} decision for ${recommendationId} (requires current producer context)`,
    command: "",
    intent: "evolve",
  };
  if (!isSafeAnalysisId(sourceId) || !isSafeAnalysisId(recommendationId)) {
    return descriptor(base, [], false, "unsafe source or recommendation id");
  }
  if (!outcome) {
    return descriptor(base, [], false, "producer freshness unavailable");
  }
  if (!outcome.ok) {
    return descriptor(base, [], false, `producer inspection ${outcome.state}: ${outcome.reason}`);
  }
  if (outcome.state !== "current") {
    return descriptor(base, [], false, `artifact is ${outcome.state}; re-analyze before deciding`);
  }
  // Identity binding (security F2): the inspection must be FOR this source —
  // a current inspection of another run cannot enable this decision.
  if (outcome.result.kind !== "run" || outcome.result.source_id !== sourceId) {
    return descriptor(base, [], false, "producer inspection does not match this source");
  }
  if (outcome.result.eligible !== true) {
    return descriptor(base, [], false, "producer reports decision-ineligible context");
  }
  const expectedAnalysisId = outcome.result.source_analysis_id;
  const expectedInputHash = outcome.result.input_hash;
  // Guard FORMAT validation (codex/security F1): guards flow into a copyable
  // command string, so anything outside the producer's known shapes (opaque
  // analysis identity, sha256 hex) disables the action instead of rendering.
  if (
    !expectedAnalysisId ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(expectedAnalysisId) ||
    !expectedInputHash ||
    !/^[a-f0-9]{64}$/.test(expectedInputHash)
  ) {
    return descriptor(base, [], false, "producer inspection lacks well-formed expected-context guards");
  }
  const command =
    `/guild:maintain analyze recommendation decide ${sourceId} ${recommendationId} ${decision} ` +
    `--expected-analysis-id ${expectedAnalysisId} --expected-input-hash ${expectedInputHash}`;
  return descriptor({ ...base, command }, [
    "recommendation",
    "decide",
    sourceId,
    recommendationId,
    decision,
    "--expected-analysis-id",
    expectedAnalysisId,
    "--expected-input-hash",
    expectedInputHash,
  ], true);
}

function buildAnalysisActions(
  target: ProjectComparisonTarget,
  inspectOutcome?: InspectOutcome,
): ProjectAnalysisResponse["actions"] {
  const actions: AnalysisActionDescriptor[] = [];
  const rawTargetId =
    target.kind === "run"
      ? target.run_ids[0]
      : decodeURIComponent(target.id.split(":").pop() ?? "");
  const idSafe = rawTargetId !== undefined && isSafeAnalysisId(rawTargetId);

  // Analyze — the packaged diagnostic producer via the maintain route
  // (replaces the retired /guild:reflect suggestion).
  if (target.kind === "run") {
    actions.push(
      idSafe
        ? descriptor(
            {
              label: "Analyze this run with the packaged diagnostic producer",
              command: `/guild:maintain analyze run ${rawTargetId}`,
              intent: "reflect",
            },
            ["run", "analyze", rawTargetId],
            true,
          )
        : descriptor(
            { label: "Analyze this run with the packaged diagnostic producer", command: "", intent: "reflect" },
            [],
            false,
            "target id is not a safe analysis id",
          ),
    );
  } else {
    actions.push(
      idSafe
        ? descriptor(
            {
              label: "Analyze this initiative's linked runs together",
              command: `/guild:maintain analyze initiative ${rawTargetId}`,
              intent: "reflect",
            },
            ["initiative", "analyze", rawTargetId],
            true,
          )
        : descriptor(
            { label: "Analyze this initiative's linked runs together", command: "", intent: "reflect" },
            [],
            false,
            "target id is not a safe analysis id",
          ),
    );
  }

  // Compare — only when the target actually carries 2..100 safe run ids.
  if (target.run_ids.length >= 2 && target.run_ids.length <= 100) {
    const allSafe = target.run_ids.every((id) => isSafeAnalysisId(id));
    actions.push(
      allSafe
        ? descriptor(
            {
              label: "Compare the linked runs for repeated failure signatures",
              command: `/guild:maintain analyze compare ${target.run_ids.join(" ")}`,
              intent: "reflect",
            },
            ["run", "compare", ...target.run_ids],
            true,
          )
        : descriptor(
            { label: "Compare the linked runs for repeated failure signatures", command: "", intent: "reflect" },
            [],
            false,
            "a linked run id is not a safe analysis id",
          ),
    );
  }

  // Live host dispatchers (NOT packaged-CLI argv): learn and wiki survive
  // KTD14; evolve is reachable only as the maintain sub-verb now.
  actions.push(
    descriptor(
      { label: "Refresh project knowledge before evolving", command: "/guild:learn", intent: "learn" },
      [],
      true,
    ),
    descriptor(
      {
        label: "Promote accepted learnings into the wiki",
        command: idSafe && target.kind === "run" ? `/guild:wiki ingest --run ${rawTargetId}` : "/guild:wiki ingest",
        intent: "wiki",
      },
      [],
      true,
    ),
    // Template, not an executable action (codex F2): no concrete skill is
    // bound here, so it ships disabled with the spelling in the label only.
    descriptor(
      {
        label: "Evolve a skill after analysis names a target (run `/guild:maintain evolve <skill-name>`)",
        command: "",
        intent: "evolve",
      },
      [],
      false,
      "bind a specific skill name first",
    ),
  );

  // Recommendation consent (AC3) — a template descriptor at target level:
  // enabled only through buildRecommendationActionDescriptor with a specific
  // recommendation and a current producer inspection. Here it surfaces the
  // CURRENT enablement context so the UI can show why deciding is (un)available.
  if (target.kind === "run") {
    const probe = buildRecommendationActionDescriptor(
      rawTargetId ?? "",
      "rec-id",
      "accept",
      inspectOutcome,
    );
    actions.push({
      ...probe,
      label: "Decide a recommendation (needs a current, eligible analysis)",
      // The template is NEVER directly executable: no concrete recommendation
      // is bound at target level.
      command: "",
      argv: [],
      enabled: false,
      disabled_reason: probe.enabled
        ? "choose a specific recommendation to decide"
        : probe.disabled_reason ?? "disabled",
    });
  }
  return actions;
}

function compareRunRows(a: ProjectRunListRow, b: ProjectRunListRow): number {
  const aTime = a.started_at ?? a.closed_at ?? "";
  const bTime = b.started_at ?? b.closed_at ?? "";
  if (aTime !== bTime) return aTime < bTime ? 1 : -1;
  return a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0;
}

async function readMaybeYaml(path: string): Promise<unknown> {
  if (!existsSync(path)) return undefined;
  try {
    return parseYaml(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readMaybeJson(path: string): Promise<unknown> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function readMaybeText(path: string): Promise<string | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function pickTracePath(runDir: string): string | undefined {
  const candidates = [
    join(runDir, "logs", "v1.4-events.jsonl"),
    join(runDir, "events.ndjson"),
    join(runDir, "logs", "events.ndjson"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function readJsonlPreview(path: string, limit: number): Promise<Record<string, unknown>[]> {
  let raw = "";
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Skip malformed trace lines; the preview is diagnostic.
    }
  }
  return out;
}

async function countJsonlEvents(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(runId);
}

// ---- D01 (C-ANALYSIS) — plugin-produced analysis artifacts -------------------
//
// Read-only mirrors over `.guild/analysis/{runs,comparisons}/**` and
// `.guild/recommendations/*.jsonl` across the server-enumerated guild
// sources. Validation is STRUCTURAL (schema id, identity fields, row shape);
// freshness/eligibility authority stays with the packaged producer via the
// D00 inspect transport. Benchmark duplicates no hash algorithm and no
// detector (D01-AC1): hashes are only passed through / compared for equality
// by the PRODUCER, never recomputed here.

const RUN_ANALYSIS_SCHEMA = "guild.run_analysis.v1";
const RUN_COMPARISON_SCHEMA = "guild.run_comparison.v1";
const RECOMMENDATION_SCHEMA = "guild.recommendation.v1";

/** Read budgets (security review F2): an analysis artifact or recommendation
 * ledger beyond this size, or any non-regular file (FIFO/device), is refused
 * rather than slurped. */
const MAX_ANALYSIS_FILE_BYTES = 8 * 1024 * 1024;

async function readBoundedRegularFile(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function analysisRootFor(source: GuildSource, kind: InspectKind): string {
  return kind === "run"
    ? join(source.root, ".guild", "analysis", "runs")
    : join(source.root, ".guild", "analysis", "comparisons");
}

/** Containment check for an artifact file: realpath must stay under the
 * (realpathed) source root — a symlinked artifact escaping the project is
 * rejected (D01-AC2), matching the safeJoinUnder discipline. */
function isContainedRealpath(sourceRoot: string, file: string): boolean {
  try {
    const physRoot = realpathSync(sourceRoot);
    const physFile = realpathSync(file);
    const rel = relative(physRoot, physFile);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function validateRecommendationRow(
  raw: unknown,
  binding?: { sourceId: string; sourceAnalysisId?: string },
): GuildRecommendationMirror | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema_version !== RECOMMENDATION_SCHEMA) return null;
  if (typeof obj.id !== "string" || obj.id.length === 0) return null;
  if (typeof obj.source_id !== "string" || obj.source_id.length === 0) return null;
  if (typeof obj.source_analysis_id !== "string" || obj.source_analysis_id.length === 0) return null;
  if (typeof obj.status !== "string" || obj.status.length === 0) return null;
  if (obj.requires_user_approval !== true) return null;
  if (!Array.isArray(obj.evidence_refs) || obj.evidence_refs.some((r) => typeof r !== "string")) {
    return null;
  }
  // Canonical source binding (codex F2): a recommendation embedded in or
  // filed for artifact X must name X as its source — a row from another
  // run/comparison never validates here.
  if (binding) {
    if (obj.source_id !== binding.sourceId) return null;
    if (
      binding.sourceAnalysisId !== undefined &&
      obj.source_analysis_id !== binding.sourceAnalysisId
    ) {
      return null;
    }
  }
  return obj as unknown as GuildRecommendationMirror;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ArtifactValidationOutcome {
  validation: AnalysisArtifactValidation;
  analysisId: string | null;
  schemaVersion: string | null;
  artifactEligible: boolean | null;
  recommendationCount: number;
  findingCount: number;
  invalidRecommendationRows: number;
  artifact?: Record<string, unknown>;
}

/** Structural validation of one on-disk analysis/comparison artifact against
 * the type-only mirror. `expectedId` is the owning directory name — a
 * mismatching run_id/comparison_id is a wrong-source artifact (D01-AC2). */
function validateAnalysisArtifact(
  raw: unknown,
  kind: InspectKind,
  expectedId: string,
): ArtifactValidationOutcome {
  const malformed: ArtifactValidationOutcome = {
    validation: "malformed",
    analysisId: null,
    schemaVersion: null,
    artifactEligible: null,
    recommendationCount: 0,
    findingCount: 0,
    invalidRecommendationRows: 0,
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return malformed;
  const obj = raw as Record<string, unknown>;
  const schemaVersion = typeof obj.schema_version === "string" ? obj.schema_version : null;
  const expectedSchema = kind === "run" ? RUN_ANALYSIS_SCHEMA : RUN_COMPARISON_SCHEMA;
  if (schemaVersion !== expectedSchema) {
    return { ...malformed, validation: "unsupported_schema", schemaVersion };
  }
  if (kind === "run") {
    if (
      typeof obj.analysis_id !== "string" ||
      typeof obj.run_id !== "string" ||
      typeof obj.source_hash !== "string" ||
      typeof obj.eligible !== "boolean" ||
      // Contract-fixture required blocks (codex F1): identity/completeness/
      // usage must be objects and every finding row must be an object.
      !isPlainObject(obj.identity) ||
      !isPlainObject(obj.completeness) ||
      !isPlainObject(obj.usage) ||
      !Array.isArray(obj.findings) ||
      obj.findings.some((f) => !isPlainObject(f)) ||
      !Array.isArray(obj.recommendations)
    ) {
      return { ...malformed, schemaVersion };
    }
    if (obj.run_id !== expectedId) {
      return {
        ...malformed,
        validation: "wrong_source",
        schemaVersion,
        analysisId: obj.analysis_id,
      };
    }
    const binding = { sourceId: obj.run_id, sourceAnalysisId: obj.analysis_id };
    const invalidRows = obj.recommendations.filter(
      (r) => validateRecommendationRow(r, binding) === null,
    ).length;
    return {
      validation: invalidRows > 0 ? "partial" : "valid",
      analysisId: obj.analysis_id,
      schemaVersion,
      artifactEligible: obj.eligible,
      recommendationCount: obj.recommendations.length,
      findingCount: obj.findings.length,
      invalidRecommendationRows: invalidRows,
      artifact: obj,
    };
  }
  if (
    typeof obj.comparison_id !== "string" ||
    !Array.isArray(obj.run_ids) ||
    obj.run_ids.some((r) => typeof r !== "string") ||
    !Array.isArray(obj.source_hashes) ||
    obj.source_hashes.some((h) => typeof h !== "string") ||
    !Array.isArray(obj.recommendations)
  ) {
    return { ...malformed, schemaVersion };
  }
  if (obj.comparison_id !== expectedId) {
    return {
      ...malformed,
      validation: "wrong_source",
      schemaVersion,
      analysisId: obj.comparison_id,
    };
  }
  // A comparison recommendation's source_analysis_id IS the comparison_id
  // (contract example): bind both fields, not source_id alone.
  const comparisonBinding = {
    sourceId: obj.comparison_id as string,
    sourceAnalysisId: obj.comparison_id as string,
  };
  const invalidRows = obj.recommendations.filter(
    (r) => validateRecommendationRow(r, comparisonBinding) === null,
  ).length;
  return {
    validation: invalidRows > 0 ? "partial" : "valid",
    analysisId: obj.comparison_id,
    schemaVersion,
    artifactEligible: null,
    recommendationCount: obj.recommendations.length,
    findingCount: 0,
    invalidRecommendationRows: invalidRows,
    artifact: obj,
  };
}

/** Single-read artifact load (security review F1: the file is lstat-checked,
 * containment-checked, then read and parsed ONCE; the detail endpoint reuses
 * this parse instead of reopening the path). */
async function readArtifactDetailCore(
  source: GuildSource,
  kind: InspectKind,
  dir: string,
): Promise<{ summary: AnalysisArtifactSummary; artifact?: Record<string, unknown> } | null> {
  const id = basename(dir);
  const fileName = kind === "run" ? "analysis.json" : "comparison.json";
  const path = join(dir, fileName);
  if (!existsSync(path)) return null;
  const base = {
    kind,
    id,
    source_guild: source.name,
    path,
  };
  const emptySummary = (validation: AnalysisArtifactValidation) => ({
    ...base,
    analysis_id: null,
    schema_version: null,
    artifact_eligible: null,
    validation,
    invalid_recommendation_rows: 0,
    recommendation_count: 0,
    finding_count: 0,
  });
  if (!isSafeAnalysisId(id)) {
    return { summary: emptySummary("wrong_source") };
  }
  if (!isContainedRealpath(source.root, path)) {
    // Symlink escape — surfaced as malformed rather than silently skipped so
    // the dashboard shows the artifact exists but is refused.
    return { summary: emptySummary("malformed") };
  }
  const raw = await readBoundedRegularFile(path, MAX_ANALYSIS_FILE_BYTES);
  if (raw === null) {
    // Oversized / non-regular / unreadable — refused, never parsed.
    return { summary: emptySummary("malformed") };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { summary: emptySummary("malformed") };
  }
  const outcome = validateAnalysisArtifact(parsed, kind, id);
  return {
    summary: {
      ...base,
      analysis_id: outcome.analysisId,
      schema_version: outcome.schemaVersion,
      artifact_eligible: outcome.artifactEligible,
      validation: outcome.validation,
      invalid_recommendation_rows: outcome.invalidRecommendationRows,
      recommendation_count: outcome.recommendationCount,
      finding_count: outcome.findingCount,
    },
    ...(outcome.artifact ? { artifact: outcome.artifact } : {}),
  };
}

/**
 * Enumerate validated analysis/comparison artifacts across every
 * server-enumerated guild source. Listing performs NO producer calls —
 * freshness is resolved per-artifact in readProjectAnalysisArtifact.
 */
export async function listProjectAnalysisArtifacts(
  projectRoot: string,
): Promise<ProjectAnalysisArtifactsResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const artifacts: AnalysisArtifactSummary[] = [];
  const outSources: ProjectSource[] = [];
  for (const source of sources) {
    for (const kind of ["run", "comparison"] as const) {
      const root = analysisRootFor(source, kind);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      outSources.push({ guild: source.name, path: root, kind: `analysis-${kind}s` });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const core = await readArtifactDetailCore(source, kind, join(root, entry.name));
        if (core) artifacts.push(core.summary);
      }
    }
  }
  artifacts.sort((a, b) =>
    a.source_guild === b.source_guild
      ? a.kind === b.kind
        ? a.id.localeCompare(b.id)
        : a.kind === "run"
          ? -1
          : 1
      : a.source_guild.localeCompare(b.source_guild),
  );
  return { artifacts, total: artifacts.length, sources: outSources };
}

function freshnessFromInspect(
  outcome: Awaited<ReturnType<typeof inspectArtifact>>,
): AnalysisArtifactFreshness {
  if (outcome.ok) {
    return {
      state: outcome.state,
      reason: outcome.result.reason,
      // B04 F4: browser decision eligibility comes from INSPECT, never from
      // the stored artifact's own eligible flag.
      decision_eligible: outcome.result.eligible,
    };
  }
  return { state: outcome.state, reason: outcome.reason };
}

async function readRecommendationLines(
  source: GuildSource,
  kind: InspectKind,
  sourceId: string,
): Promise<{ rows: GuildRecommendationMirror[]; invalid: number }> {
  const path = join(source.root, ".guild", "recommendations", `${sourceId}.jsonl`);
  if (!existsSync(path) || !isContainedRealpath(source.root, path)) {
    return { rows: [], invalid: 0 };
  }
  const raw = await readBoundedRegularFile(path, MAX_ANALYSIS_FILE_BYTES);
  if (raw === null) {
    // Oversized / non-regular ledger — the whole file is refused as one
    // invalid unit rather than parsed.
    return { rows: [], invalid: 1 };
  }
  // A run's ledger legitimately spans analysis generations (different
  // source_analysis_id per re-analysis), so runs bind source_id only. A
  // comparison recommendation's source_analysis_id IS the comparison_id
  // (contract example) — bind both.
  const binding =
    kind === "comparison"
      ? { sourceId, sourceAnalysisId: sourceId }
      : { sourceId };
  const rows: GuildRecommendationMirror[] = [];
  let invalid = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalid += 1;
      continue;
    }
    const row = validateRecommendationRow(parsed, binding);
    if (row) rows.push(row);
    else invalid += 1;
  }
  return { rows, invalid };
}

/**
 * Read one analysis artifact with its recommendation ledger and
 * producer-authoritative freshness. `runtime` is the D00 packaged transport;
 * absent ⇒ freshness `unavailable` (never silently "current").
 */
export async function readProjectAnalysisArtifact(
  projectRoot: string,
  kind: InspectKind,
  id: string,
  guildName?: string,
  runtime?: PackagedRuntime,
): Promise<ProjectAnalysisArtifactDetailResponse> {
  if (!isSafeAnalysisId(id)) {
    throw new ProjectReadError("bad_request", "invalid artifact id");
  }
  const sources = await resolveGuildSources(projectRoot);
  const candidates: Array<{ source: GuildSource; dir: string }> = [];
  for (const source of sources) {
    if (guildName && source.name !== guildName) continue;
    const dir = join(analysisRootFor(source, kind), id);
    if (existsSync(join(dir, kind === "run" ? "analysis.json" : "comparison.json"))) {
      candidates.push({ source, dir });
    }
  }
  if (candidates.length === 0) {
    // No local artifact (codex F3): still consult the producer so freshness
    // can carry the AUTHORITATIVE `missing` (or `unavailable` without a
    // runtime). Needs one unambiguous owning root.
    const owners = guildName ? sources.filter((s) => s.name === guildName) : sources;
    if (guildName && owners.length === 0) {
      throw new ProjectReadError("not_found", `unknown guild: ${guildName}`);
    }
    if (owners.length !== 1) {
      throw new ProjectReadError(
        "ambiguous_guild",
        "guild parameter is required to inspect an absent artifact across multiple sources",
      );
    }
    const owner = owners[0];
    const ledger = await readRecommendationLines(owner, kind, id);
    const freshness = freshnessFromInspect(await inspectArtifact(runtime, owner.root, kind, id));
    return {
      summary: {
        kind,
        id,
        source_guild: owner.name,
        path: join(analysisRootFor(owner, kind), id),
        analysis_id: null,
        schema_version: null,
        artifact_eligible: null,
        validation: "absent",
        invalid_recommendation_rows: 0,
        recommendation_count: 0,
        finding_count: 0,
      },
      recommendations: ledger.rows,
      invalid_recommendation_lines: ledger.invalid,
      freshness,
    };
  }
  if (candidates.length > 1) {
    throw new ProjectReadError(
      "ambiguous_guild",
      "guild parameter is required when multiple sources contain the same artifact id",
    );
  }
  const { source, dir } = candidates[0];
  const core = await readArtifactDetailCore(source, kind, dir);
  if (!core) {
    throw new ProjectReadError("not_found", `analysis artifact not found: ${kind}/${id}`);
  }
  const { summary, artifact } = core;
  const ledger = await readRecommendationLines(source, kind, id);
  const freshness = freshnessFromInspect(
    await inspectArtifact(runtime, source.root, kind, id),
  );
  return {
    summary,
    ...(artifact ? { artifact } : {}),
    recommendations: ledger.rows,
    invalid_recommendation_lines: ledger.invalid,
    freshness,
  };
}

// ---- wiki list --------------------------------------------------------------

/**
 * List every `.md` page across all wiki sources. Paths are relative to the
 * owning guild's `.guild/wiki/`; title is the first `# ` H1 (else the
 * filename); labels come from frontmatter when trivially parseable.
 *
 * Throws ProjectReadError("not_found") when NO source has wiki/docs knowledge.
 */
export async function listProjectWikiPages(
  projectRoot: string,
): Promise<ProjectWikiListResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const withWiki = sources.filter((s) => s.wikiRoot);
  if (withWiki.length === 0) {
    throw new ProjectReadError(
      "not_found",
      "no .guild/wiki or docs/knowledge directory found under the project root",
    );
  }
  const pages: WikiPageSummary[] = [];
  for (const src of withWiki) {
    const files = await walkMarkdownFiles(src.wikiRoot!);
    for (const abs of files) {
      const rel = relative(src.wikiRoot!, abs).split(sep).join("/");
      let raw = "";
      try {
        raw = await readFile(abs, "utf8");
      } catch {
        continue; // unreadable page — skip, never fail the listing
      }
      const title = extractTitle(raw, rel);
      const labels = extractFrontmatterLabels(raw);
      pages.push({
        path: rel,
        title,
        source_guild: src.name,
        ...(labels && labels.length > 0 ? { labels } : {}),
      });
    }
  }
  pages.sort((a, b) =>
    a.source_guild === b.source_guild
      ? a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0
      : a.source_guild < b.source_guild
        ? -1
        : 1,
  );
  return { pages };
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdownFiles(full)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** First `# `-prefixed line wins; else the filename without extension. */
export function extractTitle(markdown: string, relPath: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "");
}

/**
 * Trivially-parseable frontmatter labels. Recognized forms inside a leading
 * `---` block:
 *   labels: [a, b]      (inline flow list)
 *   labels:             (block list)
 *     - a
 *     - b
 * Anything else → undefined (no labels). No YAML dependency on this path.
 */
export function extractFrontmatterLabels(markdown: string): string[] | undefined {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return undefined;
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; i++) {
    const m = /^labels:\s*(.*)$/.exec(fm[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const items = inline
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    if (inline === "") {
      const items: string[] = [];
      for (let j = i + 1; j < fm.length; j++) {
        const item = /^\s+-\s+(.+?)\s*$/.exec(fm[j]);
        if (!item) break;
        items.push(item[1].replace(/^["']|["']$/g, ""));
      }
      return items.length > 0 ? items : undefined;
    }
    return undefined; // scalar labels value — not a list, skip
  }
  return undefined;
}

// ---- wiki page get -----------------------------------------------------------

/**
 * Read one wiki page. `relPath` is relative to the owning guild's
 * `.guild/wiki/` or docs/knowledge root. In workspace mode with more than one wiki source the
 * `guildName` parameter is required (ambiguous_guild otherwise); with exactly
 * one source it defaults to that source. Traversal (absolute paths, `..`
 * escapes) is rejected via the safeJoinUnder pattern — the resolved path must
 * stay under that guild's wiki root.
 */
export async function readProjectWikiPage(
  projectRoot: string,
  relPath: string,
  guildName?: string,
): Promise<ProjectWikiPageResponse> {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    throw new ProjectReadError("bad_request", "path query parameter is required");
  }
  if (isAbsolute(relPath)) {
    throw new ProjectReadError("bad_request", "path traversal denied");
  }
  const sources = await resolveGuildSources(projectRoot);
  const withWiki = sources.filter((s) => s.wikiRoot);
  if (withWiki.length === 0) {
    throw new ProjectReadError(
      "not_found",
      "no .guild/wiki or docs/knowledge directory found under the project root",
    );
  }
  let source: GuildSource | undefined;
  if (guildName !== undefined && guildName !== "") {
    source = withWiki.find((s) => s.name === guildName);
    if (!source) {
      throw new ProjectReadError("not_found", `unknown guild: ${guildName}`);
    }
  } else if (withWiki.length === 1) {
    source = withWiki[0];
  } else {
    throw new ProjectReadError(
      "ambiguous_guild",
      "guild query parameter is required when multiple wiki sources exist",
    );
  }
  const target = safeJoinUnder(source.wikiRoot!, relPath);
  if (!target) {
    throw new ProjectReadError("bad_request", "path traversal denied");
  }
  if (!existsSync(target)) {
    throw new ProjectReadError("not_found", `wiki page not found: ${relPath}`);
  }
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch {
    throw new ProjectReadError("not_found", `wiki page not readable: ${relPath}`);
  }
  return {
    path: normalize(relPath).split(sep).join("/"),
    source_guild: source.name,
    content,
  };
}

// Same traversal guard as server.ts (kept duplicated on purpose — the spec
// pins "the safeJoinUnder pattern"; project-reader stays import-free of
// server internals so it is unit-testable in isolation).
export function safeJoinUnder(root: string, rest: string): string | null {
  const normalisedRest = normalize(rest).replace(/^([\\/]+)/, "");
  if (normalisedRest === ".." || normalisedRest.startsWith(`..${sep}`)) return null;
  const target = resolve(root, normalisedRest);
  const rel = relative(root, target);
  if (rel.startsWith("..") || resolve(root, rel) !== target) return null;
  return target;
}

// ---- C9 metric series + drilldown (T04) ------------------------------------
//
// The complete project read service over every configured source: each request
// re-reads all retained runs into one snapshot (src/c9/project-read.ts). A
// series/drilldown request is served only against the snapshot its query names
// (same as_of, same source generations); a changed or offline source is a
// stale_source / stale_cursor refusal, never a mixed page.


export interface C9Response { status: 200 | 400 | 409 | 422; body: unknown }

const C9_GROUP_BY: ReadonlySet<string> = new Set(["all", "source", "run", "cohort", "task", "observed_model"]);
const C9_WINDOW_BASES: ReadonlySet<string> = new Set(["activity_completed", "accepted_outcome_cohort", "as_of_snapshot"]);

function c9RefusalResponse(r: RefusalV2): C9Response {
  const status = r.code === "stale_source" || r.code === "stale_cursor" ? 409 : r.code === "invalid_request" ? 400 : 422;
  return { status, body: r };
}

/**
 * C9's source set, from ONE read of `.guild/workspace.json` (no second read can disagree).
 * Unlike the lenient reader it never falls back or skips: a present manifest must read,
 * parse and name every child under the root, or the source set is unknown and refused.
 * The root is always a source ("workspace" or "project"); two names for one root are one
 * source, read once.
 */
async function c9Sources(projectRoot: string): Promise<{ source_id: string; root: string; names: string[] }[]> {
  const root = resolve(projectRoot);
  const named: { name: string; root: string }[] = [];
  const p = join(root, ".guild", "workspace.json");
  let present = true;
  try {
    lstatSync(p);
  } catch {
    present = false;
  }
  if (!present) named.push({ name: "project", root });
  else {
    let rootReal: string;
    try {
      rootReal = realpathSync(root);
    } catch {
      throw new Error("source set unknown: project root does not resolve");
    }
    const read = await readContainedRegularFile(p, WORKSPACE_JSON_MAX_BYTES, rootReal);
    if (!read) throw new Error("source set unknown: .guild/workspace.json is present but unreadable");
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      throw new Error("source set unknown: .guild/workspace.json is not valid JSON");
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed["sub_guilds"])) throw new Error("source set unknown: .guild/workspace.json has no sub_guilds array");
    named.push({ name: "workspace", root });
    for (const sg of parsed["sub_guilds"] as unknown[]) {
      if (!isPlainObject(sg) || typeof sg["name"] !== "string" || typeof sg["path"] !== "string") throw new Error("source set unknown: .guild/workspace.json has a sub_guild without a string name and path");
      const childRoot = resolve(root, sg["path"]);
      if (!isUnder(root, childRoot)) throw new Error(`source set unknown: .guild/workspace.json sub_guild ${JSON.stringify(sg["name"]).slice(0, 130)} is outside the project root`);
      named.push({ name: sg["name"], root: childRoot });
    }
  }
  const byId = new Map<string, { source_id: string; root: string; names: string[] }>();
  for (const s of named) {
    const id = canonicalSourceId(s.root);
    const seen = byId.get(id);
    if (seen) seen.names.push(s.name);
    else byId.set(id, { source_id: id, root: s.root, names: [s.name] });
  }
  return [...byId.values()];
}

/** Open one snapshot over every configured source at `asOf`; an engine refusal comes back as a C9 response. */
async function openC9Snapshot(projectRoot: string, asOf: string, requestId: string): Promise<(ProjectSnapshot & { names: Record<string, string[]> }) | C9Response> {
  let configured: Awaited<ReturnType<typeof c9Sources>>;
  try {
    configured = await c9Sources(projectRoot);
  } catch (err) {
    return { status: 422, body: { error: `metric snapshot refused: ${(err as Error).message}` } };
  }
  const sources = configured.map(({ source_id, root }) => ({ source_id, root }));
  const names = Object.fromEntries(configured.map((s) => [s.source_id, s.names]));
  try {
    return { ...openProjectSnapshot(sources, { as_of: asOf }), names };
  } catch (err) {
    if (err instanceof SeriesRefusal) return c9RefusalResponse(refusal(requestId, err.code, err.message, err.retryable));
    // Unsafe or duplicate configured source names, or a bad as_of: the request cannot be served.
    return { status: 422, body: { error: `metric snapshot refused: ${(err as Error).message}` } };
  }
}

function parseQuerySpec(body: Record<string, unknown>): ProjectQuerySpec | string {
  const { metric_id, underlying_metric_id, grain, filters, window } = body;
  if (typeof metric_id !== "string" || metric_id.length > 128) return "metric_id must be a catalog metric id";
  if (underlying_metric_id !== undefined && underlying_metric_id !== null && (typeof underlying_metric_id !== "string" || underlying_metric_id.length > 128)) return "underlying_metric_id must be a catalog metric id";
  if (grain !== undefined && typeof grain !== "string") return "grain must be a string";
  let parsedFilters: QueryFilter[] | undefined;
  if (filters !== undefined) {
    if (!Array.isArray(filters) || filters.length > 50) return "filters must be an array of at most 50 {dimension, values}";
    parsedFilters = [];
    for (const f of filters) {
      if (!isPlainObject(f) || typeof f["dimension"] !== "string" || !Array.isArray(f["values"]) || f["values"].length > 100 || !f["values"].every((v) => typeof v === "string")) {
        return "each filter is {dimension: string, values: string[] (at most 100)}";
      }
      parsedFilters.push({ dimension: f["dimension"], values: [...(f["values"] as string[])] });
    }
  }
  let parsedWindow: ProjectQuerySpec["window"];
  if (window !== undefined) {
    if (!isPlainObject(window) || typeof window["from"] !== "string" || typeof window["to"] !== "string" || typeof window["basis"] !== "string" || !C9_WINDOW_BASES.has(window["basis"])) {
      return "window is {from, to, basis} with basis activity_completed | accepted_outcome_cohort | as_of_snapshot";
    }
    parsedWindow = { from: window["from"], to: window["to"], basis: window["basis"] as NonNullable<ProjectQuerySpec["window"]>["basis"] };
  }
  return {
    metric_id,
    underlying_metric_id: (underlying_metric_id as string | null | undefined) ?? null,
    ...(grain !== undefined ? { grain: grain as ProjectQuerySpec["grain"] } : {}),
    ...(parsedFilters ? { filters: parsedFilters } : {}),
    ...(parsedWindow ? { window: parsedWindow } : {}),
  };
}

/**
 * Pin a C9 query for one metric over the current snapshot. Body: `{metric_id,
 * underlying_metric_id?, grain?, filters?, window?, as_of?}`; `as_of` defaults to now.
 * Returns the query identity, its hash, the display names of each canonical
 * source id, and per-source diagnostics (coverage, run errors, unavailable
 * sources) of the same snapshot.
 */
export async function projectMetricQuery(projectRoot: string, body: unknown, now: () => Date = () => new Date()): Promise<C9Response> {
  if (!isPlainObject(body)) return { status: 400, body: { error: "request body must be a JSON object" } };
  const spec = parseQuerySpec(body);
  if (typeof spec === "string") return { status: 400, body: { error: spec } };
  // Keep sub-second precision: rounding down would put same-second events after as_of.
  const asOf = body["as_of"] ?? now().toISOString();
  if (typeof asOf !== "string" || !isRfc3339(asOf)) return { status: 400, body: { error: "as_of must be an RFC 3339 instant" } };
  const snap = await openC9Snapshot(projectRoot, asOf, "metric-query");
  if (!("facts" in snap)) return snap;
  try {
    const query = projectQuery(snap, spec);
    const check = validateReadRequestV2(readRequest(query, "metric_series", { request_id: "metric-query", session_id: "benchmark" }));
    if (!check.ok) return c9RefusalResponse(refusal("metric-query", "invalid_request", check.errors.join("; "), false));
    return { status: 200, body: { query, query_hash: queryHash(query), sources: snap.names, diagnostics: snap.diagnostics } };
  } catch (err) {
    if (err instanceof SeriesRefusal) return c9RefusalResponse(refusal("metric-query", err.code, err.message, err.retryable));
    return { status: 400, body: { error: (err as Error).message.slice(0, 400) } };
  }
}

function parseReadBody(body: unknown): { request: unknown; requestId: string; asOf: string; group_by?: GroupBy; point_key?: string } | C9Response {
  if (!isPlainObject(body) || !isPlainObject(body["request"])) return { status: 400, body: { error: "body is {request: guild.stack.read-request.v2, group_by?, point_key?}" } };
  const request = body["request"];
  const rid = typeof request["request_id"] === "string" && TRACE_ID_RE.test(request["request_id"]) ? request["request_id"] : "invalid-request";
  const groupBy = body["group_by"];
  if (groupBy !== undefined && (typeof groupBy !== "string" || !C9_GROUP_BY.has(groupBy))) {
    return c9RefusalResponse(refusal(rid, "invalid_request", "group_by is all | source | run | cohort | task | observed_model", false));
  }
  const pointKey = body["point_key"];
  if (pointKey !== undefined && (typeof pointKey !== "string" || pointKey.length > 512)) return c9RefusalResponse(refusal(rid, "invalid_request", "point_key must be a series point key", false));
  const query = request["query"];
  const snapshot = isPlainObject(query) ? query["snapshot"] : undefined;
  const asOf = isPlainObject(snapshot) ? snapshot["as_of"] : undefined;
  if (typeof asOf !== "string" || !isRfc3339(asOf)) return c9RefusalResponse(refusal(rid, "invalid_request", "request query snapshot carries no RFC 3339 as_of", false));
  return { request, requestId: rid, asOf, ...(groupBy !== undefined ? { group_by: groupBy as GroupBy } : {}), ...(pointKey !== undefined ? { point_key: pointKey as string } : {}) };
}

const isC9Refusal = (x: unknown): x is RefusalV2 => isPlainObject(x) && x["schema_version"] === "guild.stack.refusal.v2";

/** `metric_series` over the snapshot the request's query names. Body: `{request, group_by?}`. */
export async function projectMetricSeries(projectRoot: string, body: unknown): Promise<C9Response> {
  const parsed = parseReadBody(body);
  if ("status" in parsed) return parsed;
  const snap = await openC9Snapshot(projectRoot, parsed.asOf, parsed.requestId);
  if (!("facts" in snap)) return snap;
  const out = readMetricSeries(snap, parsed.request, { group_by: parsed.group_by });
  return isC9Refusal(out) ? c9RefusalResponse(out) : { status: 200, body: out };
}

/** `metric_drilldown`: one page of a point's evidence. Body: `{request, point_key?, group_by?}`. */
export async function projectMetricDrilldown(projectRoot: string, body: unknown): Promise<C9Response> {
  const parsed = parseReadBody(body);
  if ("status" in parsed) return parsed;
  const snap = await openC9Snapshot(projectRoot, parsed.asOf, parsed.requestId);
  if (!("facts" in snap)) return snap;
  const out = readMetricDrilldown(snap, parsed.request, { group_by: parsed.group_by, point_key: parsed.point_key });
  return isC9Refusal(out) ? c9RefusalResponse(out) : { status: 200, body: out };
}

/**
 * B01: one evaluation's paired result and operational spend over the current snapshot.
 * Body: `{source_id, evaluation_id, as_of?}`. Unknown evaluation → 404-shaped 422.
 */
export async function projectEvaluationReport(projectRoot: string, body: unknown, now: () => Date = () => new Date()): Promise<C9Response> {
  if (!isPlainObject(body)) return { status: 400, body: { error: "request body must be a JSON object" } };
  const { source_id, evaluation_id } = body;
  if (typeof source_id !== "string" || source_id.length > 128 || typeof evaluation_id !== "string" || !TRACE_ID_RE.test(evaluation_id)) {
    return { status: 400, body: { error: "body is {source_id, evaluation_id, as_of?}" } };
  }
  const asOf = body["as_of"] ?? now().toISOString();
  if (typeof asOf !== "string" || !isRfc3339(asOf)) return { status: 400, body: { error: "as_of must be an RFC 3339 instant" } };
  const snap = await openC9Snapshot(projectRoot, asOf, "evaluation-report");
  if (!("facts" in snap)) return snap;
  const report = evaluationReport(snap, source_id, evaluation_id);
  if (!report) {
    const src = snap.facts.sources.find((x) => x.source_id === source_id);
    const bad = src?.evaluations?.unreadable.find((x) => x.evaluation_id === evaluation_id);
    return { status: 422, body: { error: bad ? `evaluation cannot be imported: ${bad.reason}` : `no evaluation ${evaluation_id} in source ${source_id}` } };
  }
  return { status: 200, body: { snapshot: snap.facts.snapshot, ...report } };
}
