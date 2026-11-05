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
    ["impossible calendar date", (d) => (d.obligations[0].evidence[0].observed_at = "2026-02-30T09:00:00Z"), /RFC 3339/],
    ["hour out of range", (d) => (d.obligations[0].evidence[0].observed_at = "2026-02-10T24:00:00Z"), /RFC 3339/],
    ["unsafe integer round", (d) => { d.invocations[1].round = 2 ** 53; d.invocations[1].max_rounds = 2 ** 53; }, /safe integer/],
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

  it("counts string length in code points, as the schema does", () => {
    const doc = load("at41-run-new.json");
    doc.obligations[1].evidence[1].reason = "\u{1F512}".repeat(4096);
    expect(parseWorkflowProjectionV2(doc).ok).toBe(true);
    doc.obligations[1].evidence[1].reason = "\u{1F512}".repeat(4097);
    expect(parseWorkflowProjectionV2(doc).ok).toBe(false);
  });

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

  it("artifact reader never buffers past the cap", async () => {
    const { readProjectRunArtifact } = await import("../src/project-reader.js");
    await writeFile(join(runDir("run-20261105-000003-nowf"), "big.json"), "x".repeat(64));
    await expect(readProjectRunArtifact(root, "run-20261105-000003-nowf", ["big.json"], undefined, 63)).rejects.toThrow("artifact too large");
    const ok = await readProjectRunArtifact(root, "run-20261105-000003-nowf", ["big.json"], undefined, 64);
    expect(ok.body.length).toBe(64);
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

// Theme check without a browser: resolve each token in light and dark from
// the vendored tokens.css (oklch values carry their sRGB hex in a comment) and
// require WCAG AA 4.5:1 for every text/background pair the inspector paints.
const STYLES = join(__dirname, "..", "ui", "src", "styles");
function themeTokens(theme: "light" | "dark"): (name: string) => string {
  const css = readFileSync(join(STYLES, "system", "tokens.css"), "utf8");
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const decls = (body: string) =>
    new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);([^\n]*)/g)].map((m) => [m[1], { value: m[2].trim(), note: m[3] }]));
  const sel = theme === "light" ? '[data-theme="light"]' : '[data-theme="dark"]';
  const themed = blocks.filter((b) => b[1].includes(sel)).map((b) => decls(b[2]));
  const base = blocks.filter((b) => !b[1].includes("data-theme")).map((b) => decls(b[2]));
  const scopes = [...themed, ...base];
  const resolve = (name: string, depth = 0): string => {
    if (depth > 10) throw new Error(`token loop at ${name}`);
    for (const scope of scopes) {
      const d = scope.get(name);
      if (!d) continue;
      const ref = /^var\((--[\w-]+)\)$/.exec(d.value);
      if (ref) return resolve(ref[1], depth + 1);
      const hex = /#[0-9a-fA-F]{6}\b/.exec(d.value) ?? /#[0-9a-fA-F]{6}\b/.exec(d.note);
      if (hex) return hex[0];
      throw new Error(`no sRGB value for ${name}: ${d.value}`);
    }
    throw new Error(`unknown token ${name} (${theme})`);
  };
  return resolve;
}
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("inspector stylesheet (AT41 themes + narrow view)", () => {
  const css = readFileSync(join(STYLES, "workflow-inspector.css"), "utf8");
  // Pairs declared in one rule, plus text that inherits onto a painted card.
  const declared = [...css.matchAll(/\{([^{}]*)\}/g)]
    .map((m) => [/(?:^|;)\s*color:\s*var\((--[\w-]+)\)/.exec(m[1])?.[1], /background:\s*var\((--[\w-]+)\)/.exec(m[1])?.[1]])
    .filter((p): p is [string, string] => p[0] !== undefined && p[1] !== undefined);
  const inherited: Array<[string, string]> = [
    ["--color-fg", "--color-surface"],
    ["--color-fg-muted", "--color-surface"],
    ["--color-fg", "--color-danger-bg"],
    ["--color-fg-muted", "--color-danger-bg"],
    ["--color-danger-fg", "--color-danger-bg"],
  ];
  for (const theme of ["light", "dark"] as const) {
    it(`every text/background pair meets 4.5:1 in ${theme}`, () => {
      const t = themeTokens(theme);
      expect(declared.length).toBeGreaterThanOrEqual(8);
      for (const [fg, bg] of [...declared, ...inherited]) {
        expect(contrast(t(fg), t(bg)), `${theme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("negative control: the contrast check rejects a low-contrast pair", () => {
    const t = themeTokens("light");
    expect(contrast(t("--color-border"), t("--color-surface"))).toBeLessThan(4.5);
  });

  it("uses theme tokens only; narrow view stacks pins and tabs and wraps hashes", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const narrow = /@media \(max-width: 560px\) \{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? "";
    expect(narrow).toMatch(/\.wf-pins \{ grid-template-columns: 1fr; \}/);
    expect(narrow).toMatch(/\.wf-tabs \[role="tab"\] \{ flex: 1 1 100%/);
    expect(css).toMatch(/\.wf-hash \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.wf-node p \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.wf-node \{[^}]*min-width: 0; overflow-wrap: anywhere/);
    expect(css).toMatch(/\.wf-nodes, \.wf-components \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  });
});
