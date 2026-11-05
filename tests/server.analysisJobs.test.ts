// D02 — local asynchronous packaged-CLI jobs (C-JOBS endpoints).
// Acceptance: D02-AC1 (same active request deduplicates; conflicting active
// request 409s without a second spawn), D02-AC2 (timeout/cancel turn terminal
// only after real child close; partial artifacts remain inspectable),
// D02-AC3 (no arbitrary command/root/body arguments; no canonical file writes
// from benchmark itself).
//
// The packaged producer is a SYNTHETIC fixture package (D00 validation shape)
// whose entry appends one line to a spawn-count file per invocation, so
// "no second spawn" is asserted from actual process starts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/server.js";
import {
  RUN_ANALYSIS_ENTRY,
  SUPPORTED_INVENTORY_SCHEMA,
  resolvePackagedRuntime,
  type PackagedRuntime,
} from "../src/analysis-process.js";

let scratch: string;
let packageRoot: string;
let runtime: PackagedRuntime;
let projectRoot: string;
let spawnLog: string;

/** Producer fixture: parses the closed argv surface, appends to the spawn
 * log, then behaves per the FIRST id:
 *   run-ok-*        → writes .guild/analysis/runs/<id>/analysis.json, ok JSON, exit 0
 *   run-hang-*      → writes a PARTIAL artifact, then never exits
 *   run-fail-*      → stderr + exit 1
 *   run-badout-*    → non-JSON stdout + exit 0
 * recommendation decide echoes its guards back as ok JSON. */
function fakeEntry(spawnLogPath: string): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify("SPAWNLOG")}, JSON.stringify(args) + "\\n");
const cwdIdx = args.indexOf("--cwd");
const root = args[cwdIdx + 1];
function ok(extra) {
  process.stdout.write(JSON.stringify(Object.assign({ ok: true }, extra)));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "analyze") {
  const id = args[2];
  if (id.startsWith("run-ok")) {
    const dir = path.join(root, ".guild", "analysis", "runs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "analysis.json"), JSON.stringify({ schema_version: "guild.run_analysis.v1", run_id: id }));
    fs.writeFileSync(path.join(dir, "analysis.md"), "# analysis");
    // REAL producer shape (E03 F4): written is an OBJECT of ABSOLUTE paths.
    ok({ analysis_id: "analysis:" + id + ":abc", eligible: true, written: { json: path.join(dir, "analysis.json"), markdown: path.join(dir, "analysis.md") } });
  }
  if (id.startsWith("run-hang")) {
    const dir = path.join(root, ".guild", "analysis", "runs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "analysis.json.partial"), "{\\"partial\\":true}");
    setInterval(() => {}, 1000);
  } else if (id.startsWith("run-fail")) {
    process.stderr.write("producer refused: " + id);
    process.exit(1);
  } else if (id.startsWith("run-badout")) {
    process.stdout.write("not json at all");
    process.exit(0);
  }
}
else if (args[0] === "run" && args[1] === "compare") {
  ok({ comparison_id: "comparison-x", run_ids: args.slice(2, cwdIdx), written: ".guild/analysis/comparisons/comparison-x/comparison.json" });
}
else if (args[0] === "recommendation" && args[1] === "decide") {
  ok({ decided: args[4], expected_analysis_id: args[args.indexOf("--expected-analysis-id") + 1] });
}
else if (args[0] === "artifact" && args[1] === "inspect") {
  process.stdout.write(JSON.stringify({ ok: true, state: "current", kind: args[2], source_id: args[3], artifact_ref: "r", schema_version: "s", source_analysis_id: null, source_hash: null, current_source_hash: null, input_hash: null, current_input_hash: null, eligible: true, reason: null }));
  process.exit(0);
}
else { process.stderr.write("unexpected argv: " + JSON.stringify(args)); process.exit(2); }
`.replace(JSON.stringify("SPAWNLOG"), JSON.stringify(spawnLogPath));
}

function makeApp(limits?: { timeoutMs?: number }, withRuntime = true): Hono {
  return createApp({
    runsDir: join(scratch, "bench-runs"),
    casesDir: join(scratch, "cases"),
    port: 0,
    projectRoot,
    ...(withRuntime ? { guildPluginPackage: runtime } : {}),
    ...(limits ? { analysisJobLimits: limits } : {}),
  });
}

const BASE_HEADERS = { host: "127.0.0.1:3055", "content-type": "application/json" };

async function tokenFor(app: Hono): Promise<string> {
  const res = await app.request("/api/project/analysis/session", { headers: BASE_HEADERS });
  expect(res.status).toBe(200);
  return ((await res.json()) as { action_token: string }).action_token;
}

function jobBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source_guild: "project",
    operation: "analyze",
    target_kind: "run",
    ids: ["run-ok-1"],
    idempotency_key: "key-1",
    ...overrides,
  });
}

async function postJob(
  app: Hono,
  token: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request("/api/project/analysis/jobs", {
    method: "POST",
    headers: { ...BASE_HEADERS, "x-guild-action-token": token, ...headers },
    body,
  });
}

async function pollUntilTerminal(app: Hono, jobId: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const res = await app.request(`/api/project/analysis/jobs/${jobId}`, { headers: BASE_HEADERS });
    expect(res.status).toBe(200);
    const job = (await res.json()) as Record<string, unknown>;
    if (job.closed_at !== null) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`job ${jobId} not terminal: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function spawnCount(): number {
  if (!existsSync(spawnLog)) return 0;
  return readFileSync(spawnLog, "utf8").split("\n").filter((l) => l.trim()).length;
}

/** The child process starts asynchronously after the 202 — wait for its
 * spawn-log line before asserting counts. */
async function waitForSpawns(n: number, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (spawnCount() < n) {
    if (Date.now() - started > timeoutMs) throw new Error(`never saw ${n} spawns (have ${spawnCount()})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "d02-jobs-"));
  projectRoot = join(scratch, "project root with spaces");
  mkdirSync(join(projectRoot, ".guild"), { recursive: true });
  spawnLog = join(scratch, "spawn-log.txt");
  packageRoot = join(scratch, "pkg");
  mkdirSync(join(packageRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(join(packageRoot, "runtime", "scripts"), { recursive: true });
  writeFileSync(
    join(packageRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "guild", version: "3.1.0" }),
  );
  writeFileSync(
    join(packageRoot, "guild.inventory.json"),
    JSON.stringify({
      schema_version: SUPPORTED_INVENTORY_SCHEMA,
      plugin_version: "3.1.0",
      manifest: { name: "guild", version: "3.1.0" },
      scripts: [{ id: "run-analysis", kind: "cli" }],
    }),
  );
  writeFileSync(join(packageRoot, RUN_ANALYSIS_ENTRY), fakeEntry(spawnLog));
  runtime = resolvePackagedRuntime(packageRoot);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(spawnLog, { force: true });
  await rm(join(projectRoot, ".guild", "analysis"), { recursive: true, force: true });
});

describe("analysis jobs — happy path + dedup/conflict (D02-AC1)", () => {
  it("creates a job (202 + Location), runs the producer, succeeds with artifact refs", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody());
    expect(res.status).toBe(202);
    expect(res.headers.get("location")).toMatch(/analysis\/jobs\/job-/);
    const job = (await res.json()) as Record<string, unknown>;
    const done = await pollUntilTerminal(app, job.job_id as string);
    expect(done.state).toBe("succeeded");
    expect(done.exit_code).toBe(0);
    // E03 F4 regression: the producer's object-form absolute `written` paths
    // surface as relative artifact refs, never as [].
    expect(done.artifact_refs).toEqual([
      ".guild/analysis/runs/run-ok-1/analysis.json",
      ".guild/analysis/runs/run-ok-1/analysis.md",
    ]);
    // The producer (not benchmark) wrote exactly its artifact.
    expect(existsSync(join(projectRoot, ".guild", "analysis", "runs", "run-ok-1", "analysis.json"))).toBe(true);
    expect(spawnCount()).toBe(1);
  });

  it("deduplicates the same active request without a second spawn; conflicts 409", async () => {
    const app = makeApp({ timeoutMs: 10_000 });
    const token = await tokenFor(app);
    const first = await postJob(app, token, jobBody({ ids: ["run-hang-1"], idempotency_key: "k" }));
    expect(first.status).toBe(202);
    const firstJob = (await first.json()) as Record<string, unknown>;
    await waitForSpawns(1);
    // Identical request while active → SAME job id, still one spawn.
    const dup = await postJob(app, token, jobBody({ ids: ["run-hang-1"], idempotency_key: "k" }));
    expect(dup.status).toBe(202);
    expect(((await dup.json()) as Record<string, unknown>).job_id).toBe(firstJob.job_id);
    await new Promise((r) => setTimeout(r, 200));
    expect(spawnCount()).toBe(1);
    // Different request against the same canonical root → 409, no spawn.
    const conflict = await postJob(app, token, jobBody({ ids: ["run-ok-2"], idempotency_key: "other" }));
    expect(conflict.status).toBe(409);
    expect(spawnCount()).toBe(1);
    // Cleanup: cancel the hanging job and wait for the real close.
    const cancel = await app.request(`/api/project/analysis/jobs/${firstJob.job_id}/cancel`, {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-guild-action-token": token },
    });
    expect(cancel.status).toBe(202);
    const done = await pollUntilTerminal(app, firstJob.job_id as string);
    expect(done.state).toBe("cancelled");
  }, 20_000);

  it("compare and recommendation_decide build the closed argv map", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const cmp = await postJob(
      app,
      token,
      jobBody({ operation: "compare", target_kind: "runs", ids: ["run-a", "run-b"], idempotency_key: "cmp" }),
    );
    expect(cmp.status).toBe(202);
    const cmpDone = await pollUntilTerminal(app, ((await cmp.json()) as Record<string, unknown>).job_id as string);
    expect(cmpDone.state).toBe("succeeded");
    const dec = await postJob(
      app,
      token,
      jobBody({
        operation: "recommendation_decide",
        target_kind: "run",
        ids: ["run-src"],
        idempotency_key: "dec",
        decision: "accept",
        recommendation_id: "rec-1",
        source_analysis_id: "analysis:run-src:abc",
        source_input_hash: "c".repeat(64),
      }),
    );
    expect(dec.status).toBe(202);
    const decDone = await pollUntilTerminal(app, ((await dec.json()) as Record<string, unknown>).job_id as string);
    expect(decDone.state).toBe("succeeded");
    const argvLines = readFileSync(spawnLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const decideArgv = argvLines.find((l) => l[0] === "recommendation");
    expect(decideArgv).toContain("--expected-analysis-id");
    expect(decideArgv).toContain("--expected-input-hash");
    // E03 F3: a bare-hex guard is normalized to the canonical producer form.
    expect(decideArgv?.[decideArgv.indexOf("--expected-input-hash") + 1]).toBe(`sha256:${"c".repeat(64)}`);
  }, 20_000);

  it("E03 F3: recommendation_decide accepts the canonical sha256:<hex> input hash end-to-end", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const canonical = `sha256:${"d".repeat(64)}`;
    const dec = await postJob(
      app,
      token,
      jobBody({
        operation: "recommendation_decide",
        target_kind: "run",
        ids: ["run-src"],
        idempotency_key: "dec-canonical",
        decision: "accept",
        recommendation_id: "rec-1",
        source_analysis_id: "analysis:run-src:abc",
        source_input_hash: canonical,
      }),
    );
    expect(dec.status).toBe(202); // was HTTP 400 before the F3 fix
    const done = await pollUntilTerminal(app, ((await dec.json()) as Record<string, unknown>).job_id as string);
    expect(done.state).toBe("succeeded");
    const argvLines = readFileSync(spawnLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const decideArgv = argvLines.find((l) => l[0] === "recommendation");
    expect(decideArgv?.[decideArgv.indexOf("--expected-input-hash") + 1]).toBe(canonical);
  }, 20_000);

  it("E03 F3: malformed sha256-prefixed hashes are still rejected before any spawn", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    for (const bad of ["sha256:zz", `sha256:${"C".repeat(64)}`, `sha256:${"d".repeat(63)}`, `sha512:${"d".repeat(64)}`]) {
      const res = await postJob(
        app,
        token,
        jobBody({
          operation: "recommendation_decide",
          target_kind: "run",
          ids: ["run-src"],
          idempotency_key: `dec-bad-${bad.length}`,
          decision: "accept",
          recommendation_id: "rec-1",
          source_analysis_id: "analysis:run-src:abc",
          source_input_hash: bad,
        }),
      );
      expect(res.status, bad).toBe(400);
    }
    expect(spawnCount()).toBe(0);
  });
});

describe("analysis jobs — lifecycle bounds (D02-AC2)", () => {
  it("timeout marks terminal timed_out only after real close; partial artifact stays inspectable", async () => {
    const app = makeApp({ timeoutMs: 500 });
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ ids: ["run-hang-2"], idempotency_key: "t" }));
    const job = (await res.json()) as Record<string, unknown>;
    const done = await pollUntilTerminal(app, job.job_id as string);
    expect(done.state).toBe("timed_out");
    expect(done.closed_at).not.toBeNull();
    // Partial producer output survives (never deleted by benchmark).
    expect(
      existsSync(join(projectRoot, ".guild", "analysis", "runs", "run-hang-2", "analysis.json.partial")),
    ).toBe(true);
  }, 20_000);

  it("producer failure exit 1 → failed with stderr excerpt; bad stdout JSON → failed producer_result_invalid", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const fail = await postJob(app, token, jobBody({ ids: ["run-fail-1"], idempotency_key: "f" }));
    const failDone = await pollUntilTerminal(app, ((await fail.json()) as Record<string, unknown>).job_id as string);
    expect(failDone.state).toBe("failed");
    expect(failDone.exit_code).toBe(1);
    expect(failDone.stderr_excerpt).toContain("producer refused");
    const bad = await postJob(app, token, jobBody({ ids: ["run-badout-1"], idempotency_key: "b" }));
    const badDone = await pollUntilTerminal(app, ((await bad.json()) as Record<string, unknown>).job_id as string);
    expect(badDone.state).toBe("failed");
    expect(badDone.reason).toContain("producer_result_invalid");
  }, 20_000);

  it("unknown/restarted job ids 404 (volatile state)", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ idempotency_key: "restart" }));
    const job = (await res.json()) as Record<string, unknown>;
    await pollUntilTerminal(app, job.job_id as string);
    // A fresh app models a restarted server: the id is gone.
    const restarted = makeApp();
    const after = await restarted.request(`/api/project/analysis/jobs/${job.job_id}`, { headers: BASE_HEADERS });
    expect(after.status).toBe(404);
  });
});

describe("analysis jobs — closed request surface (D02-AC3)", () => {
  it("rejects unknown body fields, bad operations, unsafe ids, bad keys", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const cases: Array<Record<string, unknown>> = [
      { command: "rm -rf /" }, // unknown field
      { operation: "exec" },
      { operation: "inspect" }, // read-only op is not a job
      { ids: ["../escape"] },
      { ids: [] },
      { ids: Array.from({ length: 101 }, (_, i) => `run-${i}`) },
      { idempotency_key: "" },
      { idempotency_key: "x".repeat(129) },
      { target_kind: "root", ids: ["/etc"] },
      { source_guild: "not-a-source" },
      { operation: "compare", target_kind: "runs", ids: ["run-a", "run-a"] }, // duplicates
      // decision missing one expected guard (incomplete pair)
      {
        operation: "recommendation_decide",
        ids: ["run-src"],
        decision: "accept",
        recommendation_id: "rec-1",
        source_analysis_id: "analysis:run-src:abc",
      },
      // malformed hash
      {
        operation: "recommendation_decide",
        ids: ["run-src"],
        decision: "accept",
        recommendation_id: "rec-1",
        source_analysis_id: "analysis:run-src:abc",
        source_input_hash: "zz",
      },
    ];
    for (const override of cases) {
      const res = await postJob(app, token, jobBody(override));
      expect([400, 413], JSON.stringify(override)).toContain(res.status);
    }
    expect(spawnCount()).toBe(0);
  });

  it("rejects oversized request bodies", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ idempotency_key: "x".repeat(70000) }));
    expect(res.status).toBe(413);
    expect(spawnCount()).toBe(0);
  });

  it("rejects foreign Origin, null Origin, foreign Host, and a missing/wrong action token", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const foreignOrigin = await postJob(app, token, jobBody(), { origin: "https://evil.example" });
    expect(foreignOrigin.status).toBe(403);
    const nullOrigin = await postJob(app, token, jobBody(), { origin: "null" });
    expect(nullOrigin.status).toBe(403);
    const foreignHost = await postJob(app, token, jobBody(), { host: "evil.example:3055" });
    expect(foreignHost.status).toBe(403);
    const noToken = await app.request("/api/project/analysis/jobs", {
      method: "POST",
      headers: BASE_HEADERS,
      body: jobBody(),
    });
    expect(noToken.status).toBe(403);
    const wrongToken = await postJob(app, token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), jobBody());
    expect(wrongToken.status).toBe(403);
    expect(spawnCount()).toBe(0);
  });

  it("benchmark itself writes no canonical files (only the producer does)", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ ids: ["run-ok-3"], idempotency_key: "w" }));
    await pollUntilTerminal(app, ((await res.json()) as Record<string, unknown>).job_id as string);
    const files = readdirSync(join(projectRoot, ".guild", "analysis", "runs", "run-ok-3")).sort();
    expect(files).toEqual(["analysis.json", "analysis.md"]); // exactly the producer's artifacts
  });

  it("without the packaged runtime every analysis route stays 503", async () => {
    const app = makeApp(undefined, false);
    const session = await app.request("/api/project/analysis/session", { headers: BASE_HEADERS });
    expect(session.status).toBe(503);
    const post = await app.request("/api/project/analysis/jobs", {
      method: "POST",
      headers: BASE_HEADERS,
      body: jobBody(),
    });
    expect(post.status).toBe(503);
  });
});

describe("analysis artifacts endpoint (C-JOBS read route)", () => {
  it("lists and details validated artifacts via the D01 readers", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ ids: ["run-ok-4"], idempotency_key: "a" }));
    await pollUntilTerminal(app, ((await res.json()) as Record<string, unknown>).job_id as string);
    const list = await app.request("/api/project/analysis/artifacts", { headers: BASE_HEADERS });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { artifacts: Array<Record<string, unknown>> };
    const row = body.artifacts.find((a) => a.id === "run-ok-4");
    // The fixture artifact is intentionally minimal — it fails the full
    // mirror validation (malformed), proving validation actually ran.
    expect(row?.validation).toBe("malformed");
    const detail = await app.request(
      "/api/project/analysis/artifacts?kind=run&id=run-ok-4",
      { headers: BASE_HEADERS },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { freshness: { state: string } };
    expect(detailBody.freshness.state).toBe("current"); // from the fixture inspect
  });
});

describe("analysis jobs — codex round-1 regressions", () => {
  it("F1: a symlinked sub-guild escaping the project root is rejected", async () => {
    const { symlinkSync } = await import("node:fs");
    const wsRoot = join(scratch, "ws-escape");
    mkdirSync(join(wsRoot, ".guild"), { recursive: true });
    const outside = join(scratch, "outside-guild");
    mkdirSync(join(outside, ".guild"), { recursive: true });
    writeFileSync(
      join(wsRoot, ".guild", "workspace.json"),
      JSON.stringify({ sub_guilds: [{ name: "escapee", path: "escapee" }] }),
    );
    symlinkSync(outside, join(wsRoot, "escapee"));
    const app = createApp({
      runsDir: join(scratch, "bench-runs"),
      casesDir: join(scratch, "cases"),
      port: 0,
      projectRoot: wsRoot,
      guildPluginPackage: runtime,
    });
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ source_guild: "escapee" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("escapes the project root");
    expect(spawnCount()).toBe(0);
  });

  it("F2: producer results must carry the operation's identity fields and honest refs", async () => {
    const { validateProducerSuccess } = await import("../src/analysis-jobs.js");
    const root = "/canon/root";
    const analyzeReq = {
      source_guild: "project", operation: "analyze" as const, target_kind: "run" as const,
      ids: ["run-1"], idempotency_key: "k",
    };
    expect(validateProducerSuccess(analyzeReq, { ok: true }, root)).toEqual({ error: "analyze result missing analysis_id" });
    expect(validateProducerSuccess(analyzeReq, { ok: true, analysis_id: "analysis:run-1:abc", eligible: "yes" }, root)).toEqual({ error: "analyze result missing eligible" });
    expect(validateProducerSuccess(analyzeReq, { ok: true, analysis_id: "analysis:run-1:abc", eligible: true }, root)).toEqual({ refs: [] });
    const compareReq = { ...analyzeReq, operation: "compare" as const, target_kind: "runs" as const, ids: ["run-1", "run-2"] };
    expect(validateProducerSuccess(compareReq, { ok: true, comparison_id: "c", run_ids: ["run-1"] }, root)).toEqual({ error: "comparison result does not cover the requested run ids" });
    expect(
      validateProducerSuccess(compareReq, { ok: true, comparison_id: "c", run_ids: ["run-1", "run-2"], written: "/etc/passwd" }, root),
    ).toEqual({ error: "artifact ref escapes the canonical root: /etc/passwd" });
    expect(
      validateProducerSuccess(compareReq, { ok: true, comparison_id: "c", run_ids: ["run-1", "run-2"], written: "a/../../x" }, root),
    ).toEqual({ error: "artifact ref escapes the canonical root: a/../../x" });
    expect(validateProducerSuccess(analyzeReq, { ok: false, analysis_id: "analysis:run-1:abc", eligible: true }, root)).toEqual({ error: "ok is not true" });
    // r2: another run's analysis identity or artifact path is rejected.
    expect(
      validateProducerSuccess(analyzeReq, { ok: true, analysis_id: "analysis:run-OTHER:abc", eligible: true }, root),
    ).toEqual({ error: "analysis_id does not reference the requested run: analysis:run-OTHER:abc" });
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: ".guild/analysis/runs/run-OTHER/analysis.json",
      }, root),
    ).toEqual({ error: "artifact ref outside .guild/analysis/runs/run-1/: .guild/analysis/runs/run-OTHER/analysis.json" });
  });

  it("E03 F4: object-form absolute `written` paths relativize into refs; escapes still rejected", async () => {
    const { validateProducerSuccess } = await import("../src/analysis-jobs.js");
    const { realpathSync, symlinkSync } = await import("node:fs");
    // Real on-disk root: absolute refs are physically resolved (codex F1).
    mkdirSync(join(scratch, "f4-root"), { recursive: true });
    const root = realpathSync(join(scratch, "f4-root"));
    const runDir = join(root, ".guild", "analysis", "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "analysis.json"), "{}");
    writeFileSync(join(runDir, "analysis.md"), "# a");
    const analyzeReq = {
      source_guild: "project", operation: "analyze" as const, target_kind: "run" as const,
      ids: ["run-1"], idempotency_key: "k",
    };
    // The shipped producer's shape: written is an object of absolute paths.
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: {
          json: join(runDir, "analysis.json"),
          markdown: join(runDir, "analysis.md"),
        },
      }, root),
    ).toEqual({
      refs: [
        ".guild/analysis/runs/run-1/analysis.json",
        ".guild/analysis/runs/run-1/analysis.md",
      ],
    });
    // Absolute path outside the canonical root is still an escape.
    const outside = join(scratch, "f4-outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "analysis.json"), "{}");
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: { json: join(outside, "analysis.json") },
      }, root),
    ).toEqual({ error: `artifact ref escapes the canonical root: ${join(outside, "analysis.json")}` });
    // A symlinked component under the run dir pointing outside the root is an
    // escape PHYSICALLY even though it passes lexically (codex F1).
    symlinkSync(outside, join(runDir, "link"));
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: { json: join(runDir, "link", "analysis.json") },
      }, root),
    ).toEqual({ error: `artifact ref escapes the canonical root: ${join(runDir, "link", "analysis.json")}` });
    // An unresolvable path fails closed.
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: { json: join(runDir, "missing.json") },
      }, root),
    ).toEqual({ error: `artifact ref does not resolve on disk: ${join(runDir, "missing.json")}` });
    // Absolute path inside the root but outside the run's analysis dir.
    const otherDir = join(root, ".guild", "analysis", "runs", "run-OTHER");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, "analysis.json"), "{}");
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: { json: join(otherDir, "analysis.json") },
      }, root),
    ).toEqual({ error: `artifact ref outside .guild/analysis/runs/run-1/: ${join(otherDir, "analysis.json")}` });
    // Non-string entries inside the object are still rejected.
    expect(
      validateProducerSuccess(analyzeReq, {
        ok: true, analysis_id: "analysis:run-1:abc", eligible: true,
        written: { json: 42 },
      }, root),
    ).toEqual({ error: "written entries must be strings" });
  });

  it("F6: control characters in source_analysis_id are rejected before any spawn", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const res = await postJob(
      app,
      token,
      jobBody({
        operation: "recommendation_decide",
        ids: ["run-src"],
        idempotency_key: "nul",
        decision: "accept",
        recommendation_id: "rec-1",
        source_analysis_id: "analysis:run-src:ab\u0000c",
        source_input_hash: "c".repeat(64),
      }),
    );
    expect(res.status).toBe(400);
    expect(spawnCount()).toBe(0);
    // The root is NOT left held by a phantom job: a normal job still runs.
    const ok = await postJob(app, token, jobBody({ ids: ["run-ok-9"], idempotency_key: "after-nul" }));
    expect(ok.status).toBe(202);
    const done = await pollUntilTerminal(app, ((await ok.json()) as Record<string, unknown>).job_id as string);
    expect(done.state).toBe("succeeded");
  });

  it("F5: overflow outranks cancel — terminal state is failed/output_limit", async () => {
    // flood fixture: stream past the cap, ignore SIGTERM
    const floodPkg = join(scratch, "pkg-flood");
    mkdirSync(join(floodPkg, ".claude-plugin"), { recursive: true });
    mkdirSync(join(floodPkg, "runtime", "scripts"), { recursive: true });
    writeFileSync(join(floodPkg, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "guild", version: "3.1.0" }));
    writeFileSync(
      join(floodPkg, "guild.inventory.json"),
      JSON.stringify({
        schema_version: SUPPORTED_INVENTORY_SCHEMA,
        plugin_version: "3.1.0",
        manifest: { name: "guild", version: "3.1.0" },
        scripts: [{ id: "run-analysis", kind: "cli" }],
      }),
    );
    const floodLog = join(scratch, "flood-log.txt");
    writeFileSync(
      join(floodPkg, RUN_ANALYSIS_ENTRY),
      `
process.on("SIGTERM", () => {});
require("node:fs").appendFileSync(FLOODLOG, "started\\n");
const chunk = "x".repeat(65536);
let i = 0;
const pump = () => { while (i < 64) { i++; if (!process.stdout.write(chunk)) { process.stdout.once("drain", pump); return; } } };
pump();
setInterval(() => {}, 1000);
`.replace("FLOODLOG", JSON.stringify(floodLog)),
    );
    const floodRuntime = resolvePackagedRuntime(floodPkg);
    const app = createApp({
      runsDir: join(scratch, "bench-runs"),
      casesDir: join(scratch, "cases"),
      port: 0,
      projectRoot,
      guildPluginPackage: floodRuntime,
      analysisJobLimits: { timeoutMs: 10_000 },
    });
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ ids: ["run-flood-1"], idempotency_key: "fl" }));
    const job = (await res.json()) as Record<string, unknown>;
    // Wait until the child is actually running (its SIGTERM handler is
    // installed) before cancelling, so the race is overflow-vs-cancel, not
    // cancel-vs-node-bootstrap.
    {
      const started = Date.now();
      while (!existsSync(floodLog)) {
        if (Date.now() - started > 10_000) throw new Error("flood child never started");
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // Cancel while the overflow abort is racing: overflow must win.
    await app.request(`/api/project/analysis/jobs/${job.job_id}/cancel`, {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-guild-action-token": token },
    });
    const done = await pollUntilTerminal(app, job.job_id as string, 20_000);
    expect(done.state).toBe("failed");
    expect(done.reason).toBe("output_limit");
  }, 30_000);

  it("F4: an oversized body without content-length is still rejected at the cap", async () => {
    const app = makeApp();
    const token = await tokenFor(app);
    const big = jobBody({ idempotency_key: "x".repeat(100) }) + " ".repeat(70000);
    // app.request sets content-length itself; simulate chunked by stream body
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const res = await app.request("/api/project/analysis/jobs", {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-guild-action-token": token },
      body: stream,
      // @ts-expect-error duplex is required for stream bodies in undici
      duplex: "half",
    });
    expect(res.status).toBe(413);
    expect(spawnCount()).toBe(0);
  });
});

describe("analysis jobs — lifecycle hygiene (r3/security regressions)", () => {
  it("repeated cancel is idempotent and the job still closes exactly once", async () => {
    const app = makeApp({ timeoutMs: 10_000 });
    const token = await tokenFor(app);
    const res = await postJob(app, token, jobBody({ ids: ["run-hang-9"], idempotency_key: "c9" }));
    const job = (await res.json()) as Record<string, unknown>;
    await waitForSpawns(1);
    for (let i = 0; i < 3; i++) {
      const cancel = await app.request(`/api/project/analysis/jobs/${job.job_id}/cancel`, {
        method: "POST",
        headers: { ...BASE_HEADERS, "x-guild-action-token": token },
      });
      expect(cancel.status).toBe(202);
    }
    const done = await pollUntilTerminal(app, job.job_id as string);
    expect(done.state).toBe("cancelled");
    expect(spawnCount()).toBe(1);
    // Cancelling a terminal job changes nothing (202, same view).
    const late = await app.request(`/api/project/analysis/jobs/${job.job_id}/cancel`, {
      method: "POST",
      headers: { ...BASE_HEADERS, "x-guild-action-token": token },
    });
    expect(late.status).toBe(202);
    expect(((await late.json()) as Record<string, unknown>).state).toBe("cancelled");
  }, 20_000);

  it("exports a bounded terminal-retention cap", async () => {
    const { MAX_TERMINAL_JOBS } = await import("../src/analysis-jobs.js");
    expect(MAX_TERMINAL_JOBS).toBeGreaterThan(0);
    expect(MAX_TERMINAL_JOBS).toBeLessThanOrEqual(1000);
  });
});
