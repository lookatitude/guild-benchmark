import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { req } from "./server.helpers.js";
import { writeFileDeep } from "./project.helpers.js";

// GET /api/project/runs/:run_id/artifacts/* — read-only file route scoped to
// one live project run directory (E01-AC3 followup). Fail-closed.

describe("server / GET /api/project/runs/:run_id/artifacts/*", () => {
  let runsDir: string;
  let casesDir: string;
  let projectRoot: string;
  let outside: string;
  const RUN = "run-20261018-000001-demo";
  const runDir = () => join(projectRoot, ".guild", "runs", RUN);
  const route = (rest: string, run = RUN) => `/api/project/runs/${run}/artifacts/${rest}`;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "qa-pra-runs-"));
    casesDir = await mkdtemp(join(tmpdir(), "qa-pra-cases-"));
    projectRoot = await mkdtemp(join(tmpdir(), "qa-pra-root-"));
    outside = await mkdtemp(join(tmpdir(), "qa-pra-outside-"));
    await writeFileDeep(
      join(runDir(), "run.yaml"),
      `schema_version: guild.run.v1\nrun_id: ${RUN}\ncommand: build\n`,
    );
    await writeFileDeep(join(runDir(), "logs", "v1.4-events.jsonl"), '{"event":"run_started"}\n');
    await writeFileDeep(join(runDir(), "evidence", "page.html"), "<script>alert(1)</script>");
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET");
    await writeFileDeep(join(projectRoot, ".guild", "secret.txt"), "TOP-SECRET");
  });

  afterEach(async () => {
    for (const dir of [runsDir, casesDir, projectRoot, outside]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  const app = () => createApp({ runsDir, casesDir, port: 0, projectRoot });

  it("serves a real file from the run directory, inert and read-only", async () => {
    const res = await app().fetch(req(route("logs/v1.4-events.jsonl")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"event":"run_started"}\n');
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
  });

  it("serves html as inert text, never as a same-origin page", async () => {
    const res = await app().fetch(req(route("evidence/page.html")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("accepts the guild query parameter for the run's source", async () => {
    const res = await app().fetch(req(`${route("run.yaml")}?guild=project`));
    expect(res.status).toBe(200);
    const wrong = await app().fetch(req(`${route("run.yaml")}?guild=elsewhere`));
    expect(wrong.status).toBe(404);
  });

  it.each([
    ["encoded traversal", "..%2F..%2Fsecret.txt"],
    ["absolute (encoded slash)", "%2Fetc%2Fpasswd"],
    ["absolute (empty segment)", "/etc/passwd"],
    ["backslash", "logs%5C..%5C..%5Csecret.txt"],
    ["NUL byte", "run.yaml%00.txt"],
    ["URL scheme", "file:%2F%2F%2Fetc%2Fpasswd"],
    ["drive letter", "C:%2FWindows%2Fwin.ini"],
    ["malformed escape", "logs%E0%A4%A"],
  ])("refuses %s with 400 and never leaks content", async (_label, rest) => {
    const res = await app().fetch(req(route(rest)));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("dot-dot segments normalized by the URL layer never reach a file", async () => {
    const res = await app().fetch(req(route("logs/%2E%2E/%2E%2E/%2E%2E/secret.txt")));
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("refuses a file symlink that escapes the run directory", async () => {
    await symlink(join(outside, "secret.txt"), join(runDir(), "leak.txt"));
    const res = await app().fetch(req(route("leak.txt")));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("refuses a directory symlink that escapes the run directory", async () => {
    await symlink(outside, join(runDir(), "linked"));
    const res = await app().fetch(req(route("linked/secret.txt")));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("serves a colon-bearing name that is not scheme-shaped (UI links it too)", async () => {
    await writeFileDeep(join(runDir(), "1:note.txt"), "colon ok");
    const res = await app().fetch(req(route("1%3Anote.txt")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("colon ok");
    expect((await app().fetch(req(route("http%3Anote.txt")))).status).toBe(400);
  });

  it("refuses a symlinked .guild/runs directory", async () => {
    const realRuns = join(outside, "runs");
    await writeFileDeep(join(realRuns, "run-outside", "run.yaml"), "run_id: run-outside\n");
    await writeFileDeep(join(realRuns, "run-outside", "secret.txt"), "TOP-SECRET");
    await rm(join(projectRoot, ".guild", "runs"), { recursive: true, force: true });
    await symlink(realRuns, join(projectRoot, ".guild", "runs"));
    const res = await app().fetch(req(route("secret.txt", "run-outside")));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("refuses a symlinked run directory", async () => {
    await writeFileDeep(join(outside, "run-link", "run.yaml"), "run_id: run-link\n");
    await writeFileDeep(join(outside, "run-link", "secret.txt"), "TOP-SECRET");
    await symlink(join(outside, "run-link"), join(projectRoot, ".guild", "runs", "run-link"));
    const res = await app().fetch(req(route("secret.txt", "run-link")));
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("refuses a symlinked workspace sub-guild", async () => {
    await writeFileDeep(
      join(projectRoot, ".guild", "workspace.json"),
      JSON.stringify({
        schema_version: "guild.workspace.v1",
        is_workspace: true,
        sub_guilds: [{ name: "child", path: "child" }],
      }),
    );
    const realChild = join(outside, "child");
    await writeFileDeep(join(realChild, ".guild", "runs", "run-child", "run.yaml"), "run_id: run-child\n");
    await writeFileDeep(join(realChild, ".guild", "runs", "run-child", "secret.txt"), "TOP-SECRET");
    await symlink(realChild, join(projectRoot, "child"));
    const res = await app().fetch(req(`${route("secret.txt", "run-child")}?guild=child`));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("TOP-SECRET");
  });

  it("requires guild for an id shared across sources and serves each source's own file", async () => {
    await writeFileDeep(
      join(projectRoot, ".guild", "workspace.json"),
      JSON.stringify({
        schema_version: "guild.workspace.v1",
        is_workspace: true,
        sub_guilds: [
          { name: "a", path: "a" },
          { name: "b", path: "b" },
        ],
      }),
    );
    for (const name of ["a", "b"]) {
      await writeFileDeep(join(projectRoot, name, ".guild", "runs", "run-dup", "run.yaml"), "run_id: run-dup\n");
      await writeFileDeep(join(projectRoot, name, ".guild", "runs", "run-dup", "who.txt"), `from-${name}`);
    }
    expect((await app().fetch(req(route("who.txt", "run-dup")))).status).toBe(400);
    for (const name of ["a", "b"]) {
      const res = await app().fetch(req(`${route("who.txt", "run-dup")}?guild=${name}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`from-${name}`);
    }
  });

  it("refuses an id duplicated inside the selected source", async () => {
    await writeFileDeep(join(projectRoot, ".guild", "runs", "dir-two", "run.yaml"), `run_id: ${RUN}\n`);
    const res = await app().fetch(req(`${route("run.yaml")}?guild=project`));
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown run id and 400 for an unsafe one", async () => {
    expect((await app().fetch(req(route("run.yaml", "run-unknown")))).status).toBe(404);
    expect((await app().fetch(req(route("run.yaml", "bad%20id")))).status).toBe(400);
  });

  it("returns 404 for missing files and directories", async () => {
    await mkdir(join(runDir(), "empty-dir"));
    expect((await app().fetch(req(route("logs/nope.jsonl")))).status).toBe(404);
    expect((await app().fetch(req(route("empty-dir")))).status).toBe(404);
  });

  it("returns 404 when serve has no project root", async () => {
    const res = await createApp({ runsDir, casesDir, port: 0 }).fetch(req(route("run.yaml")));
    expect(res.status).toBe(404);
  });
});
