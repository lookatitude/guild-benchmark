// D04 — bridge security + cross-repo artifact integration, verified through
// the REAL HTTP boundary (startServer on 127.0.0.1, real fetch), never
// through in-process shortcuts and never importing plugin source.
//
// Acceptance:
//   D04-AC1 — positive roundtrip plus every planted control (traversal,
//             symlink, arbitrary executable, remote origin, conflicting job,
//             oversized output) runs through actual boundary calls.
//   D04-AC2 — benchmark never creates canonical findings/recommendations
//             itself (the producer's writes are the only canonical bytes).
//   D04-AC3 — in-flight/error/restart states are OBSERVED from polling the
//             real jobs, never fabricated from elapsed time.
//
// Cross-repo integration uses the CONTRACT EXAMPLE artifacts checked into
// tests/analysis-contract-fixtures/ (copies of the planning contract's
// examples — the real producer wire shapes) and the B04 producer-package
// binding (b04-producer-package.json).
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { startServer, type ServerHandle } from "../src/server.js";
import {
  RUN_ANALYSIS_ENTRY,
  SUPPORTED_INVENTORY_SCHEMA,
  SUPPORTED_PLUGIN_MAJOR,
  resolvePackagedRuntime,
} from "../src/analysis-process.js";

const FIXTURES = resolve(__dirname, "analysis-contract-fixtures");
const EXAMPLE_RUN_ID = "run-20261017-010000-example-a";

let scratch: string;
let projectRoot: string;
let packageRoot: string;
let handle: ServerHandle;
let ledgerSnapshot: Record<string, string>;
let baseUrl: string;
let actionToken: string;

/** Fixture producer: writes the CONTRACT EXAMPLE artifacts (not invented
 * shapes) into the canonical root; supports hang/flood controls; answers
 * inspect with a current result derived from the example artifact. */
function producerEntry(): string {
  const exampleAnalysis = readFileSync(join(FIXTURES, "run-analysis.json"), "utf8");
  return `
const fs = require("node:fs");
const path = require("node:path");
const EXAMPLE = ${JSON.stringify(exampleAnalysis)};
const args = process.argv.slice(2);
const cwdIdx = args.indexOf("--cwd");
const root = args[cwdIdx + 1];
if (args[0] === "run" && args[1] === "analyze") {
  const id = args[2];
  if (id === "run-hang-d04") {
    fs.writeFileSync(path.join(root, "hang.pid"), String(process.pid));
    setInterval(() => {}, 1000);
  }
  else if (id === "run-flood-d04") {
    process.on("SIGTERM", () => {});
    fs.writeFileSync(path.join(root, "flood.pid"), String(process.pid));
    const chunk = "x".repeat(65536);
    let i = 0;
    const pump = () => { while (i < 64) { i++; if (!process.stdout.write(chunk)) { process.stdout.once("drain", pump); return; } } };
    pump();
    setInterval(() => {}, 1000);
  } else if (id === ${JSON.stringify(EXAMPLE_RUN_ID)}) {
    const dir = path.join(root, ".guild", "analysis", "runs", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "analysis.json"), EXAMPLE);
    const parsed = JSON.parse(EXAMPLE);
    process.stdout.write(JSON.stringify({ ok: true, analysis_id: parsed.analysis_id, eligible: parsed.eligible, written: ".guild/analysis/runs/" + id + "/analysis.json" }));
    process.exit(0);
  } else { process.stderr.write("unknown run: " + id); process.exit(1); }
}
else if (args[0] === "artifact" && args[1] === "inspect") {
  const parsed = JSON.parse(EXAMPLE);
  process.stdout.write(JSON.stringify({
    ok: true, state: "current", kind: args[2], source_id: args[3],
    artifact_ref: ".guild/analysis/runs/" + args[3] + "/analysis.json",
    schema_version: parsed.schema_version, source_analysis_id: parsed.analysis_id,
    source_hash: parsed.source_hash, current_source_hash: parsed.source_hash,
    input_hash: "b".repeat(64), current_input_hash: "b".repeat(64),
    eligible: true, reason: null,
  }));
  process.exit(0);
}
else { process.stderr.write("unexpected argv"); process.exit(2); }
`;
}

function makePackage(dir: string): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "runtime", "scripts"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "guild", version: "3.1.0" }));
  writeFileSync(
    join(dir, "guild.inventory.json"),
    JSON.stringify({
      schema_version: SUPPORTED_INVENTORY_SCHEMA,
      plugin_version: "3.1.0",
      manifest: { name: "guild", version: "3.1.0" },
      scripts: [{ id: "run-analysis", kind: "cli" }],
    }),
  );
  writeFileSync(join(dir, RUN_ANALYSIS_ENTRY), producerEntry());
  return dir;
}

function snapshotTree(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const p = join(String(entry.parentPath), entry.name);
      out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  }
  return out;
}

function listCanonical(): string[] {
  return Object.keys(snapshotTree(join(projectRoot, ".guild", "analysis"))).sort();
}

/** Assert the pid recorded by a fixture child no longer exists (allowing a
 * short reap window). Skips silently only if the child never wrote its pid —
 * which earlier assertions would already have failed. */
async function expectProcessDead(pidFile: string): Promise<void> {
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
  expect(Number.isInteger(pid) && pid > 1).toBe(true);
  const started = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // Only ESRCH proves the process is gone; EPERM etc. mean it may well
      // be alive under another uid (codex confirmation F1).
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }
    if (Date.now() - started > 10_000) throw new Error(`child ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

async function postJob(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return api("/api/project/analysis/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-guild-action-token": actionToken,
      ...headers,
    },
    body: JSON.stringify({
      source_guild: "project",
      operation: "analyze",
      target_kind: "run",
      idempotency_key: `k-${Math.random().toString(36).slice(2)}`,
      ...body,
    }),
  });
}

/** AC3 discipline: observe states by POLLING; record the observed sequence. */
async function pollJob(jobId: string, timeoutMs = 20_000): Promise<{ final: Record<string, unknown>; observedStates: string[] }> {
  const observed: string[] = [];
  const started = Date.now();
  for (;;) {
    const res = await api(`/api/project/analysis/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as Record<string, unknown>;
    if (observed[observed.length - 1] !== job.state) observed.push(job.state as string);
    if (job.closed_at !== null) return { final: job, observedStates: observed };
    if (Date.now() - started > timeoutMs) throw new Error(`job not terminal: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "d04-sec-"));
  projectRoot = join(scratch, "project root with spaces");
  mkdirSync(join(projectRoot, ".guild", "runs", EXAMPLE_RUN_ID, "logs"), { recursive: true });
  // Recommendations ledger from the CONTRACT EXAMPLE recommendation.
  const exampleRec = readFileSync(join(FIXTURES, "recommendation.json"), "utf8");
  mkdirSync(join(projectRoot, ".guild", "recommendations"), { recursive: true });
  writeFileSync(
    join(projectRoot, ".guild", "recommendations", `${EXAMPLE_RUN_ID}.jsonl`),
    JSON.stringify(JSON.parse(exampleRec)) + "\n",
  );
  ledgerSnapshot = snapshotTree(join(projectRoot, ".guild", "recommendations"));
  packageRoot = makePackage(join(scratch, "pkg d04"));
  const runtime = resolvePackagedRuntime(packageRoot);
  handle = await startServer({
    runsDir: join(scratch, "bench-runs"),
    casesDir: join(scratch, "cases"),
    port: 0 || 21000 + Math.floor(Math.random() * 20000),
    projectRoot,
    guildPluginPackage: runtime,
    analysisJobLimits: { timeoutMs: 3_000 },
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  const session = await api("/api/project/analysis/session");
  expect(session.status).toBe(200);
  actionToken = ((await session.json()) as { action_token: string }).action_token;
});

afterAll(async () => {
  await handle.close();
  await rm(scratch, { recursive: true, force: true });
});

describe("D04 — positive roundtrip through the real HTTP bridge (AC1/AC2/AC3)", () => {
  it("runs the packaged fixture producer end to end and reads back the contract-example artifact", async () => {
    const before = listCanonical();
    expect(before).toEqual([]); // nothing canonical before the producer runs
    const res = await postJob({ ids: [EXAMPLE_RUN_ID] });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Record<string, unknown>;
    const { final, observedStates } = await pollJob(job.job_id as string);
    expect(final.state).toBe("succeeded");
    expect(final.exit_code).toBe(0);
    // AC3: the terminal state was OBSERVED via polling, and closed_at only
    // appeared with it (never inferred from elapsed time).
    expect(observedStates[observedStates.length - 1]).toBe("succeeded");
    expect(final.closed_at).not.toBeNull();
    // AC2: exactly the producer's artifact exists WITH the producer's exact
    // bytes, and the recommendations ledger is byte-identical to its seeded
    // state — benchmark created/rewrote no canonical findings or
    // recommendations of its own.
    const after = snapshotTree(join(projectRoot, ".guild", "analysis"));
    const artifactPath = join(projectRoot, ".guild", "analysis", "runs", EXAMPLE_RUN_ID, "analysis.json");
    expect(Object.keys(after)).toEqual([artifactPath]);
    expect(after[artifactPath]).toBe(
      createHash("sha256").update(readFileSync(join(FIXTURES, "run-analysis.json"))).digest("hex"),
    );
    expect(snapshotTree(join(projectRoot, ".guild", "recommendations"))).toEqual(ledgerSnapshot);
    // Cross-repo integration: the CONTRACT EXAMPLE artifact (the real
    // producer wire shape) validates as `valid` through the D01 readers,
    // and the ledger row (contract example recommendation) binds.
    const detail = await api(
      `/api/project/analysis/artifacts?kind=run&id=${EXAMPLE_RUN_ID}`,
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      summary: { validation: string; analysis_id: string };
      recommendations: Array<{ id: string }>;
      freshness: { state: string; decision_eligible?: boolean };
    };
    expect(body.summary.validation).toBe("valid");
    expect(body.summary.analysis_id).toContain(EXAMPLE_RUN_ID);
    expect(body.recommendations.map((r) => r.id)).toEqual(["rec-a6e61633056fba7d"]);
    expect(body.freshness.state).toBe("current");
    expect(body.freshness.decision_eligible).toBe(true);
  }, 30_000);
});

describe("D04 — planted controls through actual boundary calls (AC1)", () => {
  it("traversal: artifact detail and job ids reject path material", async () => {
    const detail = await api("/api/project/analysis/artifacts?kind=run&id=../../etc");
    expect(detail.status).toBe(400);
    const job = await postJob({ ids: ["../escape"] });
    expect(job.status).toBe(400);
  });

  it("symlink: an artifact symlinked outside the project is refused by the reader", async () => {
    const outside = join(scratch, "outside-artifact.json");
    // Otherwise-VALID artifact whose run_id matches its directory — only the
    // containment check can reject it (codex F1: containment, not identity).
    const example = JSON.parse(readFileSync(join(FIXTURES, "run-analysis.json"), "utf8")) as Record<string, unknown>;
    example.run_id = "run-symlink-d04";
    example.analysis_id = "analysis:run-symlink-d04:abc";
    writeFileSync(outside, JSON.stringify(example));
    const dir = join(projectRoot, ".guild", "analysis", "runs", "run-symlink-d04");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outside, join(dir, "analysis.json"));
    const list = await api("/api/project/analysis/artifacts");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { artifacts: Array<Record<string, unknown>> };
    const row = body.artifacts.find((a) => a.id === "run-symlink-d04");
    expect(row?.validation).toBe("malformed");
  });

  it("arbitrary executable: a post-start entry swap refuses the spawn through the live bridge", async () => {
    // Replace the validated entry's bytes AFTER server start — the pre-spawn
    // revalidation must refuse without executing the new bytes.
    const entryPath = join(packageRoot, RUN_ANALYSIS_ENTRY);
    const original = readFileSync(entryPath);
    const sentinel = join(projectRoot, "PWNED");
    writeFileSync(
      entryPath,
      `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'x');`,
    );
    try {
      const res = await postJob({ ids: [EXAMPLE_RUN_ID], idempotency_key: "swap" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("entry_changed");
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      writeFileSync(entryPath, original);
    }
  });

  it("remote origin: foreign Origin and foreign Host are rejected over real HTTP", async () => {
    const foreignOrigin = await postJob({ ids: [EXAMPLE_RUN_ID] }, { origin: "https://evil.example" });
    expect(foreignOrigin.status).toBe(403);
    const nullOrigin = await postJob({ ids: [EXAMPLE_RUN_ID] }, { origin: "null" });
    expect(nullOrigin.status).toBe(403);
    // fetch/undici refuses to forge the Host header — model the DNS-rebinding
    // request with a raw node:http client instead.
    const { request } = await import("node:http");
    const foreignHostStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: handle.port,
          path: "/api/project/analysis/jobs",
          method: "POST",
          headers: {
            host: "attacker.example",
            "content-type": "application/json",
            "x-guild-action-token": actionToken,
          },
        },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on("error", rejectStatus);
      req.end(
        JSON.stringify({
          source_guild: "project",
          operation: "analyze",
          target_kind: "run",
          ids: [EXAMPLE_RUN_ID],
          idempotency_key: "host-spoof",
        }),
      );
    });
    expect(foreignHostStatus).toBe(403);
    const noToken = await fetch(`${baseUrl}/api/project/analysis/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_guild: "project",
        operation: "analyze",
        target_kind: "run",
        ids: [EXAMPLE_RUN_ID],
        idempotency_key: "nt",
      }),
    });
    expect(noToken.status).toBe(403);
  });

  it("conflicting job: a second different request on the busy root 409s; cancel observed to terminal", async () => {
    const first = await postJob({ ids: ["run-hang-d04"], idempotency_key: "h1" });
    expect(first.status).toBe(202);
    const firstJob = (await first.json()) as Record<string, unknown>;
    // Wait until the hang child is REALLY running (it wrote its pid) so the
    // cancel exercises a live process, not node bootstrap.
    {
      const pidFile = join(projectRoot, "hang.pid");
      const started = Date.now();
      while (!existsSync(pidFile)) {
        if (Date.now() - started > 10_000) throw new Error("hang child never started");
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const conflict = await postJob({ ids: [EXAMPLE_RUN_ID], idempotency_key: "h2" });
    expect(conflict.status).toBe(409);
    const cancel = await api(`/api/project/analysis/jobs/${firstJob.job_id}/cancel`, {
      method: "POST",
      headers: { "x-guild-action-token": actionToken },
    });
    expect(cancel.status).toBe(202);
    // AC3: the in-flight state was OBSERVED on the create response (the 202
    // body), and cancellation becomes terminal only at the real child close,
    // observed via polling (the cancel may land during node bootstrap, so
    // post-cancel polls can legitimately already see the terminal state).
    expect(firstJob.state).toBe("running");
    const { final, observedStates } = await pollJob(firstJob.job_id as string);
    expect(final.state).toBe("cancelled");
    expect(observedStates[observedStates.length - 1]).toBe("cancelled");
    // The cancelled child is actually dead, not merely reported terminal.
    await expectProcessDead(join(projectRoot, "hang.pid"));
  }, 30_000);

  it("oversized output: a SIGTERM-resistant flood fails as output_limit", async () => {
    const res = await postJob({ ids: ["run-flood-d04"], idempotency_key: "fl" });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Record<string, unknown>;
    const { final } = await pollJob(job.job_id as string, 30_000);
    expect(final.state).toBe("failed");
    expect(final.reason).toBe("output_limit");
    // Terminal report must correspond to a DEAD child (security F2): the
    // SIGTERM-resistant flood recorded its pid; it must be gone.
    await expectProcessDead(join(projectRoot, "flood.pid"));
  }, 40_000);

  it("restart: a fresh server 404s old volatile job ids (AC3 observed, not assumed)", async () => {
    const res = await postJob({ ids: [EXAMPLE_RUN_ID], idempotency_key: "restart-d04" });
    const job = (await res.json()) as Record<string, unknown>;
    await pollJob(job.job_id as string);
    const second = await startServer({
      runsDir: join(scratch, "bench-runs-2"),
      casesDir: join(scratch, "cases"),
      port: 21000 + Math.floor(Math.random() * 20000),
      projectRoot,
      guildPluginPackage: resolvePackagedRuntime(packageRoot),
    });
    try {
      const after = await fetch(
        `http://127.0.0.1:${second.port}/api/project/analysis/jobs/${job.job_id}`,
      );
      expect(after.status).toBe(404);
    } finally {
      await second.close();
    }
  }, 30_000);
});

describe("D04 — consumer conformance bound to the B04 producer package (step 3)", () => {
  it("consumer-side conformance to the recorded B04 binding (fixture-level claim)", () => {
    // SCOPE (codex confirmation F2): this asserts the CONSUMER constants and
    // the recorded B04/C05 binding agree, and that the binding's facts hold
    // on the package shape this suite exercised. Producer-side identity of
    // the real payload is established by B04/C07 evidence, not re-proven
    // here (benchmark CI has no plugin checkout). Set
    // GUILD_D04_REAL_PACKAGE=<abs path> to additionally validate the real
    // packaged payload through the same resolver (fails loudly if invalid;
    // absent env is NOT acceptance for that leg).
    if (process.env.GUILD_D04_REAL_PACKAGE !== undefined) {
      // Set-but-empty must FAIL (the resolver rejects a non-absolute path),
      // never silently skip.
      const real = resolvePackagedRuntime(process.env.GUILD_D04_REAL_PACKAGE);
      expect(real.pluginName).toBe("guild");
    }
    const binding = JSON.parse(
      readFileSync(join(FIXTURES, "b04-producer-package.json"), "utf8"),
    ) as {
      producer: { plugin_version: string; native_identity: string };
      consumer_requirements: {
        supported_plugin_major: number;
        supported_inventory_schema: string;
        required_files: string[];
        inventory_must_declare: { id: string; kind: string };
      };
    };
    // The consumer-side constants this benchmark build enforces must match
    // the recorded binding — a drift here breaks the cross-repo contract.
    expect(binding.consumer_requirements.supported_plugin_major).toBe(SUPPORTED_PLUGIN_MAJOR);
    expect(binding.consumer_requirements.supported_inventory_schema).toBe(SUPPORTED_INVENTORY_SCHEMA);
    expect(binding.consumer_requirements.required_files).toContain(
      RUN_ANALYSIS_ENTRY.split("\\").join("/"),
    );
    // The B04 producer package version is accepted by the validator's major.
    const major = Number.parseInt(binding.producer.plugin_version, 10);
    expect(major).toBe(SUPPORTED_PLUGIN_MAJOR);
    // Pinned to the EXACT identity B04/C05 established — not just any sha256.
    expect(binding.producer.native_identity).toBe(
      "sha256:9a6a1af4d68c77641fc8f5023c371db17df05b9bc7e94b4ac9f07ca16599c96c",
    );
    // And the required-file/inventory facts hold on the EXERCISED package —
    // the same validator path the live bridge used in this suite.
    for (const rel of binding.consumer_requirements.required_files) {
      expect(existsSync(join(packageRoot, rel)), rel).toBe(true);
    }
    const inventory = JSON.parse(
      readFileSync(join(packageRoot, "guild.inventory.json"), "utf8"),
    ) as { schema_version: string; scripts: Array<{ id: string; kind: string }> };
    expect(inventory.schema_version).toBe(binding.consumer_requirements.supported_inventory_schema);
    expect(inventory.scripts).toContainEqual(
      expect.objectContaining(binding.consumer_requirements.inventory_must_declare),
    );
  });

  it("the contract-example comparison artifact also validates through the reader", async () => {
    const example = JSON.parse(readFileSync(join(FIXTURES, "comparison.json"), "utf8")) as {
      comparison_id: string;
    };
    const dir = join(projectRoot, ".guild", "analysis", "comparisons", example.comparison_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "comparison.json"), JSON.stringify(example));
    const detail = await api(
      `/api/project/analysis/artifacts?kind=comparison&id=${example.comparison_id}`,
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { summary: { validation: string } };
    expect(body.summary.validation).toBe("valid");
  });
});
