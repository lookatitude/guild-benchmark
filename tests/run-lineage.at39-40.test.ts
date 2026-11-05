import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import { canonicalJson, previewHash, readProjectRunLineage, sha256Text, type ProjectRunLineageResponse } from "../src/run-lineage.js";
import { req } from "./server.helpers.js";
import { writeFileDeep } from "./project.helpers.js";

// U01 / P05 run lineage. AT39 (lifecycle journey) and AT40 (authority and
// security) against a disposable project built from A02-valid records, read
// through the real reader and server route.

const FIXTURE = join(__dirname, "..", "fixtures", "contracts", "p05-v2", "at39-project.json");
const NOW = new Date("2026-11-05T12:00:00Z");

interface Fixture {
  source_id: string;
  run_id: string;
  files: Record<string, string>;
}

type Available = Extract<ProjectRunLineageResponse, { status: "available" }>;

let fx: Fixture;
let root: string;
const RUN = () => fx.run_id;
const guildDir = (base = root) => join(base, ".guild");
const runFile = (rel: string, base = root) => join(guildDir(base), "runs", RUN(), ...rel.split("/"));
const opFile = (op: string, name: string, base = root) => join(guildDir(base), "artifacts", "operations", op, `${name}.json`);

async function seed(base: string): Promise<void> {
  for (const [rel, text] of Object.entries(fx.files)) await writeFileDeep(join(guildDir(base), ...rel.split("/")), text);
}

async function lineage(base = root, guild?: string): Promise<ProjectRunLineageResponse> {
  return readProjectRunLineage(base, RUN(), guild, NOW);
}

async function available(base = root): Promise<Available> {
  const r = await lineage(base);
  expect(r.status).toBe("available");
  return r as Available;
}

async function editJson(path: string, edit: (v: Record<string, unknown>) => void): Promise<void> {
  const v = JSON.parse(await readFile(path, "utf8"));
  edit(v);
  await writeFile(path, JSON.stringify(v, null, 2));
}

/** Every file under `dir` with its mtime and bytes, for no-side-effect checks. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    out[p] = `${(await stat(p)).mtimeMs}:${await readFile(p, "utf8")}`;
  }
  return out;
}

async function withApp<T>(projectRoot: string, fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const runsDir = await mkdtemp(join(tmpdir(), "u01-runs-"));
  const casesDir = await mkdtemp(join(tmpdir(), "u01-cases-"));
  try {
    return await fn(createApp({ runsDir, casesDir, port: 0, projectRoot }));
  } finally {
    await rm(runsDir, { recursive: true, force: true });
    await rm(casesDir, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  fx = JSON.parse(await readFile(FIXTURE, "utf8"));
  root = await mkdtemp(join(tmpdir(), "u01-lineage-"));
  await seed(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("AT39 · UI lifecycle journey (reader)", () => {
  it("projects run, executions, attempts, transfer and usage from the A02 records", async () => {
    const d = await available();
    expect(d.run).toMatchObject({ source_id: "proj-a", run_id: RUN(), phase: "build" });
    expect(d.run.state).toEqual({ lifecycle: "active", outcome: "pending", acceptance: "pending", observability: "partial" });
    expect(d.executions.map((e) => [e.execution_id, e.admission, e.seal?.outcome_state ?? null])).toEqual([
      ["exec-1", "sealed", "exited"],
      ["exec-2", "active", null],
    ]);
    expect(d.executions[0].seal?.matches_segment).toBe(true);
    expect(d.attempts.map((a) => [a.logical_task_id, a.attempt_id, a.ordinal])).toEqual([
      ["task-a", "att-a1", 1],
      ["task-a", "att-a2", 2],
      ["task-b", "att-b1", 1],
    ]);
    expect(d.attempts[0].assignment.schema_version).toBe("guild.task_assignment.v3");
    expect(d.transfers).toEqual([
      expect.objectContaining({ operation_id: "xfer-1", state: "source_committed", stages: ["reserved", "target_prepared", "source_committed"], target_ack: null }),
    ]);
    expect(d.refused).toEqual([]);
  });

  it("derives close blockers: live attempt, unreconciled receipt loss, uncertain effects, unacknowledged transfer", async () => {
    const d = await available();
    expect(d.close_blockers).toEqual([
      { code: "transfer_unacknowledged", subject: "xfer-1" },
      { code: "attempt_live", subject: "att-b1" },
      { code: "receipt_loss_unreconciled", subject: "att-b1" },
      { code: "uncertain_effects", subject: "att-b1" },
      { code: "no_accepted_final_evidence", subject: "task-b" },
    ]);
  });

  it("keeps missing usage values null and marks the view partial", async () => {
    const d = await available();
    if (d.usage.status !== "partial") throw new Error(`expected partial usage, got ${d.usage.status}`);
    expect(d.usage.entries.find((e) => e.accounting_identity === "request-2")).toMatchObject({
      input_inclusive: null,
      output: null,
      total: null,
      cost_usd: null,
      cost_basis: "unavailable",
    });
    expect(d.usage.entries.find((e) => e.accounting_identity === "request-1")).toMatchObject({ total: 120, cost_basis: "derived_estimate" });
  });

  it("reports usage as missing, never zero, when no analysis exists", async () => {
    await rm(join(guildDir(), "analysis"), { recursive: true });
    const d = await available();
    expect(d.usage).toEqual({ status: "missing", reason: "no run analysis v2 recorded for this run" });
  });

  it("refuses an analysis body that does not match its pointer hash", async () => {
    await editJson(join(guildDir(), "analysis", "runs", RUN(), "versions", "analysis-p05-1", "analysis.json"), (v) => {
      (v.usage as Record<string, unknown>[])[1].total = 0;
    });
    const d = await available();
    expect(d.usage.status).toBe("refused");
    expect(d.refused).toContainEqual({ file: `.guild/analysis/runs/${RUN()}/versions/analysis-p05-1/analysis.json`, reason: "invalid_record" });
  });

  it("passes unknown state axes through as unknown", async () => {
    await editJson(runFile("lineage/logical-run.json"), (v) => {
      v.state = { lifecycle: "unknown", outcome: "unknown", acceptance: "unknown", observability: "unavailable" };
    });
    expect((await available()).run.state).toEqual({ lifecycle: "unknown", outcome: "unknown", acceptance: "unknown", observability: "unavailable" });
  });

  it("negative control: an accepted dispatch receipt and a host exit do not make the run succeed", async () => {
    const d = await available();
    const launch = d.operations.find((o) => o.operation_id === "op-launch");
    expect(launch?.receipt).toMatchObject({ state: "accepted", effect_kind: "dispatch", outcome: null, correlation: "correlated" });
    expect(d.executions[0].seal?.outcome_state).toBe("exited");
    expect(d.run.state.outcome).toBe("pending");
    expect(d.run.state.lifecycle).not.toBe("closed");
  });

  it("negative control: a dispatch receipt that carries an outcome is refused", async () => {
    await editJson(opFile("op-launch", "receipt"), (v) => {
      v.outcome = { lifecycle: "closed", outcome: "succeeded", acceptance: "verified", observability: "complete" };
    });
    const d = await available();
    expect(d.operations.find((o) => o.operation_id === "op-launch")).toBeUndefined();
    expect(d.refused).toContainEqual({ file: ".guild/artifacts/operations/op-launch/receipt.json", reason: "invalid_record" });
  });

  it("negative control: a run manifest that claims success without verified acceptance is refused whole", async () => {
    await editJson(runFile("lineage/logical-run.json"), (v) => {
      v.state = { lifecycle: "closed", outcome: "succeeded", acceptance: "pending", observability: "complete" };
    });
    expect((await lineage()).status).toBe("refused");
  });

  it("refuses invalid, foreign and misplaced attempt records by path only", async () => {
    await editJson(runFile("lineage/attempts/att-a1.json"), (v) => {
      v.state = { lifecycle: "closed", outcome: "succeeded", acceptance: "pending", observability: "complete" };
    });
    await editJson(runFile("lineage/attempts/att-a2.json"), (v) => {
      for (const e of [v.lineage, v.assignment_ref, ...(v.result_refs as unknown[])]) (e as Record<string, unknown>).source_id = "proj-b";
    });
    await writeFile(runFile("lineage/attempts/att-zz.json"), await readFile(runFile("lineage/attempts/att-b1.json")));
    const d = await available();
    expect(d.attempts.map((a) => a.attempt_id)).toEqual(["att-b1"]);
    expect(d.close_blockers.filter((b) => b.code === "record_refused").map((b) => b.subject)).toEqual([
      "lineage/attempts/att-a1.json",
      "lineage/attempts/att-a2.json",
      "lineage/attempts/att-zz.json",
    ]);
    expect(d.refused).toEqual([
      { file: "lineage/attempts/att-a1.json", reason: "invalid_record" },
      { file: "lineage/attempts/att-a2.json", reason: "foreign_source" },
      { file: "lineage/attempts/att-zz.json", reason: "misplaced" },
    ]);
  });

  it("negative control: a succeeded attempt with uncertain effects, lost receipts or no acceptance pin is refused", async () => {
    const succeeded = { lifecycle: "closed", outcome: "succeeded", acceptance: "verified", observability: "complete" };
    await editJson(runFile("lineage/attempts/att-b1.json"), (v) => {
      v.state = succeeded;
      v.result_refs = (JSON.parse(fx.files[`runs/${RUN()}/lineage/attempts/att-a2.json`]) as Record<string, unknown>).result_refs;
    });
    await editJson(runFile("lineage/attempts/att-a2.json"), (v) => {
      v.accepted_by_controller_epoch = null;
    });
    await editJson(runFile("lineage/attempts/att-a1.json"), (v) => {
      (v.assignment_ref as Record<string, unknown>).source_id = "proj-b";
    });
    const d = await available();
    expect(d.attempts).toEqual([]);
    expect(d.refused.map((r) => [r.file, r.reason])).toEqual([
      ["lineage/attempts/att-a1.json", "invalid_record"],
      ["lineage/attempts/att-a2.json", "invalid_record"],
      ["lineage/attempts/att-b1.json", "invalid_record"],
    ]);
  });

  it("negative control: an acknowledged transfer without retained activation and ack evidence is refused", async () => {
    const dir = join(guildDir(), "runs", RUN(), "transfers", "xfer-1");
    const committed = JSON.parse(await readFile(join(dir, "03-source_committed.json"), "utf8"));
    const activated = { ...committed, state: "target_activated", target_activation: committed.source_commit };
    await writeFile(join(dir, "04-target_activated.json"), JSON.stringify(activated));
    await writeFile(join(dir, "05-acknowledged.json"), JSON.stringify({ ...activated, state: "acknowledged" }));
    await writeFile(join(dir, "06-acknowledged.json"), JSON.stringify({ ...committed, state: "acknowledged", target_ack: committed.source_commit }));
    const d = await available();
    expect(d.transfers[0].state).toBe("target_activated");
    expect(d.close_blockers).toContainEqual({ code: "transfer_unacknowledged", subject: "xfer-1" });
    expect(d.refused).toEqual([
      { file: "transfers/xfer-1/05-acknowledged.json", reason: "invalid_record" },
      { file: "transfers/xfer-1/06-acknowledged.json", reason: "misplaced" },
    ]);
  });

  it("negative control: analysis with zero counters under unavailable coverage, bad totals or duplicate identities is refused", async () => {
    const body = join(guildDir(), "analysis", "runs", RUN(), "versions", "analysis-p05-1", "analysis.json");
    const ptr = join(guildDir(), "analysis", "runs", RUN(), "current.v2.json");
    const { createHash } = await import("node:crypto");
    const rewrite = async (edit: (v: Record<string, unknown>) => void) => {
      const v = JSON.parse(fx.files[`analysis/runs/${RUN()}/versions/analysis-p05-1/analysis.json`]);
      edit(v);
      const text = JSON.stringify(v);
      await writeFile(body, text);
      await editJson(ptr, (p) => void (p.analysis_sha256 = `sha256:${createHash("sha256").update(text).digest("hex")}`));
    };
    const usage = (v: Record<string, unknown>) => v.usage as Record<string, unknown>[];

    await rewrite(() => undefined);
    expect((await available()).usage.status).toBe("partial");

    await rewrite((v) => Object.assign(usage(v)[1], { input_inclusive: 0, output: 0, total: 0 }));
    expect((await available()).usage.status).toBe("refused");
    await rewrite((v) => Object.assign(usage(v)[0], { total: 999 }));
    expect((await available()).usage.status).toBe("refused");
    await rewrite((v) => Object.assign(usage(v)[1], { accounting_identity: "request-1" }));
    expect((await available()).usage.status).toBe("refused");
    await rewrite((v) => void delete (v.query as Record<string, unknown>).versions);
    expect((await available()).usage.status).toBe("refused");
    await rewrite((v) => void (v.metrics = [{}]));
    expect((await available()).usage.status).toBe("refused");
    await rewrite((v) => {
      const q = JSON.parse(JSON.stringify(v.query));
      q.versions.normalizer = "n2";
      v.metrics = [{ schema_version: "guild.stack.metric-series.v2", query: q }];
    });
    expect((await available()).usage.status).toBe("refused");
  });

  it("negative control: corrupting the only live attempt still blocks close", async () => {
    await editJson(runFile("lineage/attempts/att-b1.json"), (v) => {
      v.ordinal = 0;
    });
    const d = await available();
    expect(d.attempts.map((a) => a.attempt_id)).not.toContain("att-b1");
    expect(d.close_blockers).toContainEqual({ code: "record_refused", subject: "lineage/attempts/att-b1.json" });
  });

  it("negative control: an unreadable attempts directory is refused and blocks close", async () => {
    const dir = runFile("lineage/attempts");
    await chmod(dir, 0o000);
    try {
      const d = await available();
      expect(d.attempts).toEqual([]);
      expect(d.close_blockers).toContainEqual({ code: "record_refused", subject: "lineage/attempts" });
    } finally {
      await chmod(dir, 0o755);
    }
  });

  it("negative control: a transfer stage with different bindings is refused and does not advance the transfer", async () => {
    const dir = join(guildDir(), "runs", RUN(), "transfers", "xfer-1");
    const committed = JSON.parse(await readFile(join(dir, "03-source_committed.json"), "utf8"));
    const ev = committed.source_commit;
    await writeFile(
      join(dir, "05-acknowledged.json"),
      JSON.stringify({
        ...committed,
        state: "acknowledged",
        target_activation: ev,
        target_ack: ev,
        destination_work: { ...committed.destination_work, id: "task-other" },
      }),
    );
    const d = await available();
    expect(d.transfers[0]).toMatchObject({ state: "source_committed", stages: ["reserved", "target_prepared", "source_committed"] });
    expect(d.close_blockers).toContainEqual({ code: "transfer_unacknowledged", subject: "xfer-1" });
    expect(d.refused).toEqual([{ file: "transfers/xfer-1/05-acknowledged.json", reason: "invalid_record" }]);
  });

  it("negative control: transfer journal tampering is refused and keeps the transfer blocker", async () => {
    const dir = join(guildDir(), "runs", RUN(), "transfers", "xfer-1");
    const committed = JSON.parse(await readFile(join(dir, "03-source_committed.json"), "utf8"));
    await writeFile(join(dir, "intent.json"), "{}");
    // Aborted after a source commit is not a legal transition.
    await writeFile(join(dir, "aborted.json"), JSON.stringify({ ...committed, state: "aborted" }));
    // A later stage that rewrites recorded source-commit evidence.
    const rewritten = { ...committed.source_commit, sha256: `sha256:${"7".repeat(64)}` };
    await writeFile(join(dir, "04-target_activated.json"), JSON.stringify({ ...committed, state: "target_activated", source_commit: rewritten, target_activation: rewritten }));
    // A transfer whose only reserved stage is corrupt, and a file where an operation directory belongs.
    await writeFileDeep(join(guildDir(), "runs", RUN(), "transfers", "xfer-2", "01-reserved.json"), "{}");
    await writeFile(join(guildDir(), "runs", RUN(), "transfers", "xfer-3"), "not a directory");
    const d = await available();
    expect(d.transfers.map((t) => [t.operation_id, t.state])).toEqual([["xfer-1", "source_committed"]]);
    expect(d.refused).toEqual([
      { file: "transfers/xfer-3", reason: "unreadable" },
      { file: "transfers/xfer-1/04-target_activated.json", reason: "invalid_record" },
      { file: "transfers/xfer-1/aborted.json", reason: "invalid_record" },
      { file: "transfers/xfer-2/01-reserved.json", reason: "invalid_record" },
    ]);
    expect(d.close_blockers.map((b) => b.code)).toEqual(expect.arrayContaining(["transfer_unacknowledged", "record_refused"]));
    expect(d.close_blockers.filter((b) => b.code === "record_refused")).toHaveLength(4);
  });

  it("a transfer aborted before any source commit shows as aborted without a transfer blocker", async () => {
    const dir = join(guildDir(), "runs", RUN(), "transfers", "xfer-1");
    const prepared = JSON.parse(await readFile(join(dir, "02-target_prepared.json"), "utf8"));
    await unlink(join(dir, "03-source_committed.json"));
    await writeFile(join(dir, "aborted.json"), JSON.stringify({ ...prepared, state: "aborted" }));
    const d = await available();
    expect(d.transfers[0]).toMatchObject({ state: "aborted", stages: ["reserved", "target_prepared", "aborted"] });
    expect(d.close_blockers.map((b) => b.code)).not.toContain("transfer_unacknowledged");
  });

  it("a transfer aborted before its reservation (disposition conflict) shows as aborted", async () => {
    const dir = join(guildDir(), "runs", RUN(), "transfers", "xfer-1");
    const reserved = JSON.parse(await readFile(join(dir, "01-reserved.json"), "utf8"));
    await rm(dir, { recursive: true });
    await writeFileDeep(join(dir, "aborted.json"), JSON.stringify({ ...reserved, state: "aborted" }));
    const d = await available();
    expect(d.transfers[0]).toMatchObject({ state: "aborted", stages: ["aborted"] });
    expect(d.refused).toEqual([]);
    expect(d.close_blockers.map((b) => b.code)).not.toContain("transfer_unacknowledged");
  });

  it("marks usage partial when coverage is incomplete even if every counter is present", async () => {
    const body = join(guildDir(), "analysis", "runs", RUN(), "versions", "analysis-p05-1", "analysis.json");
    const v = JSON.parse(fx.files[`analysis/runs/${RUN()}/versions/analysis-p05-1/analysis.json`]);
    v.usage = [v.usage[0]];
    v.usage[0].coverage = { eligible: 2, covered: 1, excluded: 0, missing: 1, state: "partial", reason: "one request unobserved", exclusion_reasons: [] };
    const text = JSON.stringify(v);
    await writeFile(body, text);
    await editJson(join(guildDir(), "analysis", "runs", RUN(), "current.v2.json"), (p) => void (p.analysis_sha256 = sha256Text(text)));
    const d = await available();
    if (d.usage.status !== "partial") throw new Error(`expected partial usage, got ${d.usage.status}`);
    expect(d.usage.entries[0].coverage).toEqual({ state: "partial", reason: "one request unobserved" });
  });

  it("reads a v1 run as legacy and a run with no lineage as unavailable", async () => {
    await writeFileDeep(join(guildDir(), "runs", "run-legacy-1", "run.yaml"), "schema_version: guild.run.v1\nrun_id: run-legacy-1\n");
    await writeFileDeep(join(guildDir(), "runs", "run-empty-1", "notes.txt"), "x");
    expect((await readProjectRunLineage(root, "run-legacy-1", undefined, NOW)).status).toBe("legacy");
    expect((await readProjectRunLineage(root, "run-empty-1", undefined, NOW)).status).toBe("unavailable");
  });

  it("changes input_revision when any input changes and keeps it stable otherwise", async () => {
    const a = await available();
    expect((await available()).input_revision).toBe(a.input_revision);
    await editJson(runFile("lineage/attempts/att-b1.json"), (v) => {
      v.uncertain_effects = false;
    });
    expect((await available()).input_revision).not.toBe(a.input_revision);
  });

  it("serves the lineage through GET /api/project/runs/:run_id/lineage", async () => {
    await withApp(root, async (app) => {
      const res = await app.fetch(req(`/api/project/runs/${RUN()}/lineage`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Available;
      expect(body.status).toBe("available");
      expect(body.requested).toEqual({ run_id: RUN(), guild: null });
    });
  });
});

describe("AT40 · UI authority and security (reader)", () => {
  it("revalidates exact target revisions: only the current, unexpired, matching operation has current pins", async () => {
    const byId = Object.fromEntries((await available()).operations.map((o) => [o.operation_id, o.authority]));
    expect(byId["op-launch"]).toMatchObject({ status: "pins_current", codes: [] });
    expect(byId["op-launch"].unverified).toEqual(["scope_revision", "capability_revision", "policy_revision", "writer_scope"]);
    expect(byId["op-stale"]).toMatchObject({ status: "stale", codes: ["preview_expired", "target_revision_stale"] });
  });

  it("a changed target revision makes a previously current operation stale", async () => {
    await editJson(runFile("lineage/logical-run.json"), (v) => {
      v.initial_command = "/guild:build changed";
    });
    const op = (await available()).operations.find((o) => o.operation_id === "op-launch");
    expect(op?.authority).toMatchObject({ status: "stale", codes: ["target_revision_stale"] });
  });

  it("a changed dependency revision makes the operation stale", async () => {
    const exec2 = (await available()).executions.find((e) => e.execution_id === "exec-2")!;
    let hash = "";
    await editJson(opFile("op-launch", "preview"), (v) => {
      v.dependencies = [{ source_id: "proj-a", kind: "execution", id: "exec-2", revision: exec2.revision }];
      hash = previewHash(v);
      v.preview_hash = hash;
    });
    for (const name of ["approval", "receipt"]) await editJson(opFile("op-launch", name), (v) => void (v.preview_hash = hash));
    const current = (await available()).operations.find((o) => o.operation_id === "op-launch");
    expect(current?.authority.status).toBe("pins_current");

    await editJson(runFile("lineage/executions/exec-2.json"), (v) => {
      v.admission = "reconcile_only";
    });
    const stale = (await available()).operations.find((o) => o.operation_id === "op-launch");
    expect(stale?.authority).toMatchObject({ status: "stale", codes: ["dependency_revision_stale"] });
  });

  it("negative control: an approval reused against another source or epoch fails", async () => {
    const byId = Object.fromEntries((await available()).operations.map((o) => [o.operation_id, o.authority]));
    expect(byId["op-reused-source"].status).toBe("stale");
    expect(byId["op-reused-source"].codes).toContain("approval_source_mismatch");
    expect(byId["op-reused-epoch"]).toMatchObject({ status: "stale", codes: ["approval_authority_mismatch"] });
    expect(byId["op-old-epoch"]).toMatchObject({ status: "stale", codes: ["controller_epoch_mismatch"] });
  });

  it("negative control: a tampered preview fails its own hash and is stale", async () => {
    await editJson(opFile("op-launch", "preview"), (v) => {
      v.expires_at = "2099-06-01T00:00:00Z";
    });
    const op = (await available()).operations.find((o) => o.operation_id === "op-launch");
    expect(op?.authority.status).toBe("stale");
    expect(op?.authority.codes).toContain("preview_hash_mismatch");
  });

  it("negative control: a preview outside the operation catalog or with unbound arguments is refused", async () => {
    const rehash = (v: Record<string, unknown>) => {
      v.arguments_hash = sha256Text(canonicalJson(v.arguments));
      v.preview_hash = previewHash(v);
    };
    await editJson(opFile("op-launch", "preview"), (v) => {
      v.operation = "v2.unknown";
      rehash(v);
    });
    await editJson(opFile("op-stale", "preview"), (v) => {
      (v.arguments as Record<string, unknown>).expected_revision = `sha256:${"9".repeat(64)}`;
      rehash(v);
    });
    const d = await available();
    expect(d.operations.map((o) => o.operation_id)).not.toContain("op-launch");
    expect(d.operations.map((o) => o.operation_id)).not.toContain("op-stale");
    expect(d.refused).toEqual(
      expect.arrayContaining([
        { file: ".guild/artifacts/operations/op-launch/preview.json", reason: "invalid_record" },
        { file: ".guild/artifacts/operations/op-stale/preview.json", reason: "invalid_record" },
      ]),
    );
  });

  it("negative control: a receipt from another controller epoch is not correlated with the preview", async () => {
    await editJson(opFile("op-launch", "receipt"), (v) => {
      (v.authority as Record<string, unknown>).controller_epoch = 2;
    });
    const op = (await available()).operations.find((o) => o.operation_id === "op-launch");
    expect(op?.receipt?.correlation).toBe("uncorrelated");
  });

  it("a stale operation is read without side effects and the route accepts no writes", async () => {
    const before = await snapshot(root);
    await withApp(root, async (app) => {
      expect((await app.fetch(req(`/api/project/runs/${RUN()}/lineage`))).status).toBe(200);
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await app.fetch(req(`/api/project/runs/${RUN()}/lineage`, { method, body: "{}" }));
        expect(res.status, method).toBeGreaterThanOrEqual(400);
      }
    });
    expect(await snapshot(root)).toEqual(before);
  });

  it("keeps hostile text as data and withholds private paths, arguments and writer scopes", async () => {
    const d = await available();
    expect(d.run.initial_command).toContain("<script>");
    expect(d.run.initial_prompt).toEqual({
      sha256: expect.stringMatching(/^sha256:/),
      schema_version: "guild.prompt.v1",
      availability: "redacted",
      reason: "raw prompt withheld by retention policy",
    });
    const text = JSON.stringify(d);
    for (const secret of ["private/prompt.txt", '"path"', "writer_scope_hash", '"arguments"', "rationale", "launch_hash", "idempotency_id", root]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("separates same local ids in workspace children by source", async () => {
    const ws = await mkdtemp(join(tmpdir(), "u01-ws-"));
    try {
      await writeFileDeep(
        join(ws, ".guild", "workspace.json"),
        JSON.stringify({
          schema_version: "guild.workspace.v1",
          is_workspace: true,
          sub_guilds: [
            { name: "alpha", path: "alpha", kind: "sub-guild" },
            { name: "beta", path: "beta", kind: "sub-guild" },
          ],
        }),
      );
      await seed(join(ws, "alpha"));
      await writeFileDeep(runFile("run.yaml", join(ws, "beta")), `schema_version: guild.run.v1\nrun_id: ${RUN()}\n`);
      // beta holds an operation naming the same local run id; it must not reach alpha's view.
      await writeFileDeep(opFile("op-beta", "preview", join(ws, "beta")), fx.files["artifacts/operations/op-launch/preview.json"]);

      await expect(lineage(ws)).rejects.toMatchObject({ kind: "ambiguous_guild" });
      const alpha = await lineage(ws, "alpha");
      expect(alpha).toMatchObject({ status: "available", source_guild: "alpha", requested: { guild: "alpha" } });
      expect(await lineage(ws, "beta")).toMatchObject({ status: "legacy", source_guild: "beta", requested: { guild: "beta" } });
      expect((alpha as Available).operations.map((o) => o.operation_id)).not.toContain("op-beta");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  it("skips symlinked records and refuses a symlinked run directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "u01-out-"));
    try {
      await writeFile(join(outside, "att-x.json"), await readFile(runFile("lineage/attempts/att-b1.json")));
      await symlink(join(outside, "att-x.json"), runFile("lineage/attempts/att-x.json"));
      const linked = await available();
      expect(linked.attempts.map((a) => a.attempt_id)).not.toContain("att-x");
      expect(linked.refused).toContainEqual({ file: "lineage/attempts/att-x.json", reason: "unreadable" });
      expect(linked.close_blockers).toContainEqual({ code: "record_refused", subject: "lineage/attempts/att-x.json" });
      await unlink(runFile("lineage/attempts/att-x.json"));

      const moved = join(outside, "run");
      await writeFileDeep(join(moved, "lineage", "logical-run.json"), fx.files[`runs/${RUN()}/lineage/logical-run.json`]);
      await rm(join(guildDir(), "runs", RUN()), { recursive: true });
      await symlink(moved, join(guildDir(), "runs", RUN()));
      await expect(lineage()).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
