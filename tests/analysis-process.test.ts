// D00 — packaged producer configuration + read-only inspect transport.
// Acceptance: D00-AC1 (production CLI flag reaches ServerOpts; one validated
// packaged transport), D00-AC2 (read-only inspect creates no canonical files
// and returns unavailable/current/stale/missing/unsupported/refused
// distinctly), D00-AC3 (paths with spaces work; arbitrary executable/source
// fallback injection fails through the actual serve entry).
//
// Fixtures are SYNTHETIC packaged plugins (no sibling plugin source, no
// plugin import): a manifest + inventory + a small CommonJS run-analysis.js
// that speaks the C-CLI inspect wire shape from canned responses and writes
// nothing.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AnalysisPackageError,
  RUN_ANALYSIS_ENTRY,
  SUPPORTED_INVENTORY_SCHEMA,
  TRANSPORT_LIMITS,
  inspectArtifact,
  isSafeAnalysisId,
  resolvePackagedRuntime,
  type PackagedRuntime,
} from "../src/analysis-process.js";

const REPO_ROOT = resolve(__dirname, "..");
const CLI_PATH = resolve(REPO_ROOT, "src", "cli.ts");
const TSX_BIN = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");

// ---- synthetic packaged-plugin fixture -------------------------------------

const PLUGIN_NAME = "guild";
const PLUGIN_VERSION = "3.1.0";

/**
 * The fake compiled producer. CommonJS on purpose (the fixture package has no
 * package.json, so .js resolves CJS). Behaviour is keyed on the inspected id:
 *   cur-1 / stale-1 / missing-1 / unsup-1  → exit 0 + full inspect JSON
 *   refuse-1                               → stderr + exit 1 (producer refusal)
 *   badjson-1                              → non-JSON stdout + exit 0
 *   badfields-1                            → JSON missing fields + exit 0
 *   hang-1                                 → never exits (timeout path)
 *   flood-1                                → > stdout cap, then exit 0
 * It never writes a file anywhere.
 */
const FAKE_ENTRY_JS = `
const args = process.argv.slice(2);
if (args[0] !== "artifact" || args[1] !== "inspect") {
  process.stderr.write("[run-analysis] invalid command\\n");
  process.exit(2);
}
const kind = args[2];
const id = args[3];
const cwdIdx = args.indexOf("--cwd");
const root = cwdIdx === -1 ? null : args[cwdIdx + 1];
function result(state, extra) {
  return Object.assign({
    ok: state === "current",
    state,
    kind,
    source_id: id,
    artifact_ref: state === "missing" ? null : ".guild/analysis/runs/" + id + "/analysis.json",
    schema_version: state === "missing" ? null : "guild.run_analysis.v1",
    source_analysis_id: state === "missing" ? null : "an-" + id,
    source_hash: state === "missing" ? null : "a".repeat(64),
    current_source_hash: state === "missing" ? null : (state === "stale" ? "b".repeat(64) : "a".repeat(64)),
    input_hash: state === "missing" ? null : "c".repeat(64),
    current_input_hash: state === "missing" ? null : (state === "stale" ? "d".repeat(64) : "c".repeat(64)),
    eligible: state === "current",
    reason: state === "current" ? null : state + "_reason",
  }, extra || {});
}
if (id === "orphan-1") {
  // Spawn a long-lived grandchild that INHERITS our stdout/stderr pipes,
  // then exit. The inherited pipe ends would hold the transport's close
  // event open without its independent settlement bound.
  const cp = require("node:child_process");
  cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", process.stdout, process.stderr],
    detached: false,
  });
  setTimeout(() => process.exit(0), 50);
} else if (id === "refuse-1") {
  process.stderr.write("[run-analysis] refused: unsafe or malformed input\\n");
  process.exit(1);
}
if (id === "badjson-1") { process.stdout.write("definitely not json"); process.exit(0); }
if (id === "badfields-1") { process.stdout.write(JSON.stringify({ state: "current" })); process.exit(0); }
if (id === "hang-1") { setInterval(() => {}, 1000); }
else if (id === "flood-1") {
  // Stream past the 1 MiB stdout cap, IGNORE SIGTERM, and stay alive: the
  // transport's overflow guard must escalate to SIGKILL within the 2s grace
  // (process.exit here would truncate buffered pipe data before the cap is
  // observed).
  process.on("SIGTERM", () => {});
  const chunk = "x".repeat(65536);
  let i = 0;
  const pump = () => {
    while (i < 64) { i++; if (!process.stdout.write(chunk)) { process.stdout.once("drain", pump); return; } }
  };
  pump();
  setInterval(() => {}, 1000);
} else if (id === "cur-1") { process.stdout.write(JSON.stringify(result("current"))); process.exit(0); }
else if (id === "stale-1") { process.stdout.write(JSON.stringify(result("stale"))); process.exit(0); }
else if (id === "missing-1") { process.stdout.write(JSON.stringify(result("missing"))); process.exit(0); }
else if (id === "unsup-1") { process.stdout.write(JSON.stringify(result("unsupported"))); process.exit(0); }
else if (id === "env-1") {
  // Reports whether a NODE_OPTIONS preload leaked into this child: the
  // sentinel global would be set by an inherited --require hook.
  process.stdout.write(JSON.stringify(result(globalThis.__preload_leak ? "stale" : "current")));
  process.exit(0);
}
else if (id !== "hang-1") {
  process.stderr.write("[run-analysis] unknown fixture id: " + id + "\\n");
  process.exit(1);
}
`;

interface PackageOverrides {
  manifest?: Record<string, unknown>;
  inventory?: Record<string, unknown>;
  entryJs?: string;
  skipEntry?: boolean;
  skipManifest?: boolean;
  skipInventory?: boolean;
}

function makePackage(dir: string, overrides: PackageOverrides = {}): string {
  const manifest = {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: "synthetic packaged plugin fixture",
    ...overrides.manifest,
  };
  const inventory = {
    schema_version: SUPPORTED_INVENTORY_SCHEMA,
    plugin_version: manifest.version,
    manifest: { name: manifest.name, version: manifest.version },
    scripts: [{ id: "run-analysis", source_path: "scripts/run-analysis.ts", kind: "cli" }],
    ...overrides.inventory,
  };
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "runtime", "scripts"), { recursive: true });
  if (!overrides.skipManifest) {
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2));
  }
  if (!overrides.skipInventory) {
    writeFileSync(join(dir, "guild.inventory.json"), JSON.stringify(inventory, null, 2));
  }
  if (!overrides.skipEntry) {
    writeFileSync(join(dir, RUN_ANALYSIS_ENTRY), overrides.entryJs ?? FAKE_ENTRY_JS);
  }
  return dir;
}

function listRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    out.push(join(String(entry.parentPath ?? dir), entry.name));
  }
  return out.sort();
}

let scratch: string;
let packageRoot: string;
let runtime: PackagedRuntime;
let canonicalRoot: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "d00-analysis-"));
  // D00-AC3: both the package root and the canonical root carry spaces.
  packageRoot = makePackage(join(scratch, "pkg with spaces"));
  canonicalRoot = join(scratch, "project root with spaces");
  mkdirSync(join(canonicalRoot, ".guild"), { recursive: true });
  runtime = resolvePackagedRuntime(packageRoot);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

// ---- startup validation -----------------------------------------------------

describe("resolvePackagedRuntime", () => {
  it("resolves a valid package (path with spaces) into an immutable descriptor", () => {
    expect(runtime.packageRoot).toContain("pkg with spaces");
    expect(runtime.entryPath).toBe(join(runtime.packageRoot, RUN_ANALYSIS_ENTRY));
    const expectedSha = createHash("sha256")
      .update(readFileSync(runtime.entryPath))
      .digest("hex");
    expect(runtime.entrySha256).toBe(expectedSha);
    expect(runtime.pluginName).toBe(PLUGIN_NAME);
    expect(runtime.pluginVersion).toBe(PLUGIN_VERSION);
    expect(runtime.nodeVersion).toBe(process.version);
    expect(Object.isFrozen(runtime)).toBe(true);
  });

  it("refuses a relative flag value", () => {
    expect(() => resolvePackagedRuntime("relative/pkg")).toThrowError(
      /flag_not_absolute/,
    );
  });

  it("refuses a nonexistent directory", () => {
    expect(() => resolvePackagedRuntime(join(scratch, "nope"))).toThrowError(
      /package_root_missing/,
    );
  });

  it("refuses a package root that is a regular file", () => {
    const filePath = join(scratch, "a-file");
    writeFileSync(filePath, "x");
    expect(() => resolvePackagedRuntime(filePath)).toThrowError(
      /package_root_not_directory/,
    );
  });

  it("refuses when manifest / inventory / entry are missing (distinct errors)", () => {
    const noManifest = makePackage(join(scratch, "no-manifest"), { skipManifest: true });
    expect(() => resolvePackagedRuntime(noManifest)).toThrowError(/required_file_missing.*plugin\.json/s);
    const noInventory = makePackage(join(scratch, "no-inventory"), { skipInventory: true });
    expect(() => resolvePackagedRuntime(noInventory)).toThrowError(/required_file_missing.*guild\.inventory\.json/s);
    const noEntry = makePackage(join(scratch, "no-entry"), { skipEntry: true });
    expect(() => resolvePackagedRuntime(noEntry)).toThrowError(/required_file_missing.*run-analysis\.js/s);
  });

  it("refuses manifest/inventory identity disagreement", () => {
    const dir = makePackage(join(scratch, "identity-mismatch"), {
      inventory: {
        plugin_version: "3.0.9",
        manifest: { name: PLUGIN_NAME, version: "3.0.9" },
      },
    });
    expect(() => resolvePackagedRuntime(dir)).toThrowError(/identity_mismatch/);
  });

  it("refuses an unsupported inventory wire major", () => {
    const dir = makePackage(join(scratch, "bad-schema"), {
      inventory: { schema_version: "guild.inventory.v2" },
    });
    expect(() => resolvePackagedRuntime(dir)).toThrowError(/unsupported_wire_major/);
  });

  it("refuses an unsupported plugin major", () => {
    const dir = makePackage(join(scratch, "bad-major"), {
      manifest: { version: "4.0.0" },
      inventory: {
        plugin_version: "4.0.0",
        manifest: { name: PLUGIN_NAME, version: "4.0.0" },
      },
    });
    expect(() => resolvePackagedRuntime(dir)).toThrowError(/unsupported_wire_major/);
  });

  it("refuses an inventory that does not declare the run-analysis cli output", () => {
    const dir = makePackage(join(scratch, "undeclared-entry"), {
      inventory: { scripts: [{ id: "other-tool", kind: "cli" }] },
    });
    expect(() => resolvePackagedRuntime(dir)).toThrowError(/entry_not_declared/);
  });

  it("refuses an entry that is a symlink (source/.ts injection path)", () => {
    const dir = makePackage(join(scratch, "symlink-entry"), { skipEntry: true });
    const outside = join(scratch, "outside-source.ts");
    writeFileSync(outside, "export {};");
    symlinkSync(outside, join(dir, RUN_ANALYSIS_ENTRY));
    // lstat sees a symlink at the fixed entry path — refused as not-regular,
    // so a .ts source outside the package can never become the executable.
    expect(() => resolvePackagedRuntime(dir)).toThrowError(/required_file_not_regular/);
  });

  it("refuses a manifest reached through an internal directory symlink (codex F1)", () => {
    const dir = join(scratch, "dir-symlink-manifest");
    mkdirSync(join(dir, "runtime", "scripts"), { recursive: true });
    writeFileSync(join(dir, RUN_ANALYSIS_ENTRY), FAKE_ENTRY_JS);
    writeFileSync(
      join(dir, "guild.inventory.json"),
      JSON.stringify({
        schema_version: SUPPORTED_INVENTORY_SCHEMA,
        plugin_version: PLUGIN_VERSION,
        manifest: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
        scripts: [{ id: "run-analysis", kind: "cli" }],
      }),
    );
    // .claude-plugin is a symlinked DIRECTORY escaping the package root; the
    // leaf plugin.json is a regular file, so only realpath containment
    // catches it.
    const outside = join(scratch, "outside-claude-plugin");
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      join(outside, "plugin.json"),
      JSON.stringify({ name: PLUGIN_NAME, version: PLUGIN_VERSION }),
    );
    symlinkSync(outside, join(dir, ".claude-plugin"));
    expect(() => resolvePackagedRuntime(dir)).toThrowError(/entry_escapes_package/);
  });

  it("accepts a package root reached through one external installer symlink", () => {
    const link = join(scratch, "installer-link");
    symlinkSync(packageRoot, link);
    const viaLink = resolvePackagedRuntime(link);
    // Resolved once to the physical root; identical descriptor.
    expect(viaLink.packageRoot).toBe(runtime.packageRoot);
    expect(viaLink.entrySha256).toBe(runtime.entrySha256);
  });

  it("throws AnalysisPackageError instances carrying the refusal code", () => {
    try {
      resolvePackagedRuntime("not-absolute");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnalysisPackageError);
      expect((err as AnalysisPackageError).code).toBe("flag_not_absolute");
    }
  });
});

// ---- read-only inspect transport --------------------------------------------

describe("inspectArtifact outcomes are distinct (D00-AC2)", () => {
  it("returns unavailable when no runtime is configured", async () => {
    const out = await inspectArtifact(undefined, canonicalRoot, "run", "cur-1");
    expect(out).toEqual({
      ok: false,
      state: "unavailable",
      reason: "analysis_package_unconfigured",
    });
  });

  it("passes current / stale / missing / unsupported producer states through", async () => {
    const current = await inspectArtifact(runtime, canonicalRoot, "run", "cur-1");
    expect(current.ok).toBe(true);
    if (current.ok) {
      expect(current.state).toBe("current");
      expect(current.result.source_id).toBe("cur-1");
      expect(current.result.eligible).toBe(true);
      expect(current.result.source_hash).toBe(current.result.current_source_hash);
    }
    const stale = await inspectArtifact(runtime, canonicalRoot, "run", "stale-1");
    expect(stale.ok && stale.state === "stale").toBe(true);
    const missing = await inspectArtifact(runtime, canonicalRoot, "run", "missing-1");
    expect(missing.ok && missing.state === "missing").toBe(true);
    if (missing.ok) expect(missing.result.artifact_ref).toBeNull();
    const unsup = await inspectArtifact(runtime, canonicalRoot, "comparison", "unsup-1");
    expect(unsup.ok && unsup.state === "unsupported").toBe(true);
    if (unsup.ok) expect(unsup.result.eligible).toBe(false);
  });

  it("maps producer exit 1 to a refused outcome with a stderr excerpt", async () => {
    const out = await inspectArtifact(runtime, canonicalRoot, "run", "refuse-1");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.state).toBe("refused");
      expect(out.stderr_excerpt).toContain("refused");
    }
  });

  it("refuses unsafe IDs locally, without spawning", async () => {
    for (const bad of ["../escape", "..", "a b", "-flag", "x".repeat(129), ""]) {
      const out = await inspectArtifact(runtime, canonicalRoot, "run", bad);
      expect(out).toEqual({ ok: false, state: "refused", reason: "unsafe_id" });
      expect(isSafeAnalysisId(bad)).toBe(false);
    }
  });

  it("refuses a relative or missing canonical root", async () => {
    const rel = await inspectArtifact(runtime, "relative/root", "run", "cur-1");
    expect(!rel.ok && rel.state === "refused").toBe(true);
    const gone = await inspectArtifact(runtime, join(scratch, "no-root"), "run", "cur-1");
    expect(!gone.ok && gone.state === "refused").toBe(true);
  });

  it("never presents malformed producer output as current", async () => {
    const notJson = await inspectArtifact(runtime, canonicalRoot, "run", "badjson-1");
    expect(!notJson.ok && notJson.state === "error").toBe(true);
    if (!notJson.ok) expect(notJson.reason).toContain("producer_result_invalid");
    const badFields = await inspectArtifact(runtime, canonicalRoot, "run", "badfields-1");
    expect(!badFields.ok && badFields.state === "error").toBe(true);
  });

  it("times out a hanging producer only after real child close", async () => {
    const out = await inspectArtifact(runtime, canonicalRoot, "run", "hang-1", {
      timeoutMs: 500,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.state).toBe("error");
      expect(out.reason).toContain("timeout");
    }
  }, 15_000);

  it("aborts on stdout overflow as an output-limit error", async () => {
    expect(32 * 65536).toBeGreaterThan(TRANSPORT_LIMITS.stdout_bytes);
    const out = await inspectArtifact(runtime, canonicalRoot, "run", "flood-1");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.state).toBe("error");
      expect(out.reason).toContain("output_limit");
    }
  }, 15_000);

  it("refuses the spawn when the entry bytes changed after startup validation", async () => {
    const dir = makePackage(join(scratch, "mutating-entry"));
    const rt = resolvePackagedRuntime(dir);
    writeFileSync(join(dir, RUN_ANALYSIS_ENTRY), "process.exit(0);\n");
    const out = await inspectArtifact(rt, canonicalRoot, "run", "cur-1");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.state).toBe("error");
      expect(out.reason).toContain("entry_changed");
    }
  });

  it("kills a SIGTERM-resistant flooding producer within the 2s grace (codex F4)", async () => {
    const started = Date.now();
    const out = await inspectArtifact(runtime, canonicalRoot, "run", "flood-1");
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("output_limit");
    // SIGTERM is ignored by the fixture; close must come from the SIGKILL
    // escalation well before the 120s timeout.
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it("refuses the spawn when the package identity was swapped after startup (codex F2)", async () => {
    const dir = makePackage(join(scratch, "identity-swap"));
    const rt = resolvePackagedRuntime(dir);
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "other-plugin", version: PLUGIN_VERSION }),
    );
    const out = await inspectArtifact(rt, canonicalRoot, "run", "cur-1");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.state).toBe("error");
      expect(out.reason).toContain("entry_changed");
    }
  });

  it("refuses the spawn after ANY post-startup inventory mutation (codex F2 r2)", async () => {
    const mutations: Array<Record<string, unknown>> = [
      // schema/wire swap
      { schema_version: "guild.inventory.v9" },
      // run-analysis declaration removed
      { scripts: [{ id: "other", kind: "cli" }] },
      // inventory.manifest identity renamed
      { manifest: { name: "evil", version: PLUGIN_VERSION } },
    ];
    for (const [i, mutation] of mutations.entries()) {
      const dir = makePackage(join(scratch, `inv-mutation-${i}`));
      const rt = resolvePackagedRuntime(dir);
      writeFileSync(
        join(dir, "guild.inventory.json"),
        JSON.stringify({
          schema_version: SUPPORTED_INVENTORY_SCHEMA,
          plugin_version: PLUGIN_VERSION,
          manifest: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
          scripts: [{ id: "run-analysis", kind: "cli" }],
          ...mutation,
        }),
      );
      const out = await inspectArtifact(rt, canonicalRoot, "run", "cur-1");
      expect(out.ok, `mutation ${i} must refuse`).toBe(false);
      if (!out.ok) {
        expect(out.state).toBe("error");
        expect(out.reason).toContain("entry_changed");
      }
    }
  });

  it("does not inherit NODE_OPTIONS preloads into the producer (security F2)", async () => {
    const preload = join(scratch, "preload-hook.js");
    writeFileSync(preload, "globalThis.__preload_leak = true;\n");
    const prior = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
    try {
      const out = await inspectArtifact(runtime, canonicalRoot, "run", "env-1");
      // env-1 reports "stale" if the preload executed inside the child;
      // the restricted env must keep it "current".
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.state).toBe("current");
    } finally {
      if (prior === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prior;
    }
  });

  it("settles even when a descendant holds the inherited pipes open (security F3)", async () => {
    const started = Date.now();
    const out = await inspectArtifact(runtime, canonicalRoot, "run", "orphan-1", {
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - started;
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.state).toBe("error");
    // 1s timeout + 2s SIGTERM->SIGKILL grace + 2s settlement bound + margin.
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);

  it("creates no files anywhere (read-only transport, D00-AC2)", async () => {
    const rootBefore = listRecursive(canonicalRoot);
    const pkgBefore = listRecursive(packageRoot);
    await inspectArtifact(runtime, canonicalRoot, "run", "cur-1");
    await inspectArtifact(runtime, canonicalRoot, "run", "missing-1");
    await inspectArtifact(runtime, canonicalRoot, "run", "refuse-1");
    expect(listRecursive(canonicalRoot)).toEqual(rootBefore);
    expect(listRecursive(packageRoot)).toEqual(pkgBefore);
  });
});

// ---- real serve entry (D00-AC1 + D00-AC3) -----------------------------------

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
  child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
  return new Promise((res) =>
    child.on("close", (code) => res({ code, stdout, stderr })),
  );
}

function startServe(
  args: string[],
): { child: ChildProcessWithoutNullStreams; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(TSX_BIN, [CLI_PATH, "serve", ...args], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, done: waitForExit(child) };
}

function pickPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function waitForListening(
  child: ChildProcessWithoutNullStreams,
  collected: { text: string },
): Promise<void> {
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`serve did not listen; output:\n${collected.text}`)), 30_000);
    child.stdout.on("data", (b: Buffer) => {
      collected.text += b.toString("utf8");
      if (collected.text.includes("serve: listening")) {
        clearTimeout(timer);
        res();
      }
    });
    child.stderr.on("data", (b: Buffer) => (collected.text += b.toString("utf8")));
    child.on("close", () => {
      clearTimeout(timer);
      rej(new Error(`serve exited early; output:\n${collected.text}`));
    });
  });
}

describe("benchmark serve --guild-plugin-package (real CLI entry)", () => {
  it("boots with a valid package (spaces in path) and reports the enabled bridge", async () => {
    const port = pickPort();
    const collected = { text: "" };
    const child = spawn(
      TSX_BIN,
      [
        CLI_PATH,
        "serve",
        "--port",
        String(port),
        "--runs-dir",
        join(scratch, "serve-runs"),
        "--project-root",
        canonicalRoot,
        "--guild-plugin-package",
        packageRoot,
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await waitForListening(child, collected);
      expect(collected.text).toContain("analysis bridge enabled");
      expect(collected.text).toContain(`${PLUGIN_NAME}@${PLUGIN_VERSION}`);
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => child.on("close", res));
    }
  }, 60_000);

  it("missing flag: serve boots, project reads stay available, analysis routes 503", async () => {
    const port = pickPort();
    const collected = { text: "" };
    const child = spawn(
      TSX_BIN,
      [
        CLI_PATH,
        "serve",
        "--port",
        String(port),
        "--runs-dir",
        join(scratch, "serve-runs-2"),
        "--project-root",
        canonicalRoot,
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await waitForListening(child, collected);
      expect(collected.text).toContain("guild-plugin-package: <not set>");
      const analysisRes = await fetch(
        `http://127.0.0.1:${port}/api/project/analysis/artifacts`,
      );
      expect(analysisRes.status).toBe(503);
      const body = (await analysisRes.json()) as { error: string };
      expect(body.error).toBe("analysis_package_unconfigured");
      // Unrelated dashboard reads keep working.
      const runsRes = await fetch(`http://127.0.0.1:${port}/api/runs`);
      expect(runsRes.status).toBe(200);
      const overviewRes = await fetch(`http://127.0.0.1:${port}/api/project/overview`);
      expect(overviewRes.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((res) => child.on("close", res));
    }
  }, 60_000);

  it("explicit invalid package refuses startup before listen", async () => {
    const badDir = makePackage(join(scratch, "serve-bad-pkg"), {
      inventory: { schema_version: "guild.inventory.v9" },
    });
    const { done } = startServe([
      "--port",
      String(pickPort()),
      "--guild-plugin-package",
      badDir,
    ]);
    const r = await done;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unsupported_wire_major");
    expect(r.stdout).not.toContain("serve: listening");
  }, 60_000);

  it("relative flag refuses startup (no sibling/source path inference)", async () => {
    const { done } = startServe([
      "--port",
      String(pickPort()),
      "--guild-plugin-package",
      "some/relative/path",
    ]);
    const r = await done;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("flag_not_absolute");
  }, 60_000);

  it("a package whose entry is an injected symlinked .ts source refuses startup", async () => {
    const dir = makePackage(join(scratch, "serve-ts-entry"), { skipEntry: true });
    const outside = join(scratch, "serve-outside.ts");
    writeFileSync(outside, "export {};");
    symlinkSync(outside, join(dir, RUN_ANALYSIS_ENTRY));
    const { done } = startServe([
      "--port",
      String(pickPort()),
      "--guild-plugin-package",
      dir,
    ]);
    const r = await done;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("required_file_not_regular");
  }, 60_000);

  it("bare --guild-plugin-package without a value refuses startup", () => {
    const r = spawnSync(TSX_BIN, [CLI_PATH, "serve", "--guild-plugin-package"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--guild-plugin-package requires an absolute");
  });
});
