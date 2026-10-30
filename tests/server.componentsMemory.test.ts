import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { listProjectComponents, listProjectMemory } from "../src/guild-components-reader.js";
import { resolveGuildSources, WORKSPACE_JSON_MAX_BYTES } from "../src/project-reader.js";
import type { ProjectComponentsResponse, ProjectMemoryResponse } from "../src/types.js";
import { req } from "./server.helpers.js";
import { writeFileDeep } from "./project.helpers.js";

// GET /api/project/components and GET /api/project/memory — read-only views
// over a served project's `.guild/`.

describe("server / /api/project/{components,memory}", () => {
  let runsDir: string;
  let casesDir: string;
  let projectRoot: string;
  let outside: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "qa-cm-runs-"));
    casesDir = await mkdtemp(join(tmpdir(), "qa-cm-cases-"));
    projectRoot = await mkdtemp(join(tmpdir(), "qa-cm-root-"));
    outside = await mkdtemp(join(tmpdir(), "qa-cm-outside-"));
  });

  afterEach(async () => {
    for (const d of [runsDir, casesDir, projectRoot, outside]) {
      await rm(d, { recursive: true, force: true });
    }
  });

  const app = () => createApp({ runsDir, casesDir, port: 0, projectRoot });

  async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
    const res = await app().fetch(req(path));
    return { status: res.status, body: (await res.json()) as T };
  }

  it("both routes 404 without --project-root", async () => {
    const bare = createApp({ runsDir, casesDir, port: 0 });
    for (const path of ["/api/project/components", "/api/project/memory"]) {
      const res = await bare.fetch(req(path));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toMatch(/no project root/);
    }
  });

  it("absent .guild/ dirs yield empty lists, not errors", async () => {
    const comps = await getJson<ProjectComponentsResponse>("/api/project/components");
    expect(comps.status).toBe(200);
    expect(comps.body.components).toEqual([]);
    expect(comps.body.total).toBe(0);
    const mem = await getJson<ProjectMemoryResponse>("/api/project/memory");
    expect(mem.status).toBe(200);
    expect(mem.body.entries).toEqual([]);
    expect(mem.body.total).toBe(0);
  });

  it("lists agents, skills and registry entries with only stated fields", async () => {
    const g = join(projectRoot, ".guild");
    await writeFileDeep(
      join(g, "agents", "backend.md"),
      "---\nname: backend\ndescription: Builds APIs.\nmodel: opus\ntier: mid\n---\n# backend\n",
    );
    await writeFileDeep(join(g, "agents", "bare.md"), "# no frontmatter\n");
    await writeFileDeep(
      join(g, "skills", "group", "do-thing", "SKILL.md"),
      "---\nname: do-thing\ndescription: Does the thing.\n---\nbody\n",
    );
    await writeFileDeep(
      join(g, "teams", "registry.yaml"),
      "teams:\n  - id: core-team\n    purpose: Ship core work.\n",
    );
    await writeFileDeep(join(g, "workflows", "registry.yaml"), "workflows: []\n");

    const { status, body } = await getJson<ProjectComponentsResponse>("/api/project/components");
    expect(status).toBe(200);
    const byName = Object.fromEntries(body.components.map((c) => [c.name, c]));
    expect(byName.backend).toEqual({
      kind: "agent",
      name: "backend",
      source_guild: "project",
      path: ".guild/agents/backend.md",
      description: "Builds APIs.",
      tier: "mid",
      model: "opus",
    });
    expect(byName.bare).toEqual({
      kind: "agent",
      name: "bare",
      source_guild: "project",
      path: ".guild/agents/bare.md",
    });
    expect(byName["do-thing"]).toMatchObject({
      kind: "skill",
      path: ".guild/skills/group/do-thing/SKILL.md",
      description: "Does the thing.",
    });
    expect(byName["core-team"]).toMatchObject({ kind: "team", description: "Ship core work." });
    expect(body.total).toBe(4);
    expect(body.truncated).toBe(false);
    expect(body.sources[0].present.sort()).toEqual(["agent", "skill", "team", "workflow"]);
  });

  it("lists memory with labelled date sources and bounded excerpts", async () => {
    const m = join(projectRoot, ".guild", "memory");
    await writeFileDeep(
      join(m, "summaries", "fm.md"),
      "---\ntitle: Front Title\ndate: 2026-09-01\n---\n# Heading\n" + "x".repeat(1000) + "\n",
    );
    await writeFileDeep(join(m, "summaries", "body.md"), "# Body dated\nShipped on 2026-08-15.\n");
    await writeFileDeep(join(m, "lessons", "plain.md"), "no date here\n");
    await utimes(join(m, "lessons", "plain.md"), new Date("2026-01-02T03:04:05Z"), new Date("2026-01-02T03:04:05Z"));
    await writeFileDeep(
      join(m, "recall-index.json"),
      JSON.stringify({ schema_version: "guild.recall_index.v1", entries: [{}, {}] }),
    );

    const { status, body } = await getJson<ProjectMemoryResponse>("/api/project/memory");
    expect(status).toBe(200);
    const byPath = Object.fromEntries(body.entries.map((e) => [e.path, e]));
    const fm = byPath[".guild/memory/summaries/fm.md"];
    expect(fm).toMatchObject({ kind: "summary", title: "Front Title", date: "2026-09-01", date_source: "frontmatter", excerpt_truncated: true });
    expect(fm.excerpt!.length).toBe(280);
    expect(byPath[".guild/memory/summaries/body.md"]).toMatchObject({
      title: "Body dated",
      date: "2026-08-15",
      date_source: "content",
      excerpt: "Shipped on 2026-08-15.",
      excerpt_truncated: false,
    });
    expect(byPath[".guild/memory/lessons/plain.md"]).toMatchObject({
      kind: "lesson",
      title: "plain",
      date: "2026-01-02T03:04:05.000Z",
      date_source: "mtime",
    });
    expect(byPath[".guild/memory/recall-index.json"]).toMatchObject({
      kind: "recall-index",
      date_source: "mtime",
      entry_count: 2,
    });
    expect(body.total).toBe(4);
  });

  it("refuses an unknown or traversal-shaped ?guild=", async () => {
    for (const route of ["components", "memory"]) {
      for (const g of ["../../etc", "/etc", "nope"]) {
        const res = await app().fetch(req(`/api/project/${route}?guild=${encodeURIComponent(g)}`));
        expect(res.status).toBe(400);
      }
    }
  });

  it("never reads files or dirs that symlink outside .guild/", async () => {
    await writeFileDeep(join(outside, "secret.md"), "---\nname: leaked\n---\nSECRET\n");
    await writeFileDeep(join(outside, "skills", "x", "SKILL.md"), "---\nname: leaked-skill\n---\n");
    await writeFileDeep(join(outside, "summaries", "s.md"), "# leaked summary\n");
    const g = join(projectRoot, ".guild");
    await writeFileDeep(join(g, "agents", "real.md"), "---\nname: real\n---\n");
    await symlink(join(outside, "secret.md"), join(g, "agents", "evil.md"));
    await symlink(join(outside, "skills"), join(g, "skills"));
    await writeFileDeep(join(g, "memory", "lessons", "ok.md"), "# ok\n");
    await symlink(join(outside, "summaries"), join(g, "memory", "summaries"));
    await symlink(join(outside, "secret.md"), join(g, "memory", "lessons", "evil.md"));

    const comps = await getJson<ProjectComponentsResponse>("/api/project/components");
    expect(comps.body.components.map((c) => c.name)).toEqual(["real"]);
    const mem = await getJson<ProjectMemoryResponse>("/api/project/memory");
    expect(mem.body.entries.map((e) => e.path)).toEqual([".guild/memory/lessons/ok.md"]);
    expect(JSON.stringify(mem.body)).not.toContain("SECRET");
  });

  it("refuses a .guild/ that is itself a symlink out of the project", async () => {
    await writeFileDeep(join(outside, "agents", "a.md"), "---\nname: escaped\n---\n");
    await symlink(outside, join(projectRoot, ".guild"));
    const comps = await getJson<ProjectComponentsResponse>("/api/project/components");
    expect(comps.status).toBe(200);
    expect(comps.body.components).toEqual([]);
  });

  // ---- codex review F1-F4 --------------------------------------------------

  it("F1: refuses a symlinked file even when its target stays inside .guild/", async () => {
    const g = join(projectRoot, ".guild");
    await writeFileDeep(join(g, "notes", "target.md"), "---\nname: via-link\n---\n");
    await writeFileDeep(join(g, "agents", "real.md"), "---\nname: real\n---\n");
    await symlink(join(g, "notes", "target.md"), join(g, "agents", "linked.md"));
    const body = await listProjectComponents(projectRoot);
    expect(body.components.map((c) => c.name)).toEqual(["real"]);
  });

  it("F1: skips a FIFO and an oversized file without hanging", async () => {
    const lessons = join(projectRoot, ".guild", "memory", "lessons");
    await writeFileDeep(join(lessons, "ok.md"), "# ok\n");
    await writeFile(join(lessons, "big.md"), "x".repeat(600 * 1024));
    execFileSync("mkfifo", [join(lessons, "pipe.md")]);
    const body = await listProjectMemory(projectRoot);
    expect(body.entries.map((e) => e.path)).toEqual([".guild/memory/lessons/ok.md"]);
  });

  it("F2: ignores a workspace.json that symlinks out of the project", async () => {
    await writeFileDeep(
      join(outside, "workspace.json"),
      JSON.stringify({ sub_guilds: [{ name: "evil", path: "." }] }),
    );
    await writeFileDeep(join(projectRoot, ".guild", "wiki", "index.md"), "# i\n");
    await symlink(join(outside, "workspace.json"), join(projectRoot, ".guild", "workspace.json"));
    const sources = await resolveGuildSources(projectRoot);
    expect(sources.map((s) => s.name)).toEqual(["project"]);
  });

  it("F2: ignores an oversized workspace.json", async () => {
    const big = JSON.stringify({
      sub_guilds: [{ name: "child", path: "." }],
      pad: "x".repeat(WORKSPACE_JSON_MAX_BYTES),
    });
    await writeFileDeep(join(projectRoot, ".guild", "workspace.json"), big);
    const sources = await resolveGuildSources(projectRoot);
    expect(sources.map((s) => s.name)).toEqual(["project"]);
  });

  it("F2: a FIFO workspace.json does not hang source resolution", async () => {
    await writeFileDeep(join(projectRoot, ".guild", "wiki", "index.md"), "# i\n");
    execFileSync("mkfifo", [join(projectRoot, ".guild", "workspace.json")]);
    const sources = await resolveGuildSources(projectRoot);
    expect(sources.map((s) => s.name)).toEqual(["project"]);
  }, 5000);

  it("F3: stops at the per-request entry budget and reports truncation", async () => {
    const agents = join(projectRoot, ".guild", "agents");
    for (let i = 0; i < 5; i++) await writeFileDeep(join(agents, `a${i}.md`), "# a\n");
    const body = await listProjectComponents(projectRoot, undefined, { maxEntries: 2, maxDirs: 100 });
    expect(body.components).toHaveLength(2);
    expect(body.truncated).toBe(true);
    const mem = await listProjectMemory(projectRoot, undefined, { maxEntries: 2, maxDirs: 100 });
    expect(mem.truncated).toBe(false);
  });

  it("F3: stops at the visited-directory budget across nested skill dirs", async () => {
    const skills = join(projectRoot, ".guild", "skills");
    for (let i = 0; i < 6; i++) {
      await writeFileDeep(join(skills, `s${i}`, "SKILL.md"), `---\nname: s${i}\n---\n`);
    }
    const body = await listProjectComponents(projectRoot, undefined, { maxEntries: 1000, maxDirs: 3 });
    expect(body.truncated).toBe(true);
    expect(body.components.length).toBeLessThan(6);
    const full = await listProjectComponents(projectRoot);
    expect(full.truncated).toBe(false);
    expect(full.components).toHaveLength(6);
  });

  it("F4: a line starting with --- but not exactly --- does not close frontmatter", async () => {
    const agents = join(projectRoot, ".guild", "agents");
    await writeFileDeep(join(agents, "bad.md"), "---\ndescription: leaked\n---not-a-delimiter\nbody\n");
    await writeFileDeep(join(agents, "crlf.md"), "---\r\nname: crlf-agent\r\n--- \r\nbody\r\n");
    const body = await listProjectComponents(projectRoot);
    const byPath = Object.fromEntries(body.components.map((c) => [c.path, c]));
    expect(byPath[".guild/agents/bad.md"]).toEqual({
      kind: "agent",
      name: "bad",
      source_guild: "project",
      path: ".guild/agents/bad.md",
    });
    expect(byPath[".guild/agents/crlf.md"].name).toBe("crlf-agent");
  });
});
