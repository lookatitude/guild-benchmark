// knowledge-generations.ts — P07 read-only view of C13 knowledge publications.
//
// Reads what the plugin's K03 publisher leaves under each source's
// `.guild/indexes/publication/` (successor chain + generations/<hex>/
// publication.json) and the K04 candidate manifest. It never writes, never
// imports plugin source, and never fills a gap: a channel the record does not
// carry is listed unpublished, a null cause or time stays null, and a record
// that fails its pointer hash or the C13 shape reports no channel state.

import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveGuildSources } from "./project-reader.js";
import { readContainedRegularFile } from "./safe-read.js";
import type {
  KnowledgeCandidatesView,
  KnowledgeChannelName,
  KnowledgeChannelView,
  KnowledgeEntityRef,
  KnowledgeGenerationSource,
  KnowledgeGenerationView,
  KnowledgeGenerationsResponse,
  KnowledgeLayerResponse,
} from "./types.js";

export const C13_SCHEMA = "guild.stack.knowledge-publication.v1";
export const POINTER_SCHEMA = "guild.knowledge_publication_pointer.v1";
export const CANDIDATES_SCHEMA = "guild.decision_candidates.v1";
export const CHANNELS: readonly KnowledgeChannelName[] = ["structural_graph", "semantic_graph", "recall", "wiki", "project_memory"];
const STATES = new Set(["current_for_basis", "pending", "stale", "unknown"]);
const CANDIDATE_STATES = new Set(["pending_human_ingest", "missing"]);

export const HISTORY_LIMIT = 20;
const CHAIN_STEP_LIMIT = 10_000;
const POINTER_MAX_BYTES = 4 * 1024;
const RECORD_MAX_BYTES = 1024 * 1024;
const CANDIDATES_MAX_BYTES = 2 * 1024 * 1024;

const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface Pointer {
  generation: string;
  publication_sha256: string;
}

class ReadError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isHash = (v: unknown): v is string => typeof v === "string" && HASH.test(v);
const REL_PATH = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[\\%\x00-\x1f])[^:]+$/;
const AVAILABILITY = new Set(["available", "expired", "redacted", "missing", "unsupported"]);
const KINDS = new Set(["initiative", "run", "execution", "host_session", "goal", "logical_task", "task_attempt", "agent_instance", "request", "operation", "decision", "workflow", "component", "invocation", "obligation", "memory", "knowledge", "candidate", "agent", "skill", "tool", "team", "loop", "config", "evaluation", "report", "benchmark_case", "transfer", "query"]);
const RECORD_KEYS = ["schema_version", "source_id", "source_worktree_id", "durable_owner_source_id", "publication_scope_source_id", "basis", "source_basis_hash", "basis_verified_at", "generation", "previous_generation", "destination_layer_digest", "manifest", "channels", "decision_refs", "replan_required"];
const BASIS_KEYS = ["commit", "tree", "dirty_blob_manifest", "file_inventory", "resolver_policy", "scan_policy", "source_worktree_id"];
const CHANNEL_KEYS = ["channel", "state", "basis_hash", "layer_hash", "output", "reason"];
const EVIDENCE_KEYS = ["source_id", "path", "sha256", "schema_version", "observed_at", "availability", "reason"];
const ENTITY_KEYS = ["source_id", "kind", "id", "revision"];
/** Exactly the required keys: C13 objects are closed (additionalProperties: false). */
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.prototype.hasOwnProperty.call(o, x));
};
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= 4096;
const isTime = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
const isNullableText = (v: unknown) => v === null || isText(v);

function isEvidence(v: unknown): v is Record<string, unknown> {
  return (
    isObj(v) &&
    exactKeys(v, EVIDENCE_KEYS) &&
    isId(v.source_id) &&
    typeof v.path === "string" &&
    v.path.length <= 1024 &&
    REL_PATH.test(v.path) &&
    isHash(v.sha256) &&
    isText(v.schema_version) &&
    isTime(v.observed_at) &&
    AVAILABILITY.has(v.availability as string) &&
    isNullableText(v.reason)
  );
}
const hex = (g: string) => g.slice("sha256:".length);

/** realpath(path) must equal the lexical path under the source's realpath: no symlinked hop to another root. */
function ownedDir(realRoot: string, ...segments: string[]): string | "outside" | undefined {
  const lexical = join(realRoot, ...segments);
  if (!existsSync(lexical)) return undefined;
  try {
    return realpathSync(lexical) === lexical ? lexical : "outside";
  } catch {
    return undefined;
  }
}

async function readPointer(file: string, containRoot: string): Promise<Pointer> {
  const read = await readContainedRegularFile(file, POINTER_MAX_BYTES, containRoot);
  if (!read) throw new ReadError(`pointer ${file.slice(containRoot.length + 1)} is unreadable or refused`);
  let p: unknown;
  try {
    p = JSON.parse(read.text);
  } catch {
    throw new ReadError("pointer is not JSON");
  }
  if (!isObj(p) || p.schema_version !== POINTER_SCHEMA || !isHash(p.generation) || !isHash(p.publication_sha256)) {
    throw new ReadError("pointer is malformed");
  }
  return { generation: p.generation, publication_sha256: p.publication_sha256 };
}

function entity(v: unknown): KnowledgeEntityRef | undefined {
  if (!isObj(v) || !exactKeys(v, ENTITY_KEYS) || !isId(v.source_id) || !KINDS.has(v.kind as string) || !isId(v.id) || !isHash(v.revision)) return undefined;
  return { source_id: v.source_id, kind: v.kind as string, id: v.id, revision: v.revision };
}

function entities(v: unknown): KnowledgeEntityRef[] | undefined {
  if (!Array.isArray(v) || v.length > 100) return undefined;
  const out = v.map(entity);
  return out.every((e) => e !== undefined) ? (out as KnowledgeEntityRef[]) : undefined;
}

function blank(generation: string, status: KnowledgeGenerationView["status"], reason: string): KnowledgeGenerationView {
  return {
    generation,
    status,
    reason,
    previous_generation: null,
    source_id: null,
    source_worktree_id: null,
    durable_owner_source_id: null,
    publication_scope_source_id: null,
    basis_commit: null,
    basis_tree: null,
    source_basis_hash: null,
    basis_verified_at: null,
    channels: [],
    unpublished_channels: [],
    decision_refs: [],
    replan_required: [],
  };
}

/** Map a parsed record to a view, or name the first C13 field it violates. */
function toView(rec: unknown, generation: string): KnowledgeGenerationView | string {
  if (!isObj(rec)) return "record is not an object";
  if (!exactKeys(rec, RECORD_KEYS)) return "top-level keys";
  if (rec.schema_version !== C13_SCHEMA) return "schema_version";
  for (const k of ["source_id", "source_worktree_id", "durable_owner_source_id", "publication_scope_source_id"] as const) {
    if (!isId(rec[k])) return k;
  }
  const basis = rec.basis;
  if (
    !isObj(basis) ||
    !exactKeys(basis, BASIS_KEYS) ||
    !isId(basis.source_worktree_id) ||
    !isNullableText(basis.commit) ||
    !["tree", "dirty_blob_manifest", "file_inventory", "resolver_policy", "scan_policy"].every((k) => isHash(basis[k]))
  ) {
    return "basis";
  }
  if (!isHash(rec.source_basis_hash)) return "source_basis_hash";
  if (!(rec.basis_verified_at === null || isTime(rec.basis_verified_at))) return "basis_verified_at";
  if (!isHash(rec.generation)) return "generation";
  if (!(rec.previous_generation === null || isHash(rec.previous_generation))) return "previous_generation";
  if (!isHash(rec.destination_layer_digest)) return "destination_layer_digest";
  if (!isEvidence(rec.manifest)) return "manifest";
  if (!Array.isArray(rec.channels) || rec.channels.length < 1 || rec.channels.length > 5) return "channels";
  const channels: KnowledgeChannelView[] = [];
  for (const c of rec.channels) {
    if (!isObj(c) || !exactKeys(c, CHANNEL_KEYS) || !CHANNELS.includes(c.channel as KnowledgeChannelName) || !STATES.has(c.state as string)) {
      return "channels[].channel/state";
    }
    if (!isHash(c.basis_hash) || !isHash(c.layer_hash) || !(c.reason === null || isText(c.reason))) return "channels[].hash/reason";
    if (channels.some((x) => x.channel === c.channel)) return "channels[] duplicate channel";
    const out = c.output;
    if (!(out === null || isEvidence(out))) {
      return "channels[].output";
    }
    channels.push({
      channel: c.channel as KnowledgeChannelName,
      state: c.state as KnowledgeChannelView["state"],
      reason: c.reason as string | null,
      basis_hash: c.basis_hash,
      layer_hash: c.layer_hash,
      basis_matches: c.basis_hash === rec.source_basis_hash,
      observed_at: out ? (out.observed_at as string) : null,
      output_path: out ? (out.path as string) : null,
      output_sha256: out ? (out.sha256 as string) : null,
      output_availability: out ? (out.availability as string) : null,
    });
  }
  const decisionRefs = entities(rec.decision_refs);
  if (!decisionRefs) return "decision_refs";
  const replan = entities(rec.replan_required);
  if (!replan) return "replan_required";

  const view: KnowledgeGenerationView = {
    generation,
    status: "verified",
    reason: null,
    previous_generation: rec.previous_generation as string | null,
    source_id: rec.source_id as string,
    source_worktree_id: rec.source_worktree_id as string,
    durable_owner_source_id: rec.durable_owner_source_id as string,
    publication_scope_source_id: rec.publication_scope_source_id as string,
    basis_commit: basis.commit as string | null,
    basis_tree: basis.tree as string,
    source_basis_hash: rec.source_basis_hash,
    basis_verified_at: rec.basis_verified_at as string | null,
    channels,
    unpublished_channels: CHANNELS.filter((n) => !channels.some((c) => c.channel === n)),
    decision_refs: decisionRefs,
    replan_required: replan,
  };
  // Foreign worktree or foreign source output: identity is withheld with the state.
  if (basis.source_worktree_id !== rec.source_worktree_id) {
    return { ...blank(generation, "refused", `basis names worktree ${basis.source_worktree_id}, record names ${String(rec.source_worktree_id)}`) };
  }
  const foreign = rec.channels.find((c) => isObj(c) && isObj(c.output) && c.output.source_id !== rec.source_id) as Record<string, unknown> | undefined;
  if (foreign) return { ...blank(generation, "refused", `${String(foreign.channel)} output belongs to another source`) };
  return view;
}

/** Verified generations' manifest hashes and the publication dir, for the layer drilldown. */
interface SourceInternals {
  pub?: string;
  manifests: Map<string, string>;
}

async function loadGeneration(
  pubDir: string,
  ptr: Pointer,
  expectedPrevious: string | null | undefined,
  internals: SourceInternals,
): Promise<KnowledgeGenerationView> {
  const file = join(pubDir, "generations", hex(ptr.generation), "publication.json");
  const read = await readContainedRegularFile(file, RECORD_MAX_BYTES, pubDir);
  if (!read) return blank(ptr.generation, "unreadable", "publication.json is missing, oversized, or refused");
  const digest = `sha256:${createHash("sha256").update(read.text, "utf8").digest("hex")}`;
  if (digest !== ptr.publication_sha256) return blank(ptr.generation, "unreadable", "publication.json hash does not match its pointer");
  let rec: unknown;
  try {
    rec = JSON.parse(read.text);
  } catch {
    return blank(ptr.generation, "unreadable", "publication.json is not JSON");
  }
  const view = toView(rec, ptr.generation);
  if (typeof view === "string") return blank(ptr.generation, "unreadable", `record does not match C13 knowledge-publication v1 (${view})`);
  if (view.status !== "verified") return view;
  if (isObj(rec) && rec.generation !== ptr.generation) return blank(ptr.generation, "unreadable", "record names another generation");
  if (expectedPrevious !== undefined && view.previous_generation !== expectedPrevious) {
    return blank(ptr.generation, "unreadable", "previous_generation disagrees with the successor chain");
  }
  internals.manifests.set(ptr.generation, ((rec as Record<string, unknown>).manifest as Record<string, string>).sha256!);
  return view;
}

async function readCandidates(realRoot: string): Promise<KnowledgeCandidatesView | null> {
  const guild = ownedDir(realRoot, ".guild");
  const fail = (reason: string): KnowledgeCandidatesView => ({
    status: "unreadable",
    reason,
    owner_source_id: null,
    autopromote: null,
    generated_at: null,
    entries: [],
  });
  if (guild === undefined) return null;
  if (guild === "outside") return fail(".guild resolves outside this source root");
  const file = join(guild, "knowledge", "candidates", "manifest.json");
  if (!existsSync(file)) return null;
  const read = await readContainedRegularFile(file, CANDIDATES_MAX_BYTES, guild);
  if (!read) return fail("candidate manifest is oversized or refused");
  let m: unknown;
  try {
    m = JSON.parse(read.text);
  } catch {
    return fail("candidate manifest is not JSON");
  }
  if (!isObj(m) || m.schema_version !== CANDIDATES_SCHEMA || !Array.isArray(m.candidates)) return fail(`candidate manifest is not ${CANDIDATES_SCHEMA}`);
  const entries: KnowledgeCandidatesView["entries"] = [];
  for (const c of m.candidates) {
    const cand = isObj(c) ? entity(c.candidate) : undefined;
    if (
      !isObj(c) ||
      !cand ||
      cand.kind !== "candidate" ||
      typeof c.path !== "string" ||
      !REL_PATH.test(c.path) ||
      !CANDIDATE_STATES.has(c.state as string) ||
      !(c.decision_id === null || isId(c.decision_id)) ||
      !Array.isArray(c.conflicts) ||
      !c.conflicts.every((x) => entity(x) !== undefined)
    ) {
      return fail("candidate manifest has a malformed entry");
    }
    entries.push({
      path: c.path,
      state: c.state as string,
      decision_id: c.decision_id as string | null,
      candidate_id: cand.id,
      candidate_revision: cand.revision,
      conflict_count: c.conflicts.length,
    });
  }
  return {
    status: "read",
    reason: null,
    owner_source_id: typeof m.owner_source_id === "string" ? m.owner_source_id : null,
    autopromote: typeof m.autopromote === "boolean" ? m.autopromote : null,
    generated_at: typeof m.generated_at === "string" ? m.generated_at : null,
    entries,
  };
}

async function readSource(name: string, root: string, internals: SourceInternals = { manifests: new Map() }): Promise<KnowledgeGenerationSource> {
  const base = { source_guild: name, tip: null, generations: [], history_truncated: false };
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return { ...base, status: "none", reason: "source root does not exist", candidates: null };
  }
  const candidates = await readCandidates(realRoot);
  const indexes = ownedDir(realRoot, ".guild", "indexes");
  const pub = indexes === "outside" ? "outside" : indexes ? ownedDir(realRoot, ".guild", "indexes", "publication") : undefined;
  if (pub === "outside") {
    return { ...base, status: "unreadable", reason: "publication directory resolves outside this source root", candidates };
  }
  if (pub === undefined) {
    return { ...base, status: "none", reason: "no knowledge publication under .guild/indexes/publication", candidates };
  }

  internals.pub = pub;
  try {
    // The successor chain is the commit record; CURRENT is only a hint and is
    // used as the start when the root link is absent.
    const rootLink = join(pub, "successors", "root");
    const current = join(pub, "CURRENT");
    let ptr: Pointer | undefined = existsSync(rootLink)
      ? await readPointer(rootLink, pub)
      : existsSync(current)
        ? await readPointer(current, pub)
        : undefined;
    if (!ptr) return { ...base, status: "none", reason: "publication directory has no generation pointer", candidates };
    const startsAtRoot = existsSync(rootLink);
    const chain: Pointer[] = [ptr];
    let truncated = false;
    for (let i = 0; ; i++) {
      if (i >= CHAIN_STEP_LIMIT) throw new ReadError("successor chain does not terminate");
      const next = join(pub, "successors", hex(ptr.generation));
      if (!existsSync(next)) break;
      ptr = await readPointer(next, pub);
      chain.push(ptr);
      if (chain.length > HISTORY_LIMIT) {
        chain.shift();
        truncated = true;
      }
    }
    const newestFirst = chain.reverse();
    const generations: KnowledgeGenerationView[] = [];
    for (let i = 0; i < newestFirst.length; i++) {
      const older = newestFirst[i + 1];
      // The oldest kept pointer's predecessor is only known when the walk began at root.
      const expected = older ? older.generation : startsAtRoot && !truncated ? null : undefined;
      generations.push(await loadGeneration(pub, newestFirst[i]!, expected, internals));
    }
    const tip = generations[0]!;
    return {
      source_guild: name,
      status: tip.status === "verified" ? "published" : "unreadable",
      reason: tip.status === "verified" ? null : tip.reason,
      tip: tip.generation,
      generations,
      history_truncated: truncated,
      candidates,
    };
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    return { ...base, status: "unreadable", reason: err.message, candidates };
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Sources to read: the resolver's sources whose realpath stays inside the
 * project (a symlinked child naming another root is refused, not adopted),
 * plus the workspace root when it holds publications or candidates but no
 * other content the resolver counts.
 */
async function knowledgeSources(projectRoot: string): Promise<Array<{ name: string; root: string; refused?: string }>> {
  const root = resolve(projectRoot);
  const realProject = realpathSync(root);
  const sources = (await resolveGuildSources(root)).map((s) => ({ name: s.name, root: s.root }));
  if (!sources.some((s) => resolve(s.root) === root)) {
    const hasKnowledge =
      existsSync(join(root, ".guild", "indexes", "publication")) || existsSync(join(root, ".guild", "knowledge", "candidates", "manifest.json"));
    if (hasKnowledge) sources.unshift({ name: "workspace", root });
  }
  const counts = new Map<string, number>();
  for (const s of sources) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return sources.map((s) => {
    if (counts.get(s.name)! > 1) return { ...s, refused: `source name ${s.name} is ambiguous (${counts.get(s.name)} sources share it)` };
    let real: string | undefined;
    try {
      real = realpathSync(s.root);
    } catch {
      real = undefined;
    }
    // The realpath must be the lexical location re-rooted at the canonical
    // project root: any symlink hop below it (to another root or a sibling) is refused.
    const expected = join(realProject, relative(root, resolve(s.root)));
    if (real !== undefined && !isInside(realProject, real)) return { ...s, refused: "source root resolves outside the project root" };
    if (real !== undefined && real !== expected) return { ...s, refused: "source root is reached through a symlink" };
    return s;
  });
}

export async function readKnowledgeGenerations(projectRoot: string): Promise<KnowledgeGenerationsResponse> {
  const out: KnowledgeGenerationSource[] = [];
  for (const s of await knowledgeSources(projectRoot)) {
    out.push(
      s.refused
        ? { source_guild: s.name, status: "unreadable", reason: s.refused, tip: null, generations: [], history_truncated: false, candidates: null }
        : await readSource(s.name, s.root),
    );
  }
  return { sources: out };
}

const LAYER_CHANNELS = new Set<KnowledgeChannelName>(["structural_graph", "semantic_graph", "recall"]);
const ARTIFACT_NAME = /^[a-z0-9][a-z0-9._-]{0,127}\.json$/;
const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;

export class LayerRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

/**
 * Drilldown for one channel of ONE selected generation: the layer's artifact,
 * verified against the generation manifest, summarised by its top-level shape.
 * Counts are array lengths actually present; nothing is counted otherwise.
 */
export async function readKnowledgeLayer(
  projectRoot: string,
  guild: string,
  generation: string,
  channel: string,
): Promise<KnowledgeLayerResponse> {
  if (!isHash(generation)) throw new LayerRequestError("generation must be a sha256 hash", 400);
  if (!LAYER_CHANNELS.has(channel as KnowledgeChannelName)) throw new LayerRequestError("channel must be structural_graph, semantic_graph, or recall", 400);
  const source = (await knowledgeSources(projectRoot)).find((s) => s.name === guild);
  if (!source || source.refused) throw new LayerRequestError(`unknown source ${guild}`, 404);
  const internals: SourceInternals = { manifests: new Map() };
  const view = await readSource(source.name, source.root, internals);
  const base: KnowledgeLayerResponse = {
    source_guild: guild,
    generation,
    channel: channel as KnowledgeChannelName,
    status: "unreadable",
    reason: null,
    artifact: null,
    bytes: null,
    sha256: null,
    layer_hash: null,
    basis_hash: null,
    unknown_reason: null,
    top_level: [],
  };
  const g = view.generations.find((x) => x.generation === generation);
  if (!g) throw new LayerRequestError(`generation ${generation} is not in the listed history of ${guild}`, 404);
  const manifestSha = internals.manifests.get(generation);
  if (g.status !== "verified" || !manifestSha || !internals.pub) return { ...base, reason: g.reason ?? "generation is not verified" };
  const dir = join(internals.pub, "generations", hex(generation));
  const manRead = await readContainedRegularFile(join(dir, "manifest.json"), RECORD_MAX_BYTES, internals.pub);
  if (!manRead) return { ...base, reason: "manifest.json is missing, oversized, or refused" };
  if (`sha256:${createHash("sha256").update(manRead.text, "utf8").digest("hex")}` !== manifestSha) {
    return { ...base, reason: "manifest.json hash does not match the record" };
  }
  let man: unknown;
  try {
    man = JSON.parse(manRead.text);
  } catch {
    return { ...base, reason: "manifest.json is not JSON" };
  }
  if (!isObj(man) || man.generation !== generation || !isObj(man.layers) || !isObj(man.artifacts)) return { ...base, reason: "manifest.json is malformed" };
  const layer = man.layers[channel];
  if (layer === undefined) return { ...base, status: "not_in_generation", reason: `${channel} has no layer in this generation` };
  if (!isObj(layer) || typeof layer.artifact !== "string" || !ARTIFACT_NAME.test(layer.artifact) || !isHash(layer.layer_hash) || !isHash(layer.basis_hash)) {
    return { ...base, reason: "manifest layer entry is malformed" };
  }
  const recorded = g.channels.find((c) => c.channel === channel);
  if (!recorded) return { ...base, reason: `the publication record carries no ${channel} channel but the manifest has a layer` };
  if (recorded.layer_hash !== layer.layer_hash || recorded.basis_hash !== layer.basis_hash) {
    return { ...base, reason: "manifest layer hashes disagree with the publication record" };
  }
  const art = man.artifacts[layer.artifact];
  if (!isObj(art) || !isHash(art.sha256)) return { ...base, reason: `artifact ${layer.artifact} is not in the manifest` };
  // K03 records the layer artifact itself as the channel output evidence.
  const outPath = recorded.output_path;
  if (!outPath || recorded.output_sha256 !== art.sha256 || !outPath.endsWith(`publication/generations/${hex(generation)}/${layer.artifact}`)) {
    return { ...base, reason: "channel output evidence does not name this generation's layer artifact" };
  }
  const read = await readContainedRegularFile(join(dir, layer.artifact), ARTIFACT_MAX_BYTES, internals.pub);
  const ident = {
    artifact: layer.artifact,
    layer_hash: layer.layer_hash,
    basis_hash: layer.basis_hash,
    unknown_reason: typeof layer.unknown_reason === "string" ? layer.unknown_reason : null,
  };
  if (!read) return { ...base, ...ident, reason: "artifact is missing, oversized, or refused" };
  const digest = `sha256:${createHash("sha256").update(read.text, "utf8").digest("hex")}`;
  if (digest !== art.sha256) return { ...base, ...ident, reason: "artifact hash does not match the manifest" };
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return { ...base, ...ident, reason: "artifact is not JSON" };
  }
  const top_level = isObj(body)
    ? Object.entries(body)
        .slice(0, 50)
        .map(([key, v]) => ({
          key,
          kind: Array.isArray(v) ? ("array" as const) : v === null ? ("null" as const) : (typeof v as KnowledgeLayerResponse["top_level"][number]["kind"]),
          length: Array.isArray(v) ? v.length : null,
        }))
    : [];
  return { ...base, ...ident, status: "verified", bytes: Buffer.byteLength(read.text, "utf8"), sha256: digest, top_level };
}
