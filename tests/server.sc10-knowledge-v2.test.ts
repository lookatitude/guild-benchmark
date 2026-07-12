// server.sc10-knowledge-v2.test.ts
//
// SC-10 headless benchmark assertion gate — REAL IMPORT PATH.
//
// Writes the canonical v2 knowledge-graph fixture to a temp project root's
// .guild/indexes/knowledge-graph.json, then exercises the live
// readProjectKnowledgeGraph() path (project-reader.ts) via
// GET /api/project/knowledge-graph on an in-process Hono app.
//
// Three assertions per SC-10:
//   (a) subtopic_of chain depth ≥ 3
//       Chain in fixture: Webhook Adapter → Source Adapters → Ingestion → Event Pipeline (depth 3)
//   (b) ≥ 1 wiki_page node with category + importance + labels present
//   (c) ≥ 1 evidenced_by edge from a doc/wiki-type node to a code-type node
//
// "Real import path" means: fixture bytes land on disk; project-reader reads
// them via existsSync + readFile; source_guild is stamped; lenient pass-through
// keeps ALL v2 fields (category, importance, labels, subtopic_of, evidenced_by).
// No plugin module is imported at runtime (NN#9).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";
import type { ProjectKnowledgeGraphResponse } from "../src/types.js";
import { req } from "./server.helpers.js";
import { V2_KNOWLEDGE_GRAPH } from "./fixtures/knowledge-graph-v2.js";

describe("SC-10 — v2 knowledge graph: import via real project-reader path", () => {
  let runsDir: string;
  let casesDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), "sc10-runs-"));
    casesDir = await mkdtemp(join(tmpdir(), "sc10-cases-"));
    projectRoot = await mkdtemp(join(tmpdir(), "sc10-root-"));
    // Seed the v2 fixture as the project's knowledge-graph.json (real file I/O).
    await mkdir(join(projectRoot, ".guild", "indexes"), { recursive: true });
    await writeFile(
      join(projectRoot, ".guild", "indexes", "knowledge-graph.json"),
      JSON.stringify(V2_KNOWLEDGE_GRAPH, null, 2),
    );
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
    await rm(casesDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  // ---- import path smoke test -----------------------------------------------

  it("imports the v2 graph with all 28 nodes + 24 edges and stamps source_guild", async () => {
    const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
    const res = await app.fetch(req("/api/project/knowledge-graph"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectKnowledgeGraphResponse;
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(Array.isArray(body.edges)).toBe(true);
    // Fixture has 28 nodes / 24 edges — all must survive the lenient pass-through.
    expect(body.nodes.length).toBe(28);
    expect(body.edges.length).toBe(24);
    // source_guild stamped on every node/edge (lenient reader invariant).
    for (const n of body.nodes) {
      expect(typeof n.source_guild).toBe("string");
    }
    for (const e of body.edges) {
      expect(typeof e.source_guild).toBe("string");
    }
    // Version field passes through untouched.
    expect(body.sources.length).toBe(1);
    expect(body.sources[0].kind).toBe("knowledge-graph");
  });

  // ---- SC-10(a): subtopic_of tree ≥ 3 deep ---------------------------------

  it("SC-10(a): has a subtopic_of chain of depth ≥ 3 (Webhook → Source Adapters → Ingestion → Event Pipeline)", async () => {
    const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
    const res = await app.fetch(req("/api/project/knowledge-graph"));
    const body = (await res.json()) as ProjectKnowledgeGraphResponse;

    // Build parent map from subtopic_of edges (child → parent).
    const subtopicEdges = body.edges.filter((e) => e.type === "subtopic_of");
    expect(subtopicEdges.length).toBeGreaterThan(0);

    const parentOf = new Map<string, string>();
    for (const e of subtopicEdges) {
      if (typeof e.source === "string" && typeof e.target === "string") {
        parentOf.set(e.source as string, e.target as string);
      }
    }

    // Walk from each node to root, counting edges. Guard against cycles.
    function chainDepth(id: string, seen = new Set<string>()): number {
      if (seen.has(id)) return 0;
      seen.add(id);
      const parent = parentOf.get(id);
      return parent ? 1 + chainDepth(parent, seen) : 0;
    }

    const depths = [...parentOf.keys()].map((id) => chainDepth(id));
    const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;

    // "≥ 3 deep" = at least 3 edges from root node to leaf (depth ≥ 3).
    // Fixture: topic:69b00735 (Webhook Adapter) → topic:2c7639cd (Source Adapters)
    //         → topic:79c825b8 (Ingestion) → topic:a81857d8 (Event Pipeline) = depth 3.
    expect(maxDepth).toBeGreaterThanOrEqual(3);
  });

  // ---- SC-10(b): classified + labeled wiki_page ≥ 1 -----------------------

  it("SC-10(b): has ≥ 1 wiki_page node with category + importance + labels present", async () => {
    const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
    const res = await app.fetch(req("/api/project/knowledge-graph"));
    const body = (await res.json()) as ProjectKnowledgeGraphResponse;

    // Lenient pass-through keeps category/importance/labels on wiki_page nodes.
    const classified = body.nodes.filter(
      (n) =>
        n.type === "wiki_page" &&
        typeof n.category === "string" &&
        n.category.length > 0 &&
        typeof n.importance === "string" &&
        n.importance.length > 0 &&
        Array.isArray(n.labels) &&
        (n.labels as unknown[]).length > 0,
    );
    expect(classified.length).toBeGreaterThanOrEqual(1);

    // Spot-check: wiki_page:docs/ingestion.md has category=guide, importance=high,
    // labels=[ingestion, pipeline].
    const ingestionPage = classified.find((n) => n.id === "wiki_page:docs/ingestion.md");
    expect(ingestionPage).toBeDefined();
    expect(ingestionPage?.category).toBe("guide");
    expect(ingestionPage?.importance).toBe("high");
    expect(ingestionPage?.labels).toContain("ingestion");
  });

  // ---- SC-10(c): cross-modal evidenced_by edge ≥ 1 ------------------------

  it("SC-10(c): has ≥ 1 evidenced_by edge from a doc/wiki-type node to a code-type node", async () => {
    const app = createApp({ runsDir, casesDir, port: 0, projectRoot });
    const res = await app.fetch(req("/api/project/knowledge-graph"));
    const body = (await res.json()) as ProjectKnowledgeGraphResponse;

    const DOC_TYPES = new Set(["wiki_page", "claim", "diagram", "concept"]);
    const CODE_TYPES = new Set(["function", "file", "class", "method"]);

    const nodesById = new Map<string, Record<string, unknown>>();
    for (const n of body.nodes) {
      if (typeof n.id === "string") nodesById.set(n.id as string, n);
    }

    const crossModalEvidencedBy = body.edges.filter((e) => {
      if (e.type !== "evidenced_by") return false;
      if (typeof e.source !== "string" || typeof e.target !== "string") return false;
      const srcNode = nodesById.get(e.source as string);
      const tgtNode = nodesById.get(e.target as string);
      if (!srcNode || !tgtNode) return false;
      return (
        DOC_TYPES.has(srcNode.type as string) && CODE_TYPES.has(tgtNode.type as string)
      );
    });

    expect(crossModalEvidencedBy.length).toBeGreaterThanOrEqual(1);

    // Spot-check: claim:docs/ingestion.md#... (claim/doc) → validateEvent (function/code).
    const claimToFunction = crossModalEvidencedBy.find(
      (e) => e.source === "claim:docs/ingestion.md#ingestion:0ee19523",
    );
    expect(claimToFunction).toBeDefined();
    expect(claimToFunction?.target).toBe("function:src/validate.ts:validateEvent");
  });
});
