// D00 — packaged producer configuration + shared read-only inspect transport
// (C-JOBS §startup/§transport, C-CLI §inspect). The benchmark NEVER imports
// plugin source and NEVER computes canonical findings: it validates one
// operator-selected packaged plugin at startup, then invokes its compiled
// run-analysis entry through a bounded shell:false child process and passes
// producer states through. Unconfigured/failed transport yields
// unavailable/error — never `current`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

// ---- startup validation ---------------------------------------------------

/** Wire majors this benchmark build can consume (C-JOBS: "validate supported
 * package/core wire major before enabling bridge"). */
export const SUPPORTED_INVENTORY_SCHEMA = "guild.inventory.v1";
export const SUPPORTED_PLUGIN_MAJOR = 3;

/** Fixed compiled entry inside the package (C-CLI §runtime). A TypeScript
 * source file is never executable; only this committed .js path is. */
export const RUN_ANALYSIS_ENTRY = join("runtime", "scripts", "run-analysis.js");
const MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const INVENTORY_PATH = "guild.inventory.json";

export type AnalysisPackageErrorCode =
  | "flag_not_absolute"
  | "package_root_missing"
  | "package_root_not_directory"
  | "required_file_missing"
  | "required_file_not_regular"
  | "manifest_invalid"
  | "inventory_invalid"
  | "identity_mismatch"
  | "unsupported_wire_major"
  | "entry_not_declared"
  | "entry_escapes_package"
  | "entry_not_js"
  | "node_unsupported";

export class AnalysisPackageError extends Error {
  readonly code: AnalysisPackageErrorCode;
  constructor(code: AnalysisPackageErrorCode, message: string) {
    super(`analysis package refused (${code}): ${message}`);
    this.code = code;
  }
}

/**
 * Immutable validated runtime descriptor. Resolved ONCE at serve startup from
 * the explicit `--guild-plugin-package` flag; every producer action
 * (inspection now, jobs in D02) goes through this one descriptor. No env
 * override, registry search, sibling/source discovery or auto-compile.
 */
export interface PackagedRuntime {
  /** Physical (realpath) package root; containment is checked against it. */
  readonly packageRoot: string;
  /** Physical path of the compiled run-analysis entry inside packageRoot. */
  readonly entryPath: string;
  /** SHA256 of the entry bytes at resolve time; revalidated before each spawn. */
  readonly entrySha256: string;
  readonly pluginName: string;
  readonly pluginVersion: string;
  /** Fixed Node executable (process.execPath realpath); never a caller value. */
  readonly nodePath: string;
  readonly nodeVersion: string;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireRegularFile(root: string, rel: string): string {
  const abs = join(root, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new AnalysisPackageError(
      "required_file_missing",
      `${rel} not found under ${root}`,
    );
  }
  // lstat: an internal symlink (even one that lands inside the package) is
  // rejected — required files must be contained REGULAR files.
  if (!st.isFile()) {
    throw new AnalysisPackageError(
      "required_file_not_regular",
      `${rel} must be a regular file (symlink/special file rejected)`,
    );
  }
  // The leaf is regular, but an intermediate directory (e.g. .claude-plugin/)
  // could itself be a symlink pointing outside the physical root — realpath
  // resolves the whole chain, so containment is checked on the physical path.
  const phys = realpathSync(abs);
  if (phys !== abs && !isContained(root, phys)) {
    throw new AnalysisPackageError(
      "entry_escapes_package",
      `${rel} resolves outside the package root: ${phys}`,
    );
  }
  return phys;
}

function readJsonObject(
  path: string,
  code: "manifest_invalid" | "inventory_invalid",
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AnalysisPackageError(
      code,
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AnalysisPackageError(code, `${path} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function versionMajor(version: string): number {
  const m = /^(\d+)\./.exec(version);
  return m ? Number.parseInt(m[1], 10) : Number.NaN;
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/**
 * The FULL manifest/inventory validation (containment, JSON shape, supported
 * wire majors, identity agreement, run-analysis cli declaration). Shared by
 * startup resolution AND the pre-spawn revalidation so a post-startup
 * mutation of any validated metadata fact refuses the spawn.
 */
function validatePackageMetadata(packageRoot: string): {
  name: string;
  version: string;
} {
  const manifestPath = requireRegularFile(packageRoot, MANIFEST_PATH);
  const inventoryPath = requireRegularFile(packageRoot, INVENTORY_PATH);

  const manifest = readJsonObject(manifestPath, "manifest_invalid");
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new AnalysisPackageError("manifest_invalid", "manifest name missing");
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new AnalysisPackageError("manifest_invalid", "manifest version missing");
  }

  const inventory = readJsonObject(inventoryPath, "inventory_invalid");
  if (inventory.schema_version !== SUPPORTED_INVENTORY_SCHEMA) {
    throw new AnalysisPackageError(
      "unsupported_wire_major",
      `inventory schema_version ${String(inventory.schema_version)} is not supported (${SUPPORTED_INVENTORY_SCHEMA})`,
    );
  }
  if (typeof inventory.plugin_version !== "string") {
    throw new AnalysisPackageError("inventory_invalid", "inventory plugin_version missing");
  }
  const invManifest = inventory.manifest;
  const invManifestObj =
    invManifest !== null && typeof invManifest === "object" && !Array.isArray(invManifest)
      ? (invManifest as Record<string, unknown>)
      : undefined;
  if (!invManifestObj) {
    throw new AnalysisPackageError("inventory_invalid", "inventory manifest block missing");
  }
  // Manifest and inventory plugin identity/version must agree.
  if (
    invManifestObj.name !== manifest.name ||
    invManifestObj.version !== manifest.version ||
    inventory.plugin_version !== manifest.version
  ) {
    throw new AnalysisPackageError(
      "identity_mismatch",
      `manifest ${manifest.name}@${manifest.version} does not match inventory ` +
        `${String(invManifestObj.name)}@${String(invManifestObj.version)} (plugin_version ${inventory.plugin_version})`,
    );
  }
  if (versionMajor(manifest.version) !== SUPPORTED_PLUGIN_MAJOR) {
    throw new AnalysisPackageError(
      "unsupported_wire_major",
      `plugin major ${manifest.version} is not supported (expected ${SUPPORTED_PLUGIN_MAJOR}.x)`,
    );
  }
  // Inventory must declare the run-analysis compiled output.
  const scripts = Array.isArray(inventory.scripts) ? inventory.scripts : [];
  const declared = scripts.some(
    (s) =>
      s !== null &&
      typeof s === "object" &&
      (s as Record<string, unknown>).id === "run-analysis" &&
      (s as Record<string, unknown>).kind === "cli",
  );
  if (!declared) {
    throw new AnalysisPackageError(
      "entry_not_declared",
      "inventory does not declare the run-analysis cli output",
    );
  }
  return { name: manifest.name, version: manifest.version };
}

/**
 * Resolve + validate the operator-selected packaged plugin ONCE at startup.
 * Throws AnalysisPackageError (serve refuses before listen) on any failure.
 * A package directory reached through an external installer symlink is
 * resolved once; entry/manifest containment is enforced against the physical
 * root from then on.
 */
export function resolvePackagedRuntime(flagValue: string): PackagedRuntime {
  if (!isAbsolute(flagValue)) {
    throw new AnalysisPackageError(
      "flag_not_absolute",
      `--guild-plugin-package must be an absolute directory; got ${flagValue}`,
    );
  }
  let packageRoot: string;
  try {
    packageRoot = realpathSync(flagValue);
  } catch {
    throw new AnalysisPackageError(
      "package_root_missing",
      `directory not found: ${flagValue}`,
    );
  }
  if (!statSync(packageRoot).isDirectory()) {
    throw new AnalysisPackageError(
      "package_root_not_directory",
      `${packageRoot} is not a directory`,
    );
  }

  const { name: pluginName, version: pluginVersion } =
    validatePackageMetadata(packageRoot);
  const entryDeclared = requireRegularFile(packageRoot, RUN_ANALYSIS_ENTRY);

  // Resolve the entry ONCE to its contained real regular path; reject
  // internal symlink escape / special files (requireRegularFile already
  // rejected a symlink at the fixed path, so realpath equals the path —
  // keep the containment check as defence in depth).
  const entryPath = realpathSync(entryDeclared);
  if (!isContained(packageRoot, entryPath)) {
    throw new AnalysisPackageError(
      "entry_escapes_package",
      `entry resolves outside the package root: ${entryPath}`,
    );
  }
  if (!entryPath.endsWith(".js")) {
    throw new AnalysisPackageError(
      "entry_not_js",
      `entry must be a compiled .js file; got ${entryPath}`,
    );
  }

  // Fixed Node executable: process.execPath, Node 18+, never a caller value.
  const nodeVersion = process.version;
  const nodeMajor = Number.parseInt(nodeVersion.replace(/^v/, ""), 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 18) {
    throw new AnalysisPackageError(
      "node_unsupported",
      `Node 18+ required; running ${nodeVersion}`,
    );
  }

  return Object.freeze({
    packageRoot,
    entryPath,
    entrySha256: sha256File(entryPath),
    pluginName,
    pluginVersion,
    nodePath: realpathSync(process.execPath),
    nodeVersion,
  });
}

// ---- read-only inspect transport ------------------------------------------

/** C-JOBS §limits — the transport's hard bounds. */
export const TRANSPORT_LIMITS = Object.freeze({
  timeout_ms: 120_000,
  stdout_bytes: 1_048_576,
  stderr_bytes: 1_048_576,
  cancel_grace_ms: 2_000,
});

export type InspectKind = "run" | "comparison";

/** C-CLI §inspect result fields, validated — never re-derived — here. */
export interface InspectResult {
  ok: boolean;
  state: "current" | "stale" | "missing" | "unsupported";
  kind: InspectKind;
  source_id: string;
  artifact_ref: string | null;
  schema_version: string | null;
  source_analysis_id: string | null;
  source_hash: string | null;
  current_source_hash: string | null;
  input_hash: string | null;
  current_input_hash: string | null;
  eligible: boolean;
  reason: string | null;
}

/**
 * Distinct transport outcomes (D00-AC2): producer states pass through on
 * success; refusals/errors stay distinguishable and are NEVER presented as
 * `current`. `unavailable` is the no-runtime outcome the server maps to
 * 503 analysis_package_unconfigured.
 */
export type InspectOutcome =
  | { ok: true; state: InspectResult["state"]; result: InspectResult }
  | {
      ok: false;
      state: "refused" | "error" | "unavailable";
      reason: string;
      stderr_excerpt?: string;
    };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeAnalysisId(id: string): boolean {
  return SAFE_ID.test(id);
}

export interface InspectOptions {
  /** Test override; clamped to the C-JOBS limit, never above it. */
  timeoutMs?: number;
}

function excerpt(buf: string, max = 512): string {
  return buf.length > max ? `${buf.slice(0, max)}…` : buf;
}

function validateInspectResult(
  raw: unknown,
  kind: InspectKind,
  id: string,
): InspectResult | { invalid: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { invalid: "producer output is not a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const state = obj.state;
  if (
    state !== "current" &&
    state !== "stale" &&
    state !== "missing" &&
    state !== "unsupported"
  ) {
    return { invalid: `unrecognized inspect state on exit 0: ${String(state)}` };
  }
  if (typeof obj.ok !== "boolean") return { invalid: "ok must be boolean" };
  if (obj.kind !== kind) return { invalid: `kind mismatch: ${String(obj.kind)}` };
  if (obj.source_id !== id) {
    return { invalid: `source_id mismatch: ${String(obj.source_id)}` };
  }
  if (typeof obj.eligible !== "boolean") return { invalid: "eligible must be boolean" };
  const nullableString = [
    "artifact_ref",
    "schema_version",
    "source_analysis_id",
    "source_hash",
    "current_source_hash",
    "input_hash",
    "current_input_hash",
    "reason",
  ] as const;
  for (const field of nullableString) {
    const v = obj[field];
    if (v !== null && typeof v !== "string") {
      return { invalid: `${field} must be string or null` };
    }
    if (v === undefined) return { invalid: `${field} missing` };
  }
  return {
    ok: obj.ok,
    state,
    kind,
    source_id: id,
    artifact_ref: obj.artifact_ref as string | null,
    schema_version: obj.schema_version as string | null,
    source_analysis_id: obj.source_analysis_id as string | null,
    source_hash: obj.source_hash as string | null,
    current_source_hash: obj.current_source_hash as string | null,
    input_hash: obj.input_hash as string | null,
    current_input_hash: obj.current_input_hash as string | null,
    eligible: obj.eligible,
    reason: obj.reason as string | null,
  };
}

/** Re-check the resolved package immediately before a spawn: the entry is
 * still the same contained regular file (realpath + SHA256) and the
 * manifest/inventory identity still matches the resolve-time descriptor. A
 * replaced/retargeted entry or a swapped package refuses the spawn instead
 * of executing new bytes. */
function revalidateEntry(runtime: PackagedRuntime): string | null {
  try {
    const st = lstatSync(runtime.entryPath);
    if (!st.isFile()) return "entry is no longer a regular file";
    const phys = realpathSync(runtime.entryPath);
    if (phys !== runtime.entryPath || !isContained(runtime.packageRoot, phys)) {
      return "entry path no longer resolves inside the package root";
    }
    if (sha256File(runtime.entryPath) !== runtime.entrySha256) {
      return "entry bytes changed since startup validation";
    }
    // Package identity re-check: re-run the FULL startup metadata validation
    // (schema/wire major, identity trio, run-analysis declaration) and
    // require the same plugin name/version the operator validated.
    const identity = validatePackageMetadata(runtime.packageRoot);
    if (
      identity.name !== runtime.pluginName ||
      identity.version !== runtime.pluginVersion
    ) {
      return "package identity changed since startup validation";
    }
  } catch {
    return "entry or package identity no longer validates";
  }
  return null;
}

/**
 * Bounded read-only artifact inspection (C-JOBS §transport). Shared by
 * project-reader (D01 freshness) and the HTTP job layer (D02). Spawns
 * `node <entry> artifact inspect <kind> <safe-id> --cwd <canonicalRoot>`
 * with shell:false; parses producer JSON only after terminal success.
 * Creates no files, acquires no lock, has no recommendation authority.
 */
export function inspectArtifact(
  runtime: PackagedRuntime | undefined,
  canonicalRoot: string,
  kind: InspectKind,
  id: string,
  options?: InspectOptions,
): Promise<InspectOutcome> {
  if (!runtime) {
    return Promise.resolve({
      ok: false,
      state: "unavailable",
      reason: "analysis_package_unconfigured",
    });
  }
  if (kind !== "run" && kind !== "comparison") {
    return Promise.resolve({
      ok: false,
      state: "refused",
      reason: `unsupported inspect kind: ${String(kind)}`,
    });
  }
  if (!isSafeAnalysisId(id)) {
    // Refused locally, before any spawn — traversal/flag/oversized IDs never
    // reach the producer argv.
    return Promise.resolve({ ok: false, state: "refused", reason: "unsafe_id" });
  }
  if (!isAbsolute(canonicalRoot)) {
    return Promise.resolve({
      ok: false,
      state: "refused",
      reason: "canonical root must be an absolute server-selected path",
    });
  }
  try {
    if (!statSync(canonicalRoot).isDirectory()) {
      return Promise.resolve({
        ok: false,
        state: "refused",
        reason: "canonical root is not a directory",
      });
    }
  } catch {
    return Promise.resolve({
      ok: false,
      state: "refused",
      reason: "canonical root not found",
    });
  }
  const staleEntry = revalidateEntry(runtime);
  if (staleEntry) {
    return Promise.resolve({
      ok: false,
      state: "error",
      reason: `entry_changed: ${staleEntry}`,
    });
  }

  const timeoutMs = Math.min(
    options?.timeoutMs ?? TRANSPORT_LIMITS.timeout_ms,
    TRANSPORT_LIMITS.timeout_ms,
  );
  const argv = [runtime.entryPath, "artifact", "inspect", kind, id, "--cwd", canonicalRoot];

  // Restricted child environment (security review F2): never inherit
  // NODE_OPTIONS / NODE_* preload hooks — an inherited preload would execute
  // code outside the validated entry. Only benign locale/path basics pass.
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    const v = process.env[key];
    if (v !== undefined) childEnv[key] = v;
  }

  return new Promise<InspectOutcome>((resolveOutcome) => {
    // detached: the child leads its own process group so timeout/overflow
    // kills reach any descendants it spawned (security review F3).
    const child = spawn(runtime.nodePath, argv, {
      shell: false,
      cwd: canonicalRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      detached: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let timedOut = false;
    let settled = false;

    const signalTree = (signal: NodeJS.Signals) => {
      // Negative pid signals the whole process group (detached above);
      // fall back to the direct child if the group is already gone.
      if (typeof child.pid === "number") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* group gone — fall through */
        }
      }
      child.kill(signal);
    };

    const abortChild = () => {
      signalTree("SIGTERM");
      // Escalate after the C-JOBS cancel grace; terminal only on real close.
      setTimeout(() => signalTree("SIGKILL"), TRANSPORT_LIMITS.cancel_grace_ms).unref();
      // Independent settlement bound (security review F3): a descendant that
      // inherited our pipes can hold `close` open past the SIGKILL. Destroy
      // our ends after one further grace so the close event always arrives.
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, TRANSPORT_LIMITS.cancel_grace_ms * 2).unref();
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      abortChild();
    }, timeoutMs);

    // Byte-counted caps (not UTF-16 chars). After overflow the child is
    // killed (with SIGKILL escalation) and further output is DROPPED, so a
    // flooding producer cannot grow server memory past the cap.
    child.stdout.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.byteLength;
      stdoutChunks.push(chunk);
      if (stdoutBytes > TRANSPORT_LIMITS.stdout_bytes) {
        overflowed = true;
        abortChild();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (overflowed) return;
      stderrBytes += chunk.byteLength;
      stderrChunks.push(chunk);
      if (stderrBytes > TRANSPORT_LIMITS.stderr_bytes) {
        overflowed = true;
        abortChild();
      }
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      resolveOutcome({ ok: false, state: "error", reason: `spawn failed: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (timedOut) {
        resolveOutcome({
          ok: false,
          state: "error",
          reason: `timeout after ${timeoutMs}ms (signal ${signal ?? "none"})`,
          stderr_excerpt: excerpt(stderr),
        });
        return;
      }
      if (overflowed) {
        resolveOutcome({
          ok: false,
          state: "error",
          reason: "output_limit exceeded",
          stderr_excerpt: excerpt(stderr),
        });
        return;
      }
      if (code === 1) {
        // C-CLI: refused inputs exit 1 — an operational producer refusal.
        resolveOutcome({
          ok: false,
          state: "refused",
          reason: "producer refused the inspection input",
          stderr_excerpt: excerpt(stderr),
        });
        return;
      }
      if (code !== 0) {
        resolveOutcome({
          ok: false,
          state: "error",
          reason: `producer exited ${code ?? `signal ${signal ?? "unknown"}`}`,
          stderr_excerpt: excerpt(stderr),
        });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolveOutcome({
          ok: false,
          state: "error",
          reason: "producer_result_invalid: stdout is not JSON",
          stderr_excerpt: excerpt(stderr),
        });
        return;
      }
      const validated = validateInspectResult(parsed, kind, id);
      if ("invalid" in validated) {
        resolveOutcome({
          ok: false,
          state: "error",
          reason: `producer_result_invalid: ${validated.invalid}`,
        });
        return;
      }
      resolveOutcome({ ok: true, state: validated.state, result: validated });
    });
  });
}
