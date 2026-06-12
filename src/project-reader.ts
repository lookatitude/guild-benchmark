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

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

// Response shapes live in types.ts next to every other HTTP contract the UI
// imports (see types.ts §"live-project knowledge routes").
import type {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(workspacePath, "utf8"));
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
  return {
    target,
    signals,
    actions: buildAnalysisActions(target),
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
  const run = matches[0];
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

function buildAnalysisActions(target: ProjectComparisonTarget): ProjectAnalysisResponse["actions"] {
  const primaryRef = target.kind === "run" ? `--run ${target.run_ids[0]}` : `--initiative ${target.id.split(":").pop() ?? target.id}`;
  return [
    {
      label: "Reflect on mistakes and performance",
      command: `/guild:reflect ${primaryRef}`.trim(),
      intent: "reflect",
    },
    {
      label: "Refresh project knowledge before evolving",
      command: "/guild:learn",
      intent: "learn",
    },
    {
      label: "Promote accepted learnings into the wiki",
      command: `/guild:wiki ingest ${primaryRef}`.trim(),
      intent: "wiki",
    },
    {
      label: "Evolve a skill after reflection names a target",
      command: "/guild:evolve <skill-name>",
      intent: "evolve",
    },
  ];
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
