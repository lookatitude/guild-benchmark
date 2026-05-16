import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type { RunDetailResponse } from "../src/types.js";
import { req, seedRun } from "./server.helpers.js";

// HTTP integration — GET /api/runs/:run_id.
describe("server / GET /api/runs/:run_id", () => {
  let runsDir: string;
  let casesDir: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "qa-detail-"));
    casesDir = await mkdtemp(join(tmpdir(), "qa-cases-"));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
    await rm(casesDir, { recursive: true, force: true });
  });

  it("returns the joined RunDetailResponse with parsed events", async () => {
    await seedRun(runsDir, "demo-001");
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/demo-001"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await res.json()) as RunDetailResponse;
    expect(Object.keys(body).sort()).toEqual(["events", "metrics", "run", "score"]);
    expect(body.run.run_id).toBe("demo-001");
    expect(body.score.guild_score).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    // Type-level pin: parsed events must carry the discriminated `type` field.
    for (const ev of body.events) {
      expect(typeof ev.type).toBe("string");
    }
  });

  it("returns 404 for an unknown run id", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/missing-run-001"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/run not found/);
  });

  it("returns 400 for an invalid (unsafe) run id", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/..%2Fescape"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid run_id/);
  });

  it("returns 404 with the not-yet-scored message when score.json is missing", async () => {
    await seedRun(runsDir, "unscored-001", { withScore: false });
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/unscored-001"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not yet scored/);
  });

  it("returns 404 when run.json is missing entirely", async () => {
    await seedRun(runsDir, "broken-001");
    await unlink(join(runsDir, "broken-001", "run.json"));
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/broken-001"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/run\.json not found/);
  });

  it("returns an empty events array when events.ndjson is absent", async () => {
    await seedRun(runsDir, "noevents-001", { withEvents: false });
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/noevents-001"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunDetailResponse;
    expect(body.events).toEqual([]);
  });

  it("falls back to v1.4 JSONL events and augments loop metrics", async () => {
    const dir = await seedRun(runsDir, "v14-detail-001", { withEvents: false });
    await mkdir(join(dir, "logs"), { recursive: true });
    await writeFile(
      join(dir, "logs", "v1.4-events.jsonl"),
      [
        {
          ts: "2026-04-27T07:00:00.000Z",
          event: "phase_start",
          run_id: "v14-detail-001",
          phase: "execute",
        },
        {
          ts: "2026-04-27T07:00:01.000Z",
          event: "loop_round_start",
          run_id: "v14-detail-001",
          lane_id: "T3a-backend-config",
          loop_layer: "L4",
          round_number: 1,
          cap: 16,
        },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await writeFile(
      join(dir, "metrics.json"),
      JSON.stringify(
        {
          schema_version: 1,
          run_id: "v14-detail-001",
          computed_at: "2026-04-26T05:51:00Z",
          stages: [],
          dispatched_specialists: [],
          expected_specialists: [],
          acceptance_commands: [],
          expected_stage_order: [],
          observed_stage_order: [],
          gate_outcomes: {},
          retry_count: 0,
          tool_error_count: 0,
        },
        null,
        2,
      ),
    );
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(req("/api/runs/v14-detail-001"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunDetailResponse;
    expect(body.events).toEqual([
      { ts: "2026-04-27T07:00:00.000Z", type: "stage_started", stage: "execute" },
    ]);
    expect(body.metrics.loop_rounds_per_lane["T3a-backend-config"]?.L4).toMatchObject({
      started: 1,
      ended: 0,
      max_round_number: 1,
      cap: 16,
    });
  });
});
