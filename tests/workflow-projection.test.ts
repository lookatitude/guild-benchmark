// AT41 (U02) — C8 WorkflowProjection v2 read adapter.
// Fixtures in fixtures/contracts/c8-v2 pass the frozen A02 validator
// (contracts/guild-stack/v2/verify_contracts.py validate('workflow-projection')).
import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import {
  WORKFLOW_PROJECTION_FILE,
  WORKFLOW_PROJECTION_MAX_BYTES,
  parseWorkflowProjectionV2,
  readProjectRunWorkflow,
} from "../src/workflow-projection.js";
import { writeFileDeep } from "./project.helpers.js";
import { req } from "./server.helpers.js";

const FIX = join(__dirname, "..", "fixtures", "contracts", "c8-v2");
const load = (name: string): Record<string, any> => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const NEW_RUN = "run-20261105-000002-composed";
const OLD_RUN = "run-20261101-000001-composed";

describe("parseWorkflowProjectionV2 (AT41)", () => {
  it("accepts the frozen A02 example and both AT41 fixtures unchanged", () => {
    for (const name of ["a02-example.json", "at41-run-new.json", "at41-run-old.json"]) {
      const doc = load(name);
      const parsed = parseWorkflowProjectionV2(doc);
      expect(parsed, name).toEqual({ ok: true, projection: doc });
    }
  });

  const refusals: Array<[string, (d: Record<string, any>) => void, RegExp]> = [
    ["unknown top-level field", (d) => (d.extra = 1), /unknown field/],
    ["unknown node field", (d) => (d.nodes[0].editable = true), /unknown field/],
    ["wrong schema version", (d) => (d.schema_version = "guild.stack.workflow-projection.v1"), /schema_version/],
    ["bad hash", (d) => (d.definition_hash = "sha256:XYZ"), /definition_hash/],
    ["missing obligations", (d) => delete d.obligations, /obligations/],
    ["invocation pinned to another definition", (d) => (d.invocations[1].definition_hash = `sha256:${"6f".repeat(32)}`), /invocation definition changed/],
    ["round beyond max", (d) => (d.invocations[1].round = 4), /round exceeds bound/],
    ["accepted with open questions", (d) => (d.invocations[1].state = "accepted"), /unresolved questions/],
    ["obligation on unknown invocation", (d) => (d.obligations[2].invocation_id = "inv-x"), /unknown invocation/],
    ["accepted obligation without evidence", (d) => (d.obligations[0].evidence = []), /available workflow-owner evidence/],
    ["release path bypasses a gate", (d) => d.edges.push({ from: "build", to: "release", on: "skip" }), /bypasses protected gate/],
    ["edge to unknown node", (d) => d.edges.push({ from: "build", to: "ghost", on: "pass" }), /unknown expanded edge endpoint/],
    ["evidence path escapes", (d) => (d.obligations[0].evidence[0].path = "../secret.json"), /path/],
  ];
  for (const [label, mutate, rule] of refusals) {
    it(`refuses: ${label}`, () => {
      const doc = load("at41-run-new.json");
      mutate(doc);
      const parsed = parseWorkflowProjectionV2(doc);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.issues.join("\n")).toMatch(rule);
    });
  }

  it("refuses non-objects", () => {
    for (const v of [null, [], "x", 3]) expect(parseWorkflowProjectionV2(v).ok).toBe(false);
  });
});

describe("readProjectRunWorkflow + GET /api/project/runs/:run_id/workflow (AT41)", () => {
  let root: string;
  let outside: string;
  const runDir = (id: string) => join(root, ".guild", "runs", id);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "u02-wf-root-"));
    outside = await mkdtemp(join(tmpdir(), "u02-wf-out-"));
    for (const id of [NEW_RUN, OLD_RUN, "run-20261105-000003-nowf", "run-20261105-000004-bad", "run-20261105-000005-link"]) {
      await writeFileDeep(join(runDir(id), "run.yaml"), `run_id: ${id}\n`);
    }
    await writeFile(join(runDir(NEW_RUN), WORKFLOW_PROJECTION_FILE), readFileSync(join(FIX, "at41-run-new.json")));
    await writeFile(join(runDir(OLD_RUN), WORKFLOW_PROJECTION_FILE), readFileSync(join(FIX, "at41-run-old.json")));
    await writeFile(join(runDir("run-20261105-000004-bad"), WORKFLOW_PROJECTION_FILE), "{not json");
    await writeFile(join(outside, "p.json"), readFileSync(join(FIX, "at41-run-new.json")));
    await symlink(join(outside, "p.json"), join(runDir("run-20261105-000005-link"), WORKFLOW_PROJECTION_FILE));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("each run returns its own pinned definition", async () => {
    const a = await readProjectRunWorkflow(root, NEW_RUN);
    const b = await readProjectRunWorkflow(root, OLD_RUN);
    expect(a.status).toBe("available");
    expect(b.status).toBe("available");
    if (a.status === "available" && b.status === "available") {
      expect(a.projection.definition_hash).toBe(`sha256:${"1a".repeat(32)}`);
      expect(b.projection.definition_hash).toBe(`sha256:${"6f".repeat(32)}`);
    }
  });

  it("missing projection is unavailable, not empty", async () => {
    const r = await readProjectRunWorkflow(root, "run-20261105-000003-nowf");
    expect(r).toEqual({ status: "unavailable", run_id: "run-20261105-000003-nowf", reason: expect.stringMatching(/no workflow-projection\.json/) });
    expect(r).not.toHaveProperty("projection");
  });

  it("invalid JSON is refused with no partial projection", async () => {
    const r = await readProjectRunWorkflow(root, "run-20261105-000004-bad");
    expect(r.status).toBe("refused");
    expect(r).not.toHaveProperty("projection");
  });

  it("a symlinked projection is not followed", async () => {
    const r = await readProjectRunWorkflow(root, "run-20261105-000005-link");
    expect(r.status).not.toBe("available");
    expect(JSON.stringify(r)).not.toContain(outside);
  });

  it("oversized projection is refused", async () => {
    await writeFile(join(runDir("run-20261105-000003-nowf"), WORKFLOW_PROJECTION_FILE), " ".repeat(WORKFLOW_PROJECTION_MAX_BYTES + 1));
    const r = await readProjectRunWorkflow(root, "run-20261105-000003-nowf");
    expect(r.status).toBe("refused");
  });

  it("serves the read over GET only; unknown run is 404", async () => {
    const app = createApp({ runsDir: join(root, "none"), casesDir: join(root, "none"), port: 0, projectRoot: root });
    const ok = await app.fetch(req(`/api/project/runs/${NEW_RUN}/workflow`));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { status: string; projection: { definition_hash: string } };
    expect(body.status).toBe("available");
    expect(body.projection.definition_hash).toBe(`sha256:${"1a".repeat(32)}`);
    const missing = await app.fetch(req(`/api/project/runs/run-20990101-000000-none/workflow`));
    expect(missing.status).toBe(404);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await app.fetch(req(`/api/project/runs/${NEW_RUN}/workflow`, { method }));
      expect(res.status, method).not.toBe(200);
    }
  });
});

describe("inspector stylesheet (AT41 themes + narrow view)", () => {
  it("uses theme tokens only and stacks on narrow screens", () => {
    const css = readFileSync(join(__dirname, "..", "ui", "src", "styles", "workflow-inspector.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).toMatch(/var\(--color-/);
    expect(css).toMatch(/@media \(max-width: 560px\)/);
  });
});
