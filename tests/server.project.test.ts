import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type {
  ProjectKnowledgeGraphResponse,
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

    it("404 {error} when no knowledge-graph.json exists under the root", async () => {
      const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
      const res = await app.fetch(req("/api/project/knowledge-graph"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/knowledge-graph\.json/);
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
