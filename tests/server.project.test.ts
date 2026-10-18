import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type {
  ProjectKnowledgeGraphResponse,
  ProjectAnalysisResponse,
  ProjectComparisonResponse,
  ProjectComparisonTargetsResponse,
  ProjectInitiativesResponse,
  ProjectOverviewResponse,
  ProjectRunsListResponse,
  ProjectWikiListResponse,
  ProjectWikiPageResponse,
} from "../src/types.js";
import { req, seedCase, seedRun } from "./server.helpers.js";
import { seedPlainProject, seedWorkspaceProject, writeFileDeep } from "./project.helpers.js";

// HTTP integration — /api/project/* (SC-12, v2-gap-closure G-17).
// Contract: .guild/spec/v2-gap-closure.md §"The cross-repo dashboard contract".

describe("server / /api/project/* — live-project knowledge routes", () => {
  let runsDir: string;
  let casesDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "qa-proj-runs-"));
    casesDir = await mkdtemp(join(tmpdir(), "qa-proj-cases-"));
    projectRoot = await mkdtemp(join(tmpdir(), "qa-proj-root-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
    await rm(casesDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  // ---- codex finding #4 — explicit no-flag regression --------------------

  describe("no --project-root (regression: behavior-identical to today)", () => {
    it("project routes return 404 {error} when projectRoot is not configured", async () => {
      await seedPlainProject(projectRoot); // present on disk but NOT configured
      const app = createApp({ runsDir, casesDir, port: 0 });
      for (const path of [
        "/api/project/knowledge-graph",
        "/api/project/wiki",
        "/api/project/wiki/page?path=index.md",
      ]) {
        const res = await app.fetch(req(path));
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/no project root configured/);
      }
    });

    it("existing routes are untouched: same responses with and without the flag", async () => {
      await seedRun(runsDir, "demo-001");
      await seedCase(casesDir, "demo-case", "Demo case");
      await seedPlainProject(projectRoot);
      const without = createApp({ runsDir, casesDir, port: 0 });
      const withFlag = createApp({ runsDir, casesDir, port: 0, projectRoot });
      for (const path of [
        "/api/runs",
        "/api/runs/demo-001",
        "/api/cases",
        "/api/runs/missing-run",
        "/api/does-not-exist",
      ]) {
        const a = await without.fetch(req(path));
        const b = await withFlag.fetch(req(path));
        expect(b.status).toBe(a.status);
        expect(await b.text()).toBe(await a.text());
      }
    });
  });

  // ---- GET /api/project/knowledge-graph ----------------------------------

  describe("GET /api/project/overview and /api/project/runs", () => {
    it("reports live workspace runs and overview totals", async () => {
      await seedWorkspaceProject(projectRoot);
      await writeFileDeep(
        join(projectRoot, ".guild", "runs", "run-root", "run.yaml"),
        "schema_version: guild.run.v1\nrun_id: run-root\ncommand: dashboard\nstarted_at: 2026-06-10T10:00:00Z\n",
      );
      await writeFileDeep(
        join(projectRoot, ".guild", "runs", "run-root", "logs", "v1.4-events.jsonl"),
        "{\"event\":\"run_started\"}\n",
      );
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });

      const overviewRes = await app.fetch(req("/api/project/overview"));
      expect(overviewRes.status).toBe(200);
      const overview = (await overviewRes.json()) as ProjectOverviewResponse;
      expect(overview.mode).toBe("workspace");
      expect(overview.totals.runs).toBe(1);

      const runsRes = await app.fetch(req("/api/project/runs"));
      expect(runsRes.status).toBe(200);
      const runs = (await runsRes.json()) as ProjectRunsListResponse;
      expect(runs.total).toBe(1);
      expect(runs.runs[0]).toMatchObject({
        run_id: "run-root",
        source_guild: "workspace",
        command: "dashboard",
      });
    });

    it("serves initiatives, eligible comparison targets, project comparisons and analysis actions", async () => {
      await seedWorkspaceProject(projectRoot);
      await writeFileDeep(
        join(projectRoot, ".guild", "runs", "run-root", "run.yaml"),
        "schema_version: guild.run.v1\nrun_id: run-root\ncommand: /guild:initiative\ninitiative_attachment: guild-dashboard\nstarted_at: 2026-06-10T10:00:00Z\n",
      );
      await writeFileDeep(
        join(projectRoot, ".guild", "runs", "run-root", "provenance.json"),
        JSON.stringify({
          run_id: "run-root",
          status: "closed",
          initiative: "guild-dashboard",
          benchmark_eligible: true,
        }),
      );
      await writeFileDeep(
        join(projectRoot, ".guild", "runs", "run-root", "logs", "v1.4-events.jsonl"),
        "{\"event_name\":\"run_started\"}\n{\"event_name\":\"run_closed\"}\n",
      );
      await writeFileDeep(
        join(projectRoot, ".guild", "initiatives", "active", "guild-dashboard", "initiative.yaml"),
        "id: guild-dashboard\ntitle: Guild dashboard\nscope: workspace\nstatus: in_progress\nrun_id: run-root\n",
      );
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });

      const initiativesRes = await app.fetch(req("/api/project/initiatives"));
      expect(initiativesRes.status).toBe(200);
      const initiatives = (await initiativesRes.json()) as ProjectInitiativesResponse;
      expect(initiatives.initiatives[0]).toMatchObject({
        id: "guild-dashboard",
        source_guild: "workspace",
        comparison_eligible: true,
      });

      const targetsRes = await app.fetch(req("/api/project/comparison-targets"));
      expect(targetsRes.status).toBe(200);
      const targets = (await targetsRes.json()) as ProjectComparisonTargetsResponse;
      expect(targets.targets.map((target) => target.id)).toContain(
        "initiative:workspace:guild-dashboard",
      );

      const comparisonRes = await app.fetch(
        req(
          "/api/project/comparisons?baseline=initiative%3Aworkspace%3Aguild-dashboard&candidate=initiative%3Aworkspace%3Aguild-dashboard",
        ),
      );
      expect(comparisonRes.status).toBe(200);
      const comparison = (await comparisonRes.json()) as ProjectComparisonResponse;
      expect(comparison.status).toBe("ok");
      expect(comparison.baseline.total_events).toBe(2);

      const analyzeRes = await app.fetch(
        req("/api/project/analyze", {
          method: "POST",
          body: JSON.stringify({
            target_kind: "initiative",
            target_id: "initiative:workspace:guild-dashboard",
          }),
          headers: { "content-type": "application/json" },
        }),
      );
      expect(analyzeRes.status).toBe(200);
      const analysis = (await analyzeRes.json()) as ProjectAnalysisResponse;
      // D03: the print-only /guild:evolve alias is retired (C06/KTD14); the
      // evolve pointer is now a DISABLED template naming the live maintain
      // sub-verb in its label (no placeholder command is copyable).
      expect(analysis.actions.map((action) => action.label).join("\n")).toContain(
        "/guild:maintain evolve",
      );
    });
  });

  describe("GET /api/project/knowledge-graph", () => {
    it("plain root: 200 {nodes, edges, sources} with source_guild=project", async () => {
      await seedPlainProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/knowledge-graph"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectKnowledgeGraphResponse;
      expect(body.nodes.length).toBe(3);
      expect(body.edges.length).toBe(2);
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0].guild).toBe("project");
      expect(body.nodes.every((n) => n.source_guild === "project")).toBe(true);
      expect(body.edges.every((e) => e.source_guild === "project")).toBe(true);
    });

    it("workspace root: federates sub-guild graphs with per-source tagging", async () => {
      await seedWorkspaceProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/knowledge-graph"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectKnowledgeGraphResponse;
      expect(body.sources.map((s) => s.guild)).toEqual(["alpha", "beta"]);
      const guilds = new Set(body.nodes.map((n) => n.source_guild));
      expect(guilds).toEqual(new Set(["alpha", "beta"]));
    });

    it("200 empty graph when no knowledge graph or codebase map exists under the root", async () => {
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/knowledge-graph"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectKnowledgeGraphResponse;
      expect(body.nodes).toEqual([]);
      expect(body.edges).toEqual([]);
      expect(body.sources).toEqual([]);
      expect(body.empty_reason).toMatch(/no knowledge graph or codebase map/);
    });
  });

  // ---- GET /api/project/wiki ----------------------------------------------

  describe("GET /api/project/wiki", () => {
    it("plain root: 200 {pages} with path/title/source_guild/labels", async () => {
      await seedPlainProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/wiki"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectWikiListResponse;
      expect(body.pages.map((p) => p.path)).toContain("decisions/adopt-traversal-guard.md");
      const decision = body.pages.find(
        (p) => p.path === "decisions/adopt-traversal-guard.md",
      )!;
      expect(decision.title).toBe("adopt-traversal-guard");
      expect(decision.source_guild).toBe("project");
      expect(decision.labels).toEqual(["architecture", "security"]);
    });

    it("workspace root: pages tagged with their sub-guild", async () => {
      await seedWorkspaceProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/wiki"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectWikiListResponse;
      expect(body.pages.length).toBeGreaterThan(0);
      expect(body.pages.every((p) => p.source_guild === "alpha")).toBe(true);
    });

    it("404 {error} when no wiki dir exists under the root", async () => {
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/wiki"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/wiki/);
    });
  });

  // ---- GET /api/project/wiki/page -----------------------------------------

  describe("GET /api/project/wiki/page", () => {
    it("plain root: 200 {path, source_guild, content}", async () => {
      await seedPlainProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(
        req("/api/project/wiki/page?path=decisions%2Fadopt-traversal-guard.md"),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProjectWikiPageResponse;
      expect(body.path).toBe("decisions/adopt-traversal-guard.md");
      expect(body.source_guild).toBe("project");
      expect(body.content).toContain("safeJoinUnder everywhere");
    });

    it("workspace mode: &guild= selects the sub-guild; required when ambiguous", async () => {
      await seedWorkspaceProject(projectRoot);
      // Two wiki-bearing guilds → ambiguous without &guild=.
      await writeFileDeep(
        join(projectRoot, "beta", ".guild", "wiki", "index.md"),
        "# Beta Wiki\n",
      );
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });

      const ambiguous = await app.fetch(req("/api/project/wiki/page?path=index.md"));
      expect(ambiguous.status).toBe(400);
      expect(((await ambiguous.json()) as { error: string }).error).toMatch(
        /guild query parameter is required/,
      );

      const beta = await app.fetch(
        req("/api/project/wiki/page?path=index.md&guild=beta"),
      );
      expect(beta.status).toBe(200);
      const body = (await beta.json()) as ProjectWikiPageResponse;
      expect(body.source_guild).toBe("beta");
      expect(body.content).toContain("Beta Wiki");
    });

    it("single wiki source in workspace mode: guild param defaults", async () => {
      await seedWorkspaceProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/wiki/page?path=index.md"));
      expect(res.status).toBe(200);
      expect(((await res.json()) as ProjectWikiPageResponse).source_guild).toBe("alpha");
    });

    it("unknown guild → 404", async () => {
      await seedWorkspaceProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(
        req("/api/project/wiki/page?path=index.md&guild=nope"),
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(/unknown guild/);
    });

    it("rejects relative traversal probes with 400", async () => {
      await seedPlainProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(
        req("/api/project/wiki/page?path=..%2F..%2Fetc%2Fpasswd"),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /path traversal denied/,
      );
    });

    it("rejects absolute paths with 400", async () => {
      await seedPlainProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(
        req("/api/project/wiki/page?path=%2Fetc%2Fpasswd"),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(
        /path traversal denied/,
      );
    });

    it("rejects mid-path escapes that resolve outside the wiki root", async () => {
      await seedPlainProject(projectRoot);
      await writeFileDeep(join(projectRoot, ".guild", "secrets.md"), "# secret\n");
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(
        req("/api/project/wiki/page?path=decisions%2F..%2F..%2Fsecrets.md"),
      );
      expect(res.status).toBe(400);
    });

    it("missing ?path= → 400; missing page → 404", async () => {
      await seedPlainProject(projectRoot);
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const noPath = await app.fetch(req("/api/project/wiki/page"));
      expect(noPath.status).toBe(400);
      expect(((await noPath.json()) as { error: string }).error).toMatch(
        /path query parameter is required/,
      );
      const missing = await app.fetch(req("/api/project/wiki/page?path=nope.md"));
      expect(missing.status).toBe(404);
    });
  });
});
