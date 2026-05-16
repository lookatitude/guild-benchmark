import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type { AuditLogImportResponse, RunDetailResponse } from "../src/types.js";
import { req } from "./server.helpers.js";

describe("server / POST /api/imports/audit-log", () => {
  let root: string;
  let runsDir: string;
  let casesDir: string;
  let sourceRunDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "audit-import-"));
    runsDir = join(root, "benchmark-runs");
    casesDir = join(root, "cases");
    sourceRunDir = join(root, "project", ".guild", "runs", "run-plugin-001");
    await mkdir(join(sourceRunDir, "logs"), { recursive: true });
    await writeFile(
      join(sourceRunDir, "logs", "v1.4-events.jsonl"),
      [
        {
          ts: "2026-04-27T07:00:00.000Z",
          event: "phase_start",
          run_id: "run-plugin-001",
          phase: "execute",
        },
        {
          ts: "2026-04-27T07:00:01.000Z",
          event: "specialist_dispatch",
          run_id: "run-plugin-001",
          lane_id: "T3a-backend-config",
          specialist: "backend",
          task_id: "T3a-backend-config",
          prompt_excerpt: "implement",
        },
        {
          ts: "2026-04-27T07:00:02.000Z",
          event: "loop_round_start",
          run_id: "run-plugin-001",
          lane_id: "T3a-backend-config",
          loop_layer: "L4",
          round_number: 1,
          cap: 16,
        },
        {
          ts: "2026-04-27T07:00:03.000Z",
          event: "loop_round_end",
          run_id: "run-plugin-001",
          lane_id: "T3a-backend-config",
          loop_layer: "L4",
          round_number: 1,
          terminated: "satisfied",
          terminator: "qa",
        },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("imports a local .guild run and exposes it through normal run detail", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(
      req("/api/imports/audit-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_dir: sourceRunDir,
          run_id: "audit-plugin-001",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as AuditLogImportResponse;
    expect(body.run_id).toBe("audit-plugin-001");
    expect(body.location).toBe("/api/runs/audit-plugin-001");
    expect(body.source_run_id).toBe("run-plugin-001");
    expect(existsSync(join(runsDir, "audit-plugin-001", "run.json"))).toBe(true);
    expect(existsSync(join(runsDir, "audit-plugin-001", "metrics.json"))).toBe(true);
    expect(existsSync(join(runsDir, "audit-plugin-001", "score.json"))).toBe(true);
    expect(
      existsSync(
        join(
          runsDir,
          "audit-plugin-001",
          "artifacts",
          ".guild",
          "runs",
          "run-plugin-001",
          "logs",
          "v1.4-events.jsonl",
        ),
      ),
    ).toBe(true);

    const detailRes = await app.fetch(req("/api/runs/audit-plugin-001"));
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as RunDetailResponse;
    expect(detail.run.case_slug).toBe("plugin-audit-log");
    expect(detail.events).toContainEqual({
      ts: "2026-04-27T07:00:00.000Z",
      type: "stage_started",
      stage: "execute",
    });
    expect(detail.metrics.dispatched_specialists).toEqual(["backend"]);
    expect(detail.metrics.loop_rounds_per_lane["T3a-backend-config"]?.L4).toMatchObject({
      started: 1,
      ended: 1,
      max_round_number: 1,
      cap: 16,
      last_terminated: "satisfied",
      last_terminator: "qa",
    });
  });

  it("rejects paths that are not .guild/runs/<run-id> directories", async () => {
    const app = createApp({ runsDir, casesDir, port: 0 });
    const res = await app.fetch(
      req("/api/imports/audit-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_dir: join(root, "project") }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/\.guild\/runs\/<run-id>/);
  });
});
