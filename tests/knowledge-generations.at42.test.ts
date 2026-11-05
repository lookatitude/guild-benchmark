import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readKnowledgeGenerations, readKnowledgeLayer } from "../src/knowledge-generations.js";
import { createApp } from "../src/server.js";
import type { KnowledgeGenerationsResponse } from "../src/types.js";
import { writeFileDeep } from "./project.helpers.js";
import { req } from "./server.helpers.js";

// AT42 — P07 generation and freshness reader over C13 knowledge publications.
// The base record is the frozen C13 example (contracts/guild-stack/v2
// fixtures/examples.json, sha256 65d31e50…c201), vendored so the suite runs in
// a benchmark-only checkout.
const EXAMPLE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "c13", "knowledge-publication.example.json"), "utf8"),
) as Record<string, unknown> & { channels: Array<Record<string, unknown>> };

const h = (c: string) => `sha256:${c.repeat(64)}`;
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const hex = (g: string) => g.slice("sha256:".length);

type Channel = Record<string, unknown>;

function record(generation: string, previous: string | null, channels: Channel[], extra: Record<string, unknown> = {}) {
  return { ...structuredClone(EXAMPLE), generation, previous_generation: previous, channels, ...extra };
}

function channel(name: string, state: string, reason: string | null, output: unknown = EXAMPLE.channels[0]!.output): Channel {
  return { ...structuredClone(EXAMPLE.channels[0]!), channel: name, state, reason, output };
}

/** Write manifest.json + layer artifacts into a generation and bind the record to the manifest hash. */
async function withLayers(root: string, rec: Record<string, unknown>, layers: Record<string, unknown>, opts: { tamperArtifact?: boolean; layerHash?: string; outputSha?: string; keepOutput?: boolean } = {}) {
  const gen = rec.generation as string;
  const dir = join(root, ".guild", "indexes", "publication", "generations", hex(gen));
  const artifacts: Record<string, { sha256: string; bytes: number }> = {};
  const manLayers: Record<string, unknown> = {};
  for (const [ch, body] of Object.entries(layers)) {
    const name = `${ch.replace(/_/g, "-")}.json`;
    const bytes = JSON.stringify(body);
    artifacts[name] = { sha256: sha(bytes), bytes: bytes.length };
    const rc = (rec.channels as Channel[]).find((c) => c.channel === ch);
    manLayers[ch] = { artifact: name, layer_hash: opts.layerHash ?? rc?.layer_hash ?? h("c"), basis_hash: rc?.basis_hash ?? h("b") };
    await writeFileDeep(join(dir, name), opts.tamperArtifact ? bytes + " " : bytes);
    if (rc && !opts.keepOutput) rc.output = { ...(rc.output as object), path: `indexes/publication/generations/${hex(gen)}/${name}`, sha256: opts.outputSha ?? sha(bytes) };
  }
  const manifest = JSON.stringify({ schema_version: "guild.knowledge_publication_manifest.v1", generation: gen, previous_generation: rec.previous_generation, artifacts, layers: manLayers });
  await writeFileDeep(join(dir, "manifest.json"), manifest);
  (rec.manifest as Record<string, unknown>).sha256 = sha(manifest);
  return rec;
}

/** Write one generation the way K03 lays it out and return its pointer. */
async function publish(root: string, rec: Record<string, unknown>, opts: { current?: boolean; tamper?: boolean } = {}) {
  const pub = join(root, ".guild", "indexes", "publication");
  const bytes = JSON.stringify(rec, null, 2) + "\n";
  const gen = rec.generation as string;
  await writeFileDeep(join(pub, "generations", hex(gen), "publication.json"), opts.tamper ? bytes.replace("lane-a", "lane-x") : bytes);
  const pointer = JSON.stringify({ schema_version: "guild.knowledge_publication_pointer.v1", generation: gen, publication_sha256: sha(bytes) });
  const prev = rec.previous_generation as string | null;
  await writeFileDeep(join(pub, "successors", prev ? hex(prev) : "root"), pointer);
  if (opts.current !== false) await writeFile(join(pub, "CURRENT"), pointer);
  return pointer;
}

describe("AT42 knowledge generations and freshness", () => {
  let root: string;
  let other: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "at42-root-"));
    other = await mkdtemp(join(tmpdir(), "at42-other-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  });

  it("empty: no publication stays empty, with a reason and no channels", async () => {
    const body = await readKnowledgeGenerations(root);
    expect(body.sources).toHaveLength(1);
    const s = body.sources[0]!;
    expect(s.status).toBe("none");
    expect(s.generations).toEqual([]);
    expect(s.tip).toBeNull();
    expect(s.reason).toMatch(/no knowledge publication/);
    expect(s.candidates).toBeNull();
  });

  it("unknown: an unknown channel keeps its cause; a null verification time stays null", async () => {
    await publish(
      root,
      record(h("1"), null, [channel("semantic_graph", "unknown", "wiki inputs are not bound into the source basis", null)], {
        basis_verified_at: null,
      }),
    );
    const s = (await readKnowledgeGenerations(root)).sources[0]!;
    expect(s.status).toBe("published");
    const g = s.generations[0]!;
    expect(g.status).toBe("verified");
    expect(g.basis_verified_at).toBeNull();
    const c = g.channels.find((x) => x.channel === "semantic_graph")!;
    expect(c.state).toBe("unknown");
    expect(c.reason).toBe("wiki inputs are not bound into the source basis");
    expect(c.observed_at).toBeNull();
    expect(c.output_path).toBeNull();
    // Channels absent from the record are reported unpublished, never invented.
    expect(g.unpublished_channels).toEqual(["structural_graph", "recall", "wiki", "project_memory"]);
  });

  it("stale with cause, beside a current canonical write and a pending derived index; decisions propagate", async () => {
    const decision = { source_id: "source-a", kind: "decision", id: "decision:d2", revision: h("d") };
    const plan = { source_id: "source-a", kind: "knowledge", id: "plan:p1", revision: h("e") };
    await publish(
      root,
      record(
        h("2"),
        null,
        [
          channel("wiki", "current_for_basis", null),
          channel("recall", "pending", "recall index rebuild queued"),
          channel("project_memory", "stale", "decision:d1 superseded by decision:d2"),
        ],
        { decision_refs: [decision], replan_required: [plan] },
      ),
    );
    const g = (await readKnowledgeGenerations(root)).sources[0]!.generations[0]!;
    const by = Object.fromEntries(g.channels.map((c) => [c.channel, c]));
    expect(by.wiki!.state).toBe("current_for_basis");
    expect(by.recall!.state).toBe("pending");
    expect(by.project_memory!.state).toBe("stale");
    expect(by.project_memory!.reason).toBe("decision:d1 superseded by decision:d2");
    expect(by.wiki!.observed_at).toBe("2026-10-26T00:00:00Z");
    expect(by.wiki!.basis_matches).toBe(true);
    expect(g.decision_refs).toEqual([decision]);
    expect(g.replan_required).toEqual([plan]);
    expect(g.source_worktree_id).toBe("lane-a");
  });

  it("stale without a recorded cause keeps the cause null rather than inventing one", async () => {
    await publish(root, record(h("3"), null, [channel("structural_graph", "stale", null)]));
    const c = (await readKnowledgeGenerations(root)).sources[0]!.generations[0]!.channels[0]!;
    expect(c.state).toBe("stale");
    expect(c.reason).toBeNull();
  });

  it("follows a lagging CURRENT to the chain tip and lists history newest first", async () => {
    await publish(root, record(h("4"), null, [channel("structural_graph", "current_for_basis", null)]));
    await publish(root, record(h("5"), h("4"), [channel("structural_graph", "stale", "source drift")]), { current: false });
    const s = (await readKnowledgeGenerations(root)).sources[0]!;
    expect(s.tip).toBe(h("5"));
    expect(s.generations.map((g) => g.generation)).toEqual([h("5"), h("4")]);
    expect(s.generations.every((g) => g.status === "verified")).toBe(true);
  });

  it("reads the candidate manifest by reference and keeps missing candidates visible", async () => {
    await publish(root, record(h("6"), null, [channel("wiki", "current_for_basis", null)]));
    await writeFileDeep(
      join(root, ".guild", "knowledge", "candidates", "manifest.json"),
      JSON.stringify({
        schema_version: "guild.decision_candidates.v1",
        owner_source_id: "source-a",
        autopromote: false,
        generated_at: "2026-10-27T00:00:00Z",
        ledger_seq: 3,
        candidates: [
          { candidate: { source_id: "source-a", kind: "candidate", id: "candidate:c1", revision: h("c") }, decision_id: "decision:d3", path: "knowledge/candidates/decisions/c1.md", state: "pending_human_ingest", promotion_gate: "guild:wiki-ingest", conflicts: [{ source_id: "umbrella", kind: "decision", id: "decision:d3", revision: h("f") }], listed_at_seq: 2 },
          { candidate: { source_id: "source-a", kind: "candidate", id: "candidate:c0", revision: h("b") }, decision_id: null, path: "knowledge/candidates/decisions/c0.md", state: "missing", promotion_gate: "guild:wiki-ingest", conflicts: [], listed_at_seq: 1 },
        ],
      }),
    );
    const c = (await readKnowledgeGenerations(root)).sources[0]!.candidates!;
    expect(c.status).toBe("read");
    expect(c.autopromote).toBe(false);
    expect(c.entries.map((e) => [e.path, e.state, e.conflict_count])).toEqual([
      ["knowledge/candidates/decisions/c1.md", "pending_human_ingest", 1],
      ["knowledge/candidates/decisions/c0.md", "missing", 0],
    ]);
  });

  describe("negative controls", () => {
    it("a tampered record is unreadable and reports no channel state", async () => {
      await publish(root, record(h("7"), null, [channel("structural_graph", "current_for_basis", null)]), { tamper: true });
      const s = (await readKnowledgeGenerations(root)).sources[0]!;
      expect(s.status).toBe("unreadable");
      expect(s.generations[0]!.status).toBe("unreadable");
      expect(s.generations[0]!.reason).toMatch(/hash/);
      expect(s.generations[0]!.channels).toEqual([]);
    });

    it("a legacy latest file without a publication is never adopted as a generation", async () => {
      await writeFileDeep(join(root, ".guild", "indexes", "knowledge-graph.json"), JSON.stringify({ nodes: [], edges: [] }));
      const s = (await readKnowledgeGenerations(root)).sources[0]!;
      expect(s.status).toBe("none");
      expect(s.generations).toEqual([]);
    });

    it("a record outside the C13 shape is refused, not coerced", async () => {
      await publish(root, record(h("8"), null, [channel("structural_graph", "fresh", null)]));
      const g = (await readKnowledgeGenerations(root)).sources[0]!.generations[0]!;
      expect(g.status).toBe("unreadable");
      expect(g.reason).toMatch(/C13/);
      expect(g.channels).toEqual([]);
    });

    it("foreign root: a symlinked publication dir pointing at another root is refused", async () => {
      await publish(other, record(h("9"), null, [channel("structural_graph", "current_for_basis", null)]));
      await mkdir(join(root, ".guild"), { recursive: true });
      await symlink(join(other, ".guild", "indexes"), join(root, ".guild", "indexes"));
      const s = (await readKnowledgeGenerations(root)).sources[0]!;
      expect(s.status).toBe("unreadable");
      expect(s.reason).toMatch(/outside/);
      expect(s.generations).toEqual([]);
    });

    it("foreign worktree: a record whose basis names another worktree is refused", async () => {
      const rec = record(h("a"), null, [channel("structural_graph", "current_for_basis", null)]);
      (rec.basis as Record<string, unknown>).source_worktree_id = "lane-b";
      await publish(root, rec);
      const g = (await readKnowledgeGenerations(root)).sources[0]!.generations[0]!;
      expect(g.status).toBe("refused");
      expect(g.reason).toMatch(/worktree/);
      expect(g.channels).toEqual([]);
    });

    it("collision: two workspace roots publishing the same generation stay separate per source", async () => {
      const childA = join(root, "a");
      const childB = join(root, "b");
      await writeFileDeep(
        join(root, ".guild", "workspace.json"),
        JSON.stringify({ sub_guilds: [{ name: "a", path: "a" }, { name: "b", path: "b" }] }),
      );
      await publish(childA, record(h("c"), null, [channel("recall", "current_for_basis", null)]));
      await publish(childB, record(h("c"), null, [channel("recall", "stale", "source drift")]));
      const body = await readKnowledgeGenerations(root);
      const by = Object.fromEntries(body.sources.map((s) => [s.source_guild, s]));
      expect(by.a!.generations[0]!.channels[0]!.state).toBe("current_for_basis");
      expect(by.b!.generations[0]!.channels[0]!.state).toBe("stale");
      expect(by.b!.generations[0]!.channels[0]!.reason).toBe("source drift");
    });
  });

  describe("codex r1 fixes", () => {
    it("F1: a workspace child symlinked to another root is refused, not adopted", async () => {
      await publish(other, record(h("e"), null, [channel("recall", "current_for_basis", null)]));
      await writeFileDeep(join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: [{ name: "child", path: "child" }] }));
      await symlink(other, join(root, "child"));
      const s = (await readKnowledgeGenerations(root)).sources.find((x) => x.source_guild === "child")!;
      expect(s.status).toBe("unreadable");
      expect(s.reason).toMatch(/outside the project root/);
      expect(s.generations).toEqual([]);
      await expect(readKnowledgeLayer(root, "child", h("e"), "recall")).rejects.toThrow(/unknown source/);
    });

    it("F2: records with an extra key, a traversal output path, or a bad availability are unreadable", async () => {
      const bad: Array<[string, Record<string, unknown>]> = [
        ["extra", record(h("1"), null, [channel("wiki", "current_for_basis", null)], { extra: 1 })],
        ["traversal", record(h("1"), null, [channel("wiki", "current_for_basis", null, { ...(EXAMPLE.channels[0]!.output as object), path: "../x.json" })])],
        ["availability", record(h("1"), null, [channel("wiki", "current_for_basis", null, { ...(EXAMPLE.channels[0]!.output as object), availability: "fresh" })])],
        ["manifest", record(h("1"), null, [channel("wiki", "current_for_basis", null)], { manifest: null })],
      ];
      for (const [label, rec] of bad) {
        await rm(join(root, ".guild"), { recursive: true, force: true });
        await publish(root, rec);
        const g = (await readKnowledgeGenerations(root)).sources[0]!.generations[0]!;
        expect([label, g.status]).toEqual([label, "unreadable"]);
        expect(g.channels).toEqual([]);
      }
    });

    it("F3: the layer drilldown reads only the selected generation, verified against its manifest", async () => {
      await publish(root, await withLayers(root, record(h("4"), null, [channel("structural_graph", "current_for_basis", null)]), { structural_graph: { nodes: [1, 2, 3], edges: [] } }));
      await publish(root, await withLayers(root, record(h("5"), h("4"), [channel("structural_graph", "stale", "drift")]), { structural_graph: { nodes: [1], edges: [1, 2] } }));
      const old = await readKnowledgeLayer(root, "project", h("4"), "structural_graph");
      const tip = await readKnowledgeLayer(root, "project", h("5"), "structural_graph");
      expect(old.status).toBe("verified");
      expect(old.top_level).toEqual([{ key: "nodes", kind: "array", length: 3 }, { key: "edges", kind: "array", length: 0 }]);
      expect(tip.top_level).toEqual([{ key: "nodes", kind: "array", length: 1 }, { key: "edges", kind: "array", length: 2 }]);
      const missing = await readKnowledgeLayer(root, "project", h("5"), "recall");
      expect(missing.status).toBe("not_in_generation");
      expect(missing.top_level).toEqual([]);
      await expect(readKnowledgeLayer(root, "project", h("9"), "recall")).rejects.toThrow(/not in the listed history/);
      await expect(readKnowledgeLayer(root, "project", h("5"), "wiki")).rejects.toThrow(/channel must be/);
    });

    it("F3: a tampered layer artifact is unreadable with no counts", async () => {
      await publish(root, await withLayers(root, record(h("6"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [1] } }, { tamperArtifact: true }));
      const l = await readKnowledgeLayer(root, "project", h("6"), "recall");
      expect(l.status).toBe("unreadable");
      expect(l.reason).toMatch(/hash/);
      expect(l.top_level).toEqual([]);
      expect(l.bytes).toBeNull();
    });

    it("F3: colliding sources with the same generation drill into their own bytes", async () => {
      await writeFileDeep(join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: [{ name: "a", path: "a" }, { name: "b", path: "b" }] }));
      await publish(join(root, "a"), await withLayers(join(root, "a"), record(h("c"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [1, 2] } }));
      await publish(join(root, "b"), await withLayers(join(root, "b"), record(h("c"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [] } }));
      expect((await readKnowledgeLayer(root, "a", h("c"), "recall")).top_level[0]!.length).toBe(2);
      expect((await readKnowledgeLayer(root, "b", h("c"), "recall")).top_level[0]!.length).toBe(0);
    });

    it("r2-F1: a manifest layer that disagrees with the record channel, or has no record channel, is unreadable", async () => {
      await publish(root, await withLayers(root, record(h("1"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [1] } }, { layerHash: h("9") }));
      const l = await readKnowledgeLayer(root, "project", h("1"), "recall");
      expect(l.status).toBe("unreadable");
      expect(l.reason).toMatch(/disagree/);
      expect(l.top_level).toEqual([]);
      await rm(join(root, ".guild"), { recursive: true, force: true });
      await publish(root, await withLayers(root, record(h("2"), null, [channel("wiki", "current_for_basis", null)]), { recall: { entries: [1] } }));
      const n = await readKnowledgeLayer(root, "project", h("2"), "recall");
      expect(n.status).toBe("unreadable");
      expect(n.reason).toMatch(/no recall channel/);
    });

    it("r3-F1: a workspace child symlinked to a sibling inside the project is refused", async () => {
      await writeFileDeep(join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: [{ name: "a", path: "a" }, { name: "b", path: "b" }] }));
      await publish(join(root, "b"), record(h("1"), null, [channel("recall", "current_for_basis", null)]));
      await symlink(join(root, "b"), join(root, "a"));
      const by = Object.fromEntries((await readKnowledgeGenerations(root)).sources.map((s) => [s.source_guild, s]));
      expect(by.a!.status).toBe("unreadable");
      expect(by.a!.reason).toMatch(/symlink/);
      expect(by.b!.status).toBe("published");
      await expect(readKnowledgeLayer(root, "a", h("1"), "recall")).rejects.toThrow(/unknown source/);
    });

    it("r3-F2: channel output evidence that names another artifact or hash is unreadable", async () => {
      await publish(root, await withLayers(root, record(h("1"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [1] } }, { outputSha: h("9") }));
      const l = await readKnowledgeLayer(root, "project", h("1"), "recall");
      expect(l.status).toBe("unreadable");
      expect(l.reason).toMatch(/output evidence/);
      await rm(join(root, ".guild"), { recursive: true, force: true });
      await publish(root, await withLayers(root, record(h("2"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [1] } }, { keepOutput: true }));
      expect((await readKnowledgeLayer(root, "project", h("2"), "recall")).status).toBe("unreadable");
    });

    it("r3-F3: two revisions of one candidate path stay distinct", async () => {
      const entry = (rev: string, state: string) => ({ candidate: { source_id: "source-a", kind: "candidate", id: "candidate:c1", revision: rev }, decision_id: "decision:d1", path: "knowledge/candidates/decisions/c1.md", state, promotion_gate: "guild:wiki-ingest", conflicts: [], listed_at_seq: 1 });
      await writeFileDeep(join(root, ".guild", "knowledge", "candidates", "manifest.json"), JSON.stringify({ schema_version: "guild.decision_candidates.v1", candidates: [entry(h("1"), "pending_human_ingest"), entry(h("2"), "missing")] }));
      const c = (await readKnowledgeGenerations(root)).sources[0]!.candidates!;
      expect(c.entries.map((e) => [e.candidate_revision, e.state])).toEqual([[h("1"), "pending_human_ingest"], [h("2"), "missing"]]);
    });

    it("r2-F2: malformed candidate entries make the manifest unreadable instead of counting conflicts", async () => {
      const good = { candidate: { source_id: "source-a", kind: "candidate", id: "candidate:c1", revision: h("c") }, decision_id: null, path: "knowledge/candidates/decisions/c1.md", state: "pending_human_ingest", promotion_gate: "guild:wiki-ingest", conflicts: [], listed_at_seq: 1 };
      const variants: Array<[string, Record<string, unknown>]> = [
        ["kind", { ...good, candidate: { ...good.candidate, kind: "run" } }],
        ["state", { ...good, state: "accepted" }],
        ["conflict", { ...good, conflicts: [null] }],
        ["path", { ...good, path: "../../foreign" }],
        ["decision", { ...good, decision_id: "" }],
      ];
      for (const [label, entry] of variants) {
        await writeFileDeep(join(root, ".guild", "knowledge", "candidates", "manifest.json"), JSON.stringify({ schema_version: "guild.decision_candidates.v1", candidates: [entry] }));
        const c = (await readKnowledgeGenerations(root)).sources[0]!.candidates!;
        expect([label, c.status, c.entries]).toEqual([label, "unreadable", []]);
      }
    });

    it("r2-F3: duplicate source names are refused, so a drilldown cannot read the wrong source", async () => {
      await writeFileDeep(join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: [{ name: "dup", path: "a" }, { name: "dup", path: "b" }, { name: "workspace", path: "c" }] }));
      for (const d of ["a", "b"]) await publish(join(root, d), record(h("1"), null, [channel("recall", "current_for_basis", null)]));
      await publish(join(root, "c"), record(h("2"), null, [channel("recall", "current_for_basis", null)]));
      await publish(root, record(h("3"), null, [channel("wiki", "current_for_basis", null)]));
      const body = await readKnowledgeGenerations(root);
      expect(body.sources.map((s) => [s.source_guild, s.status])).toEqual([
        ["workspace", "unreadable"],
        ["dup", "unreadable"],
        ["dup", "unreadable"],
        ["workspace", "unreadable"],
      ]);
      expect(body.sources.every((s) => s.generations.length === 0 && /ambiguous/.test(s.reason ?? ""))).toBe(true);
      await expect(readKnowledgeLayer(root, "dup", h("1"), "recall")).rejects.toThrow(/unknown source/);
    });

    it("F4: a workspace root holding only publications is still listed", async () => {
      await writeFileDeep(join(root, ".guild", "workspace.json"), JSON.stringify({ sub_guilds: [] }));
      await publish(root, record(h("7"), null, [channel("wiki", "current_for_basis", null)]));
      const body = await readKnowledgeGenerations(root);
      expect(body.sources.map((s) => [s.source_guild, s.tip])).toEqual([["workspace", h("7")]]);
    });

    it("layer route validates its query and returns the drilldown", async () => {
      const runsDir = await mkdtemp(join(tmpdir(), "at42-runs-"));
      const casesDir = await mkdtemp(join(tmpdir(), "at42-cases-"));
      try {
        await publish(root, await withLayers(root, record(h("8"), null, [channel("recall", "current_for_basis", null)]), { recall: { entries: [1] } }));
        const app = createApp({ runsDir, casesDir, port: 0, projectRoot: root });
        const ok = await app.fetch(req(`/api/project/knowledge-generations/layer?guild=project&generation=${h("8")}&channel=recall`));
        expect(ok.status).toBe(200);
        expect(((await ok.json()) as { status: string }).status).toBe("verified");
        expect((await app.fetch(req("/api/project/knowledge-generations/layer?guild=project"))).status).toBe(400);
        expect((await app.fetch(req(`/api/project/knowledge-generations/layer?guild=nope&generation=${h("8")}&channel=recall`))).status).toBe(404);
      } finally {
        await rm(runsDir, { recursive: true, force: true });
        await rm(casesDir, { recursive: true, force: true });
      }
    });
  });

  it("serves GET /api/project/knowledge-generations and 404s without a project root", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "at42-runs-"));
    const casesDir = await mkdtemp(join(tmpdir(), "at42-cases-"));
    try {
      await publish(root, record(h("d"), null, [channel("wiki", "current_for_basis", null)]));
      const res = await createApp({ runsDir, casesDir, port: 0, projectRoot: root }).fetch(req("/api/project/knowledge-generations"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as KnowledgeGenerationsResponse;
      expect(body.sources[0]!.tip).toBe(h("d"));
      const bare = await createApp({ runsDir, casesDir, port: 0 }).fetch(req("/api/project/knowledge-generations"));
      expect(bare.status).toBe(404);
    } finally {
      await rm(runsDir, { recursive: true, force: true });
      await rm(casesDir, { recursive: true, force: true });
    }
  });
});
