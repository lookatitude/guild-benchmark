import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ProjectReadError,
  extractFrontmatterLabels,
  extractTitle,
  listProjectWikiPages,
  getProjectOverview,
  analyzeProjectTarget,
  compareProjectTargets,
  listProjectComparisonTargets,
  listProjectInitiatives,
  listProjectRuns,
  readProjectKnowledgeGraph,
  readProjectRun,
  readProjectWikiPage,
  resolveGuildSources,
  safeJoinUnder,
} from "../src/project-reader.js";
import {
  seedPlainProject,
  seedWorkspaceProject,
  writeFileDeep,
} from "./project.helpers.js";

describe("project-reader / resolveGuildSources", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-reader-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plain root → single 'project' source with wiki + kg attached", async () => {
    await seedPlainProject(root);
    const sources = await resolveGuildSources(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("project");
    expect(sources[0].wikiRoot).toBe(join(root, ".guild", "wiki"));
    expect(sources[0].kgPath).toBe(join(root, ".guild", "indexes", "knowledge-graph.json"));
  });

  it("plain root without artifacts → 'project' source with neither attached", async () => {
    const sources = await resolveGuildSources(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("project");
    expect(sources[0].wikiRoot).toBeUndefined();
    expect(sources[0].kgPath).toBeUndefined();
  });

  it("workspace root → one source per sub_guild, artifacts detected per child", async () => {
    await seedWorkspaceProject(root);
    const sources = await resolveGuildSources(root);
    expect(sources.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
    const alpha = sources[0];
    const beta = sources[1];
    const gamma = sources[2];
    expect(alpha.wikiRoot).toBe(join(root, "alpha", ".guild", "wiki"));
    expect(alpha.kgPath).toBeDefined();
    expect(beta.wikiRoot).toBeUndefined(); // has_wiki false AND no dir
    expect(beta.kgPath).toBeDefined();
    expect(gamma.wikiRoot).toBeUndefined();
    expect(gamma.kgPath).toBeUndefined();
  });

  it("workspace.json present but has_wiki true with missing dir → wikiRoot omitted", async () => {
    await seedWorkspaceProject(root);
    // alpha claims has_wiki via the manifest; delete the dir out from under it.
    await rm(join(root, "alpha", ".guild", "wiki"), { recursive: true, force: true });
    const sources = await resolveGuildSources(root);
    expect(sources[0].name).toBe("alpha");
    expect(sources[0].wikiRoot).toBeUndefined();
  });

  it("malformed workspace.json (non-JSON) falls back to plain-root behavior", async () => {
    await seedPlainProject(root);
    await writeFileDeep(join(root, ".guild", "workspace.json"), "{not json");
    const sources = await resolveGuildSources(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("project");
    expect(sources[0].wikiRoot).toBeDefined();
  });

  it("workspace.json without sub_guilds array falls back to plain-root behavior", async () => {
    await seedPlainProject(root);
    await writeFileDeep(
      join(root, ".guild", "workspace.json"),
      JSON.stringify({ schema_version: "guild.workspace.v1", is_workspace: true }),
    );
    const sources = await resolveGuildSources(root);
    expect(sources).toHaveLength(1);
    expect(sources[0].name).toBe("project");
  });

  it("sub_guild entries missing name/path strings are skipped (lenient)", async () => {
    await writeFileDeep(
      join(root, ".guild", "workspace.json"),
      JSON.stringify({
        schema_version: "guild.workspace.v1",
        sub_guilds: [{ name: "ok", path: "ok" }, { name: 7 }, "junk", null],
      }),
    );
    const sources = await resolveGuildSources(root);
    expect(sources.map((s) => s.name)).toEqual(["ok"]);
  });
});

describe("project-reader / readProjectKnowledgeGraph", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-kg-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plain root: nodes/edges tagged source_guild='project', unknown fields pass through", async () => {
    await seedPlainProject(root);
    const res = await readProjectKnowledgeGraph(root);
    expect(res.nodes).toHaveLength(3);
    expect(res.edges).toHaveLength(2);
    expect(res.sources).toEqual([
      {
        guild: "project",
        path: join(root, ".guild", "indexes", "knowledge-graph.json"),
        kind: "knowledge-graph",
      },
    ]);
    for (const n of res.nodes) expect(n.source_guild).toBe("project");
    for (const e of res.edges) expect(e.source_guild).toBe("project");
    // Unknown/extra fields preserved (lenient pass-through).
    const fn = res.nodes.find((n) => n.id === "createApp");
    expect(fn?.source_refs).toEqual(["src/server.ts"]);
  });

  it("workspace root: federates alpha+beta, tags per-source, never includes gamma", async () => {
    await seedWorkspaceProject(root);
    const res = await readProjectKnowledgeGraph(root);
    expect(res.sources.map((s) => s.guild)).toEqual(["alpha", "beta"]);
    const alphaNodes = res.nodes.filter((n) => n.source_guild === "alpha");
    const betaNodes = res.nodes.filter((n) => n.source_guild === "beta");
    expect(alphaNodes).toHaveLength(1);
    expect(betaNodes).toHaveLength(1);
    expect(betaNodes[0].custom_field).toBe(42); // unknown field passes through
    expect(res.edges).toHaveLength(1);
    expect(res.edges[0].source_guild).toBe("alpha");
  });

  it("missing KG everywhere → empty graph with empty_reason", async () => {
    await expect(readProjectKnowledgeGraph(root)).resolves.toMatchObject({
      nodes: [],
      edges: [],
      sources: [],
      empty_reason: expect.stringMatching(/no knowledge graph or codebase map/),
    });
  });

  it("unreadable JSON in one source is skipped; the other still federates", async () => {
    await seedWorkspaceProject(root);
    await writeFileDeep(
      join(root, "alpha", ".guild", "indexes", "knowledge-graph.json"),
      "{broken",
    );
    const res = await readProjectKnowledgeGraph(root);
    expect(res.sources.map((s) => s.guild)).toEqual(["beta"]);
  });

  it("all sources unreadable → empty graph with empty_reason", async () => {
    await writeFileDeep(join(root, ".guild", "indexes", "knowledge-graph.json"), "[1,2");
    await expect(readProjectKnowledgeGraph(root)).resolves.toMatchObject({
      nodes: [],
      edges: [],
      sources: [],
      empty_reason: expect.stringMatching(/no readable knowledge graph or codebase map/),
    });
  });

  it("non-object nodes/edges entries are dropped, missing arrays tolerated", async () => {
    await writeFileDeep(
      join(root, ".guild", "indexes", "knowledge-graph.json"),
      JSON.stringify({ nodes: [{ id: "n1" }, "junk", null, 5, ["arr"]], other: true }),
    );
    const res = await readProjectKnowledgeGraph(root);
    expect(res.nodes).toHaveLength(1);
    expect(res.edges).toHaveLength(0);
  });

  it("codebase-map.json is converted into module/file graph nodes", async () => {
    await writeFileDeep(
      join(root, ".guild", "indexes", "codebase-map.json"),
      JSON.stringify({
        files: [
          {
            path: "src/server.ts",
            language: "typescript",
            loc: 120,
            complexity: 8,
            module: "src",
            is_entrypoint: true,
          },
          { path: "README.md", language: "markdown", module: "(root)" },
        ],
      }),
    );
    const res = await readProjectKnowledgeGraph(root);
    expect(res.sources).toEqual([
      {
        guild: "project",
        path: join(root, ".guild", "indexes", "codebase-map.json"),
        kind: "codebase-map",
      },
    ]);
    expect(res.nodes.some((n) => n.id === "project:module:src")).toBe(true);
    expect(res.nodes.some((n) => n.id === "project:file:src/server.ts")).toBe(true);
    expect(res.edges.some((e) => e.type === "contains")).toBe(true);
  });
});

describe("project-reader / project overview + live runs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-runs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists live .guild/runs across workspace root and sub-guilds", async () => {
    await seedWorkspaceProject(root);
    await writeFileDeep(
      join(root, ".guild", "runs", "run-root", "run.yaml"),
      "schema_version: guild.run.v1\nrun_id: run-root\ncommand: root command\nrun_class: full\nstarted_at: 2026-06-10T10:00:00Z\n",
    );
    await writeFileDeep(
      join(root, ".guild", "runs", "run-root", "provenance.json"),
      JSON.stringify({ run_id: "run-root", closed_at: "2026-06-10", benchmark_eligible: true }),
    );
    await writeFileDeep(
      join(root, ".guild", "runs", "run-root", "logs", "v1.4-events.jsonl"),
      "{\"event\":\"run_started\"}\n",
    );
    await writeFileDeep(
      join(root, "alpha", ".guild", "runs", "run-alpha", "events.ndjson"),
      "{\"event\":\"done\"}\n",
    );

    const listed = await listProjectRuns(root);
    expect(listed.total).toBe(2);
    expect(listed.runs.map((r) => `${r.source_guild}:${r.run_id}`).sort()).toEqual([
      "alpha:run-alpha",
      "workspace:run-root",
    ]);
    const rootRun = listed.runs.find((r) => r.run_id === "run-root")!;
    expect(rootRun.command).toBe("root command");
    expect(rootRun.benchmark_eligible).toBe(true);
    expect(rootRun.has_trace).toBe(true);

    const detail = await readProjectRun(root, "run-root", "workspace");
    expect(detail.event_count).toBe(1);
    expect(detail.trace_preview[0].event).toBe("run_started");
  });

  it("summarizes sources, runs, wiki pages, and graph totals", async () => {
    await seedWorkspaceProject(root);
    await writeFileDeep(join(root, ".guild", "runs", "run-root", "events.ndjson"), "{}\n");
    const overview = await getProjectOverview(root);
    expect(overview.mode).toBe("workspace");
    expect(overview.totals.runs).toBe(1);
    expect(overview.totals.wiki_pages).toBeGreaterThan(0);
    expect(overview.totals.graph_nodes).toBe(2);
    expect(overview.sources.map((s) => s.guild)).toEqual([
      "workspace",
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("loads workspace and child initiatives and marks only trace-backed runs eligible", async () => {
    await seedWorkspaceProject(root);
    await writeFileDeep(
      join(root, ".guild", "runs", "run-root", "run.yaml"),
      "schema_version: guild.run.v1\nrun_id: run-root\ncommand: /guild:initiative\ninitiative_attachment: guild-dashboard\nstarted_at: 2026-06-10T10:00:00Z\n",
    );
    await writeFileDeep(
      join(root, ".guild", "runs", "run-root", "provenance.json"),
      JSON.stringify({
        run_id: "run-root",
        status: "closed",
        initiative: "guild-dashboard",
        benchmark_eligible: true,
      }),
    );
    await writeFileDeep(
      join(root, ".guild", "runs", "run-root", "logs", "v1.4-events.jsonl"),
      "{\"event_name\":\"run_started\"}\n{\"event_name\":\"run_closed\"}\n",
    );
    await writeFileDeep(
      join(root, ".guild", "initiatives", "active", "guild-dashboard", "initiative.yaml"),
      "id: guild-dashboard\ntitle: Guild dashboard\nscope: workspace\nstatus: in_progress\nrun_id: run-root\n",
    );
    await writeFileDeep(
      join(root, "alpha", ".guild", "runs", "run-alpha", "run.yaml"),
      "schema_version: guild.run.v1\nrun_id: run-alpha\ncommand: /guild:build\nstarted_at: 2026-06-10T11:00:00Z\n",
    );
    await writeFileDeep(
      join(root, "alpha", ".guild", "initiatives", "active", "alpha-work", "initiative.yaml"),
      "id: alpha-work\ntitle: Alpha work\nscope: project\nrun_id: run-alpha\n",
    );

    const runs = await listProjectRuns(root);
    expect(runs.runs.find((run) => run.run_id === "run-root")).toMatchObject({
      source_guild: "workspace",
      comparison_eligible: true,
      event_count: 2,
    });
    expect(runs.runs.find((run) => run.run_id === "run-alpha")).toMatchObject({
      source_guild: "alpha",
      comparison_eligible: false,
      comparison_reasons: expect.arrayContaining(["no trace events"]),
    });

    const initiatives = await listProjectInitiatives(root);
    expect(initiatives.initiatives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "guild-dashboard",
          source_guild: "workspace",
          eligible_run_ids: ["run-root"],
          comparison_eligible: true,
        }),
        expect.objectContaining({
          id: "alpha-work",
          source_guild: "alpha",
          eligible_run_ids: [],
          comparison_eligible: false,
        }),
      ]),
    );

    const targets = await listProjectComparisonTargets(root);
    expect(targets.targets.map((target) => target.id)).toEqual(
      expect.arrayContaining([
        "initiative:workspace:guild-dashboard",
        "run:workspace:run-root",
      ]),
    );
    expect(targets.targets.some((target) => target.id.includes("alpha-work"))).toBe(false);

    const comparison = await compareProjectTargets(
      root,
      "initiative:workspace:guild-dashboard",
      "initiative:workspace:guild-dashboard",
    );
    expect(comparison.status).toBe("ok");
    expect(comparison.baseline.total_events).toBe(2);

    const analysis = await analyzeProjectTarget(root, {
      target_kind: "initiative",
      target_id: "initiative:workspace:guild-dashboard",
    });
    expect(analysis.signals.join(" ")).toMatch(/trace events/);
    expect(analysis.actions.map((action) => action.command)).toEqual(
      expect.arrayContaining([
        "/guild:reflect --initiative guild-dashboard",
        "/guild:learn",
        "/guild:evolve <skill-name>",
      ]),
    );
  });
});

describe("project-reader / listProjectWikiPages", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-wiki-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plain root: lists nested pages with title, source_guild and labels", async () => {
    await seedPlainProject(root);
    const res = await listProjectWikiPages(root);
    const paths = res.pages.map((p) => p.path);
    expect(paths).toEqual([
      "decisions/adopt-traversal-guard.md",
      "index.md",
      "notes/untitled.md",
    ]);
    const decision = res.pages[0];
    expect(decision.title).toBe("adopt-traversal-guard");
    expect(decision.source_guild).toBe("project");
    expect(decision.labels).toEqual(["architecture", "security"]);
    const index = res.pages[1];
    expect(index.title).toBe("Guild Wiki Index");
    expect(index.labels).toBeUndefined();
    // No H1 → filename fallback.
    expect(res.pages[2].title).toBe("untitled");
  });

  it("workspace root: only wiki-bearing sub-guilds contribute, tagged + grouped", async () => {
    await seedWorkspaceProject(root);
    const res = await listProjectWikiPages(root);
    expect(res.pages.every((p) => p.source_guild === "alpha")).toBe(true);
    const standards = res.pages.find((p) => p.path === "standards/hooks.md");
    expect(standards?.labels).toEqual(["hooks", "shell"]); // block-list labels
  });

  it("no wiki anywhere → ProjectReadError(not_found)", async () => {
    await expect(listProjectWikiPages(root)).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("empty wiki dir → 200-shaped empty list, not an error", async () => {
    await writeFileDeep(join(root, ".guild", "wiki", ".gitkeep"), "");
    const res = await listProjectWikiPages(root);
    expect(res.pages).toEqual([]);
  });
});

describe("project-reader / readProjectWikiPage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-page-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("plain root: returns content with source_guild=project (guild param optional)", async () => {
    await seedPlainProject(root);
    const res = await readProjectWikiPage(root, "decisions/adopt-traversal-guard.md");
    expect(res.source_guild).toBe("project");
    expect(res.path).toBe("decisions/adopt-traversal-guard.md");
    expect(res.content).toContain("safeJoinUnder everywhere");
  });

  it("workspace root with one wiki source: guild param defaults to it", async () => {
    await seedWorkspaceProject(root);
    const res = await readProjectWikiPage(root, "index.md");
    expect(res.source_guild).toBe("alpha");
    expect(res.content).toContain("Alpha Wiki");
  });

  it("workspace root with two wiki sources: guild param required (ambiguous)", async () => {
    await seedWorkspaceProject(root);
    // Promote beta to a wiki-bearing guild on disk.
    await writeFileDeep(
      join(root, "beta", ".guild", "wiki", "index.md"),
      "# Beta Wiki\n",
    );
    await expect(readProjectWikiPage(root, "index.md")).rejects.toMatchObject({
      kind: "ambiguous_guild",
    });
    const beta = await readProjectWikiPage(root, "index.md", "beta");
    expect(beta.source_guild).toBe("beta");
    expect(beta.content).toContain("Beta Wiki");
  });

  it("unknown guild → not_found", async () => {
    await seedWorkspaceProject(root);
    await expect(
      readProjectWikiPage(root, "index.md", "nope"),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("rejects relative traversal (../../etc/passwd)", async () => {
    await seedPlainProject(root);
    await expect(
      readProjectWikiPage(root, "../../etc/passwd"),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("rejects absolute paths", async () => {
    await seedPlainProject(root);
    await expect(readProjectWikiPage(root, "/etc/passwd")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("rejects sneaky mid-path traversal that escapes the wiki root", async () => {
    await seedPlainProject(root);
    // Resolves to <root>/.guild/secrets.md — outside wiki/.
    await writeFileDeep(join(root, ".guild", "secrets.md"), "# secret\n");
    await expect(
      readProjectWikiPage(root, "decisions/../../secrets.md"),
    ).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("missing page → not_found; empty path → bad_request", async () => {
    await seedPlainProject(root);
    await expect(readProjectWikiPage(root, "nope.md")).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(readProjectWikiPage(root, "  ")).rejects.toMatchObject({
      kind: "bad_request",
    });
  });

  it("no wiki dir at all → not_found", async () => {
    await expect(readProjectWikiPage(root, "index.md")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});

describe("project-reader / pure helpers", () => {
  it("extractTitle: first H1 wins; setext/## ignored; filename fallback", () => {
    expect(extractTitle("# Title One\n# Title Two\n", "x.md")).toBe("Title One");
    expect(extractTitle("## Subheading only\n", "dir/page-name.md")).toBe("page-name");
    expect(extractTitle("", "a/b/c.md")).toBe("c");
  });

  it("extractFrontmatterLabels: inline flow list with quotes", () => {
    const md = `---\nlabels: ["a", 'b', c]\n---\nbody\n`;
    expect(extractFrontmatterLabels(md)).toEqual(["a", "b", "c"]);
  });

  it("extractFrontmatterLabels: empty inline list / scalar / absent → undefined", () => {
    expect(extractFrontmatterLabels("---\nlabels: []\n---\n")).toBeUndefined();
    expect(extractFrontmatterLabels("---\nlabels: just-a-string\n---\n")).toBeUndefined();
    expect(extractFrontmatterLabels("---\ntype: note\n---\n")).toBeUndefined();
    expect(extractFrontmatterLabels("no frontmatter\n")).toBeUndefined();
    expect(extractFrontmatterLabels("---\nunterminated frontmatter\n")).toBeUndefined();
  });

  it("extractFrontmatterLabels: block list stops at the first non-item line", () => {
    const md = ["---", "labels:", "  - one", "  - two", "owner: x", "---", ""].join("\n");
    expect(extractFrontmatterLabels(md)).toEqual(["one", "two"]);
    const empty = ["---", "labels:", "owner: x", "---", ""].join("\n");
    expect(extractFrontmatterLabels(empty)).toBeUndefined();
  });

  it("safeJoinUnder mirrors the server traversal guard", () => {
    expect(safeJoinUnder("/tmp/root", "a/b.md")).toBe("/tmp/root/a/b.md");
    expect(safeJoinUnder("/tmp/root", "../escape")).toBeNull();
    expect(safeJoinUnder("/tmp/root", "..")).toBeNull();
    expect(safeJoinUnder("/tmp/root", "/abs/leading")).toBe("/tmp/root/abs/leading");
    expect(safeJoinUnder("/tmp/root", "a/../../escape")).toBeNull();
  });
});

// ---- D01 (C-ANALYSIS) — plugin-produced analysis artifacts -------------------
//
// Acceptance: D01-AC1 (no detector/hash duplication — asserted by source grep
// below plus pass-through assertions), D01-AC2 (wrong-run, malformed, symlink
// escape, unsupported schema all rejected), D01-AC3 (suite runs against tmp
// fixtures with no sibling plugin source).

import { readFileSync as d01ReadFileSync, symlinkSync as d01SymlinkSync } from "node:fs";
import { resolve as d01Resolve } from "node:path";
import {
  listProjectAnalysisArtifacts,
  readProjectAnalysisArtifact,
} from "../src/project-reader.js";
import {
  RUN_ANALYSIS_ENTRY,
  SUPPORTED_INVENTORY_SCHEMA,
  resolvePackagedRuntime,
  type PackagedRuntime,
} from "../src/analysis-process.js";

const VALID_RUN_ID = "run-20261017-010000-example-a";
const VALID_COMPARISON_ID = "comparison-abac869491a330d9";

function sampleRecommendation(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "guild.recommendation.v1",
    id: "rec-a6e61633056fba7d",
    source_id: sourceId,
    source_analysis_id: `analysis:${sourceId}:1b4f1c74f378`,
    scope: "project",
    kind: "clarify_prompt_contract",
    confidence: "high",
    severity: "high",
    evidence_refs: [`.guild/runs/${sourceId}/logs/v1.4-events.jsonl#line:8`],
    evidence_signature: "5ab52c7fd47e96688bfb43e979eca10620a1280098d56e4d45aa1d7b8a7156ee",
    affected_runs: [sourceId],
    proposed_action: "The same failed action recurred 2 times.",
    status: "proposed",
    suggested_owner: "project",
    next_action: "queue_proposal_only",
    requires_user_approval: true,
    routing: { action: "queue_proposal_only", requires_user_approval: true, target: "project-local" },
    ...overrides,
  };
}

function sampleRunAnalysis(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "guild.run_analysis.v1",
    analysis_id: `analysis:${runId}:1b4f1c74f378`,
    run_id: runId,
    source_hash: "1b4f1c74f378d71d89f706b4e019468486321894419facec6c7661b48370628a",
    eligible: true,
    identity: { run_scope: "independent", initiative_id: null, independent_group_id: "g", config_snapshot_ref: null, host: "codex", phase: "build" },
    completeness: { score: 100, present: ["agent"], missing: [] },
    assessments: {},
    usage: { llm_event_count: 2, specialists_dispatched: [], tokens: { input: 1, output: 1, cached: 0, total: 2, cost_usd: 0 }, duration_ms: 1 },
    findings: [{ id: "finding-1", kind: "repeated_failure", severity: "high", summary: "s", evidence_refs: [], signature: "sig" }],
    recommendations: [sampleRecommendation(runId)],
    ...overrides,
  };
}

function sampleComparison(comparisonId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "guild.run_comparison.v1",
    comparison_id: comparisonId,
    run_ids: [VALID_RUN_ID, "run-20261017-010100-example-b"],
    source_hashes: ["a".repeat(64), "b".repeat(64)],
    completeness: { eligible_runs: 2, total_runs: 2, average_score: 100 },
    repeated_signatures: [],
    recommendations: [sampleRecommendation(comparisonId, { source_analysis_id: comparisonId })],
    ...overrides,
  };
}

async function seedAnalysisFixtures(root: string): Promise<void> {
  await writeFileDeep(
    join(root, ".guild", "analysis", "runs", VALID_RUN_ID, "analysis.json"),
    JSON.stringify(sampleRunAnalysis(VALID_RUN_ID), null, 2),
  );
  await writeFileDeep(
    join(root, ".guild", "analysis", "comparisons", VALID_COMPARISON_ID, "comparison.json"),
    JSON.stringify(sampleComparison(VALID_COMPARISON_ID), null, 2),
  );
  await writeFileDeep(
    join(root, ".guild", "recommendations", `${VALID_RUN_ID}.jsonl`),
    [
      JSON.stringify(sampleRecommendation(VALID_RUN_ID)),
      "{not json",
      JSON.stringify(sampleRecommendation("some-other-run")),
      "",
    ].join("\n"),
  );
}

// Minimal packaged-runtime fixture whose inspect answers depend on the id
// suffix — reuses the D00 validation path end to end (no plugin source).
const D01_FAKE_ENTRY = `
const args = process.argv.slice(2);
const kind = args[2];
const id = args[3];
function out(state, eligible) {
  process.stdout.write(JSON.stringify({
    ok: state === "current", state, kind, source_id: id,
    artifact_ref: state === "missing" ? null : "ref", schema_version: state === "missing" ? null : "guild.run_analysis.v1",
    source_analysis_id: null, source_hash: null, current_source_hash: null,
    input_hash: null, current_input_hash: null, eligible, reason: state === "current" ? null : state,
  }));
  process.exit(0);
}
if (id.endsWith("example-a")) out("current", true);
else if (id.startsWith("comparison-")) out("stale", false);
else if (id.endsWith("-missing")) out("missing", false);
else { process.stderr.write("refused"); process.exit(1); }
`;

async function seedRuntimeFixture(dir: string): Promise<PackagedRuntime> {
  await writeFileDeep(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "guild", version: "3.1.0" }),
  );
  await writeFileDeep(
    join(dir, "guild.inventory.json"),
    JSON.stringify({
      schema_version: SUPPORTED_INVENTORY_SCHEMA,
      plugin_version: "3.1.0",
      manifest: { name: "guild", version: "3.1.0" },
      scripts: [{ id: "run-analysis", kind: "cli" }],
    }),
  );
  await writeFileDeep(join(dir, RUN_ANALYSIS_ENTRY), D01_FAKE_ENTRY);
  return resolvePackagedRuntime(dir);
}

describe("project-reader / analysis artifacts (D01)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-analysis-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists valid run + comparison artifacts with pass-through metadata", async () => {
    await seedAnalysisFixtures(root);
    const res = await listProjectAnalysisArtifacts(root);
    expect(res.total).toBe(2);
    const run = res.artifacts.find((a) => a.kind === "run");
    expect(run).toMatchObject({
      id: VALID_RUN_ID,
      source_guild: "project",
      validation: "valid",
      artifact_eligible: true,
      recommendation_count: 1,
      finding_count: 1,
      invalid_recommendation_rows: 0,
    });
    expect(run?.analysis_id).toBe(`analysis:${VALID_RUN_ID}:1b4f1c74f378`);
    const cmp = res.artifacts.find((a) => a.kind === "comparison");
    expect(cmp).toMatchObject({ id: VALID_COMPARISON_ID, validation: "valid", artifact_eligible: null });
  });

  it("rejects a wrong-run artifact (run_id differs from its directory)", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-dir-name", "analysis.json"),
      JSON.stringify(sampleRunAnalysis("run-OTHER-id")),
    );
    const res = await listProjectAnalysisArtifacts(root);
    expect(res.artifacts[0].validation).toBe("wrong_source");
  });

  it("rejects malformed JSON and unsupported schema distinctly", async () => {
    await writeFileDeep(join(root, ".guild", "analysis", "runs", "run-bad", "analysis.json"), "{nope");
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-v2", "analysis.json"),
      JSON.stringify(sampleRunAnalysis("run-v2", { schema_version: "guild.run_analysis.v2" })),
    );
    const res = await listProjectAnalysisArtifacts(root);
    const byId = Object.fromEntries(res.artifacts.map((a) => [a.id, a.validation]));
    expect(byId["run-bad"]).toBe("malformed");
    expect(byId["run-v2"]).toBe("unsupported_schema");
  });

  it("rejects a symlink-escape artifact (D01-AC2)", async () => {
    const outside = join(root, "..", `outside-${Date.now()}.json`);
    await writeFileDeep(d01Resolve(outside), JSON.stringify(sampleRunAnalysis("run-escape")));
    await writeFileDeep(join(root, ".guild", "analysis", "runs", "run-escape", ".keep"), "");
    d01SymlinkSync(
      d01Resolve(outside),
      join(root, ".guild", "analysis", "runs", "run-escape", "analysis.json"),
    );
    const res = await listProjectAnalysisArtifacts(root);
    expect(res.artifacts[0].validation).toBe("malformed");
    await rm(d01Resolve(outside), { force: true });
  });

  it("marks an artifact with invalid recommendation rows as partial, counted", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-part", "analysis.json"),
      JSON.stringify(
        sampleRunAnalysis("run-part", {
          recommendations: [
            sampleRecommendation("run-part"),
            { schema_version: "guild.recommendation.v1", id: "rec-x" }, // missing fields
            sampleRecommendation("run-part", { requires_user_approval: false }),
          ],
        }),
      ),
    );
    const res = await listProjectAnalysisArtifacts(root);
    expect(res.artifacts[0].validation).toBe("partial");
    expect(res.artifacts[0].invalid_recommendation_rows).toBe(2);
    expect(res.artifacts[0].recommendation_count).toBe(3);
  });

  it("detail: validates the recommendations ledger and reports unavailable freshness without a runtime", async () => {
    await seedAnalysisFixtures(root);
    const detail = await readProjectAnalysisArtifact(root, "run", VALID_RUN_ID);
    expect(detail.summary.validation).toBe("valid");
    expect(detail.artifact?.run_id).toBe(VALID_RUN_ID);
    // 1 valid row for this source; the malformed line and the other-source
    // row are counted invalid (never silently merged).
    expect(detail.recommendations).toHaveLength(1);
    expect(detail.recommendations[0].source_id).toBe(VALID_RUN_ID);
    expect(detail.invalid_recommendation_lines).toBe(2);
    expect(detail.freshness).toEqual({ state: "unavailable", reason: "analysis_package_unconfigured" });
  });

  it("detail: absent artifact still resolves (producer-authoritative missing), 400 unsafe id", async () => {
    await seedAnalysisFixtures(root);
    // Without a runtime: absent + unavailable (never not_found-before-inspect).
    const absent = await readProjectAnalysisArtifact(root, "run", "run-nope");
    expect(absent.summary.validation).toBe("absent");
    expect(absent.freshness.state).toBe("unavailable");
    // With a runtime: the PRODUCER reports missing.
    const runtime = await seedRuntimeFixture(join(root, "pkg-missing"));
    const missing = await readProjectAnalysisArtifact(root, "run", "run-nope-missing", undefined, runtime);
    expect(missing.summary.validation).toBe("absent");
    expect(missing.freshness.state).toBe("missing");
    await expect(readProjectAnalysisArtifact(root, "run", "../etc")).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("detail: embedded recommendation bound to another source is counted invalid (codex F2)", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-bind", "analysis.json"),
      JSON.stringify(
        sampleRunAnalysis("run-bind", {
          recommendations: [sampleRecommendation("run-OTHER")],
        }),
      ),
    );
    const res = await listProjectAnalysisArtifacts(root);
    expect(res.artifacts[0].validation).toBe("partial");
    expect(res.artifacts[0].invalid_recommendation_rows).toBe(1);
  });

  it("comparison recommendation naming another comparison's analysis id is invalid (codex F2 r2)", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "comparisons", "comparison-bind", "comparison.json"),
      JSON.stringify(
        sampleComparison("comparison-bind", {
          recommendations: [
            sampleRecommendation("comparison-bind", { source_analysis_id: "comparison-OTHER" }),
          ],
        }),
      ),
    );
    const res = await listProjectAnalysisArtifacts(root);
    const cmp = res.artifacts.find((a) => a.id === "comparison-bind");
    expect(cmp?.validation).toBe("partial");
    expect(cmp?.invalid_recommendation_rows).toBe(1);
  });

  it("rejects core-field mutations: null finding rows and missing identity block (codex F1)", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-nullfind", "analysis.json"),
      JSON.stringify(sampleRunAnalysis("run-nullfind", { findings: [null] })),
    );
    const base = sampleRunAnalysis("run-noident") as Record<string, unknown>;
    delete base.identity;
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-noident", "analysis.json"),
      JSON.stringify(base),
    );
    const res = await listProjectAnalysisArtifacts(root);
    const byId = Object.fromEntries(res.artifacts.map((a) => [a.id, a.validation]));
    expect(byId["run-nullfind"]).toBe("malformed");
    expect(byId["run-noident"]).toBe("malformed");
  });

  it("detail: producer-authoritative freshness through the packaged transport (current/stale/refused)", async () => {
    await seedAnalysisFixtures(root);
    const runtime = await seedRuntimeFixture(join(root, "pkg"));
    const current = await readProjectAnalysisArtifact(root, "run", VALID_RUN_ID, undefined, runtime);
    expect(current.freshness).toEqual({ state: "current", reason: null, decision_eligible: true });
    const stale = await readProjectAnalysisArtifact(root, "comparison", VALID_COMPARISON_ID, undefined, runtime);
    // B04 F4: decision eligibility comes from INSPECT (false here) even
    // though the stored artifact itself exists and validates.
    expect(stale.freshness).toEqual({ state: "stale", reason: "stale", decision_eligible: false });
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-refused-x", "analysis.json"),
      JSON.stringify(sampleRunAnalysis("run-refused-x")),
    );
    const refused = await readProjectAnalysisArtifact(root, "run", "run-refused-x", undefined, runtime);
    expect(refused.freshness.state).toBe("refused");
  });

  it("workspace mode: same artifact id in two sub-guilds needs the guild parameter", async () => {
    await writeFileDeep(
      join(root, ".guild", "workspace.json"),
      JSON.stringify({
        schema_version: "guild.workspace.v1",
        sub_guilds: [
          { name: "alpha", path: "alpha" },
          { name: "beta", path: "beta" },
        ],
      }),
    );
    for (const child of ["alpha", "beta"]) {
      await writeFileDeep(
        join(root, child, ".guild", "analysis", "runs", VALID_RUN_ID, "analysis.json"),
        JSON.stringify(sampleRunAnalysis(VALID_RUN_ID)),
      );
    }
    await expect(readProjectAnalysisArtifact(root, "run", VALID_RUN_ID)).rejects.toMatchObject({
      kind: "ambiguous_guild",
    });
    const scoped = await readProjectAnalysisArtifact(root, "run", VALID_RUN_ID, "beta");
    expect(scoped.summary.source_guild).toBe("beta");
  });

  it("D01-AC1: benchmark source implements no canonical hash/detector algorithm", () => {
    const src = d01ReadFileSync(d01Resolve(__dirname, "..", "src", "project-reader.ts"), "utf8");
    // Freshness fields are passed through / compared by the producer; the
    // reader itself never computes a digest or classifies findings.
    expect(src).not.toMatch(/createHash|crypto/);
    expect(src).not.toMatch(/instruction_violation|repeated_failure.*signature\s*=/);
  });
});

describe("project-reader / analysis hardening (codex r3 + security)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "proj-analysis-hard-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("comparison LEDGER row naming another comparison's analysis id is invalid", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "comparisons", "comparison-l", "comparison.json"),
      JSON.stringify(sampleComparison("comparison-l", { recommendations: [] })),
    );
    await writeFileDeep(
      join(root, ".guild", "recommendations", "comparison-l.jsonl"),
      JSON.stringify(
        sampleRecommendation("comparison-l", { source_analysis_id: "comparison-OTHER" }),
      ) + "\n",
    );
    const detail = await readProjectAnalysisArtifact(root, "comparison", "comparison-l");
    expect(detail.recommendations).toHaveLength(0);
    expect(detail.invalid_recommendation_lines).toBe(1);
  });

  it("refuses an oversized artifact and an oversized ledger (security F2)", async () => {
    const pad = "x".repeat(9 * 1024 * 1024);
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-huge", "analysis.json"),
      JSON.stringify({ ...sampleRunAnalysis("run-huge"), pad }),
    );
    const res = await listProjectAnalysisArtifacts(root);
    expect(res.artifacts[0].validation).toBe("malformed");
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-okay", "analysis.json"),
      JSON.stringify(sampleRunAnalysis("run-okay", { recommendations: [] })),
    );
    await writeFileDeep(join(root, ".guild", "recommendations", "run-okay.jsonl"), pad);
    const detail = await readProjectAnalysisArtifact(root, "run", "run-okay");
    expect(detail.recommendations).toHaveLength(0);
    expect(detail.invalid_recommendation_lines).toBe(1);
  });

  it("detail parses the artifact exactly once (no reopen window) and returns it", async () => {
    await writeFileDeep(
      join(root, ".guild", "analysis", "runs", "run-once", "analysis.json"),
      JSON.stringify(sampleRunAnalysis("run-once", { recommendations: [] })),
    );
    const detail = await readProjectAnalysisArtifact(root, "run", "run-once");
    expect(detail.summary.validation).toBe("valid");
    expect(detail.artifact?.analysis_id).toBe("analysis:run-once:1b4f1c74f378");
  });
});
