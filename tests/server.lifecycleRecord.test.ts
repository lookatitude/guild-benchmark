// server.lifecycleRecord.test.ts — SC-9
// TDD RED phase: tests for GET /api/runs/:run_id/lifecycle-record
// Written BEFORE the endpoint exists.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type { LifecycleRunRecord } from "../src/types.js";
import { req, seedRun } from "./server.helpers.js";

const SAMPLE_RECORD: LifecycleRunRecord = {
  run_id: "lc-test-001",
  command: "/guild:learn",
  run_class: "full",
  run_type: "learn",
  benchmark_eligible: false,
  started_at: "2026-05-01T10:00:00Z",
  closed_at: "2026-05-01T10:10:00Z",
  status: "closed",
  phases_log: [
    { phase: "detect", at: "2026-05-01T10:00:01Z" },
    { phase: "learn", at: "2026-05-01T10:01:00Z" },
  ],
  timeline: [
    { at: "2026-05-01T10:00:00Z", kind: "run_started", label: "run_started" },
    { at: "2026-05-01T10:00:01Z", kind: "phase", label: "detect" },
    { at: "2026-05-01T10:01:00Z", kind: "phase", label: "learn" },
    { at: "2026-05-01T10:10:00Z", kind: "run_closed", label: "run_closed" },
  ],
  metrics: {
    replay_completeness: "full",
    benchmark_fixture_eligible: false,
  },
  partial: false,
  missing_artifacts: [],
};

describe("server / GET /api/runs/:run_id/lifecycle-record", () => {
  let runsDir: string;
  let casesDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "qa-lc-record-"));
    casesDir = await mkdtemp(join(tmpdir(), "qa-lc-cases-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
    await rm(casesDir, { recursive: true, force: true });
  });

  it("returns the lifecycle-record.json when present", async () => {
    // Seed a run dir + lifecycle-record.json
    await seedRun(runsDir, "lc-test-001");
    await writeFile(
      join(runsDir, "lc-test-001", "lifecycle-record.json"),
      JSON.stringify(SAMPLE_RECORD, null, 2) + "\n",
    );

    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/lc-test-001/lifecycle-record"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await res.json()) as LifecycleRunRecord;
    expect(body.run_id).toBe("lc-test-001");
    expect(body.run_type).toBe("learn");
    expect(Array.isArray(body.timeline)).toBe(true);
    expect(body.timeline).toHaveLength(4);
    expect(body.timeline[0].kind).toBe("run_started");
    expect(body.timeline[3].kind).toBe("run_closed");
  });

  it("returns 404 when lifecycle-record.json is absent (standard benchmark run)", async () => {
    await seedRun(runsDir, "no-lc-001");
    // No lifecycle-record.json written

    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/no-lc-001/lifecycle-record"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no lifecycle record/i);
  });

  it("returns 404 when the run dir itself does not exist", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/nonexistent-999/lifecycle-record"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/run not found|no lifecycle record/i);
  });

  it("returns 400 for an invalid (unsafe) run id", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/..%2Fescape/lifecycle-record"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid run_id/);
  });
});
