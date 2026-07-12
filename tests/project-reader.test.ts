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
