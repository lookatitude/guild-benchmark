// Tests for POST /api/imports/lifecycle — Fix 2 (Location resolves) and
// collision behaviour (Fix 3 surfaced at server layer).
//
// The fixture trees live under tests/fixtures/lifecycle/ and are copied
// into a temp dir per test (same stageFixture pattern as lifecycle-importer.test.ts).

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type { LifecycleImportResponse, RunDetailResponse, RunsListResponse } from "../src/types.js";
import { req } from "./server.helpers.js";

const FIXTURES = resolve(__dirname, "fixtures", "lifecycle");

async function stageFixture(workDir: string, fixtureName: string): Promise<string> {
  const dest = join(workDir, fixtureName);
  await mkdir(dest, { recursive: true });
  await cp(join(FIXTURES, fixtureName, ".guild"), join(dest, ".guild"), {
    recursive: true,
  });
  return dest;
}

describe("server / POST /api/imports/lifecycle", () => {
  let root: string;
  let runsDir: string;
  let casesDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "server-lifecycle-import-"));
    runsDir = join(root, "benchmark-runs");
    casesDir = join(root, "cases");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // ---- Fix 2: the Location header must resolve via GET /api/runs/:id ----
  it("Fix 2: POST returns 201 and GET /api/runs/:id resolves (run.json/metrics.json/score.json materialised)", async () => {
    const projectRoot = await stageFixture(root, "learn-run");
    const sourceRunDir = join(projectRoot, ".guild", "runs", "run-learn-001");
    const app = createApp({ runsDir, casesDir, port: 0 });

    const importRes = await app.fetch(
      req("/api/imports/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_dir: sourceRunDir, run_id: "lc-learn-001" }),
      }),
    );
    expect(importRes.status).toBe(201);
    const importBody = (await importRes.json()) as LifecycleImportResponse;
    expect(importBody.run_id).toBe("lc-learn-001");
    expect(importBody.location).toBe("/api/runs/lc-learn-001");
    expect(importBody.run_type).toBe("learn");

    // Standard artifacts must be on disk so the handler can serve them.
    expect(existsSync(join(runsDir, "lc-learn-001", "run.json"))).toBe(true);
    expect(existsSync(join(runsDir, "lc-learn-001", "metrics.json"))).toBe(true);
    expect(existsSync(join(runsDir, "lc-learn-001", "score.json"))).toBe(true);
    // lifecycle-record.json is also written by the importer itself.
    expect(existsSync(join(runsDir, "lc-learn-001", "lifecycle-record.json"))).toBe(true);

    // Following the Location must return 200, not 404.
    const detailRes = await app.fetch(req("/api/runs/lc-learn-001"));
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as RunDetailResponse;
    expect(detail.run.run_id).toBe("lc-learn-001");
    expect(detail.run.case_slug).toBe("lifecycle-learn");
    expect(detail.run.plugin_ref).toBe("lifecycle-import");
    expect(detail.score.run_id).toBe("lc-learn-001");
    expect(detail.metrics.run_id).toBe("lc-learn-001");
  });

  it("Fix 2: imported lifecycle run appears in GET /api/runs list (requires score.json + run.json)", async () => {
    const projectRoot = await stageFixture(root, "learn-run");
    const sourceRunDir = join(projectRoot, ".guild", "runs", "run-learn-001");
    const app = createApp({ runsDir, casesDir, port: 0 });

    await app.fetch(
      req("/api/imports/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_dir: sourceRunDir, run_id: "lc-list-test" }),
      }),
    );

    const listRes = await app.fetch(req("/api/runs"));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as RunsListResponse;
    const row = listBody.runs.find((r) => r.run_id === "lc-list-test");
    expect(row).toBeDefined();
    expect(row?.case_slug).toBe("lifecycle-learn");
    expect(row?.plugin_ref).toBe("lifecycle-import");
  });

  // ---- Fix 3: collision must return 400, not silently mix artifacts ------
  it("Fix 3: second POST with the same run-id is refused with 400 (collision guard)", async () => {
    const projectRoot = await stageFixture(root, "learn-run");
    const sourceRunDir = join(projectRoot, ".guild", "runs", "run-learn-001");
    const app = createApp({ runsDir, casesDir, port: 0 });

    const first = await app.fetch(
      req("/api/imports/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_dir: sourceRunDir, run_id: "lc-collision" }),
      }),
    );
    expect(first.status).toBe(201);

    // Second import with the same run-id must be refused, not silently mix.
    const second = await app.fetch(
      req("/api/imports/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_dir: sourceRunDir, run_id: "lc-collision" }),
      }),
    );
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toMatch(/run already exists/);
  });

  // ---- Fix 1 (server layer): Location resolves after import from rotated archive ----
  it("Fix 1+2: lifecycle import with close marker in rotated archive still materialises correct artifacts", async () => {
    const projectRoot = await stageFixture(root, "learn-run-rotated");
    const sourceRunDir = join(projectRoot, ".guild", "runs", "run-learn-rotated-001");
    const app = createApp({ runsDir, casesDir, port: 0 });

    const importRes = await app.fetch(
      req("/api/imports/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_dir: sourceRunDir, run_id: "lc-rotated-001" }),
      }),
    );
    expect(importRes.status).toBe(201);

    const detailRes = await app.fetch(req("/api/runs/lc-rotated-001"));
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as RunDetailResponse;
    expect(detail.run.run_id).toBe("lc-rotated-001");
    // Closed run => status = pass.
    expect(detail.run.status).toBe("pass");
  });

  it("returns 400 on missing run_dir field", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(
      req("/api/imports/lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/run_dir/);
  });
});
