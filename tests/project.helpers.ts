import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Shared fixture builders for the SC-12 live-project tests
// (project-reader.test.ts + server.project.test.ts). The workspace fixture
// mirrors the REAL generated `guild.workspace.v1` shape (field-for-field from
// a live <root>/.guild/workspace.json) rather than a hand-minimized seam —
// extra fields like `detection` / `query_recipe` are present on purpose so
// the lenient reader is exercised against the generated shape.

export async function writeFileDeep(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

export const SAMPLE_KG = {
  schema_version: "guild.knowledge_graph.v1",
  generated_at: "2026-06-01T00:00:00Z",
  nodes: [
    { id: "src/server.ts", type: "file", name: "server.ts", confidence: "high" },
    { id: "createApp", type: "function", name: "createApp", source_refs: ["src/server.ts"] },
    { id: "ServerOpts", type: "interface", name: "ServerOpts" },
  ],
  edges: [
    { source: "src/server.ts", target: "createApp", type: "declares", direction: "out" },
    { source: "createApp", target: "ServerOpts", type: "uses" },
  ],
};

export const WIKI_INDEX_MD = "# Guild Wiki Index\n\nTop-level index page.\n";

export const WIKI_DECISION_MD = [
  "---",
  "type: decision",
  "owner: docs-engineer",
  "labels: [architecture, security]",
  "created_at: 2026-05-02",
  "---",
  "# adopt-traversal-guard",
  "",
  "## Decision",
  "Use safeJoinUnder everywhere.",
  "",
].join("\n");

export const WIKI_NO_H1_MD = "Just prose, no heading at all.\n";

/** Plain (non-workspace) project root: own .guild/wiki + KG index. */
export async function seedPlainProject(root: string): Promise<void> {
  await writeFileDeep(join(root, ".guild", "wiki", "index.md"), WIKI_INDEX_MD);
  await writeFileDeep(
    join(root, ".guild", "wiki", "decisions", "adopt-traversal-guard.md"),
    WIKI_DECISION_MD,
  );
  await writeFileDeep(join(root, ".guild", "wiki", "notes", "untitled.md"), WIKI_NO_H1_MD);
  await writeFileDeep(
    join(root, ".guild", "indexes", "knowledge-graph.json"),
    JSON.stringify(SAMPLE_KG, null, 2),
  );
}

/**
 * Workspace root with two real sub-guilds:
 *   - "alpha": wiki + knowledge graph
 *   - "beta":  knowledge graph only (has_wiki: false, no wiki dir)
 *   - "gamma": neither artifact (must contribute nothing)
 */
export async function seedWorkspaceProject(root: string): Promise<void> {
  const workspace = {
    schema_version: "guild.workspace.v1",
    is_workspace: true,
    detected_at: "2026-06-01T00:00:00Z",
    detection: { depth: 1, rule: "immediate child has .git/ OR .guild/", mode: "auto" },
    root_wiki: false,
    workspace_knowledge: true,
    learn_fanout: "auto",
    sub_guilds: [
      {
        name: "alpha",
        path: "alpha",
        kind: "sub-guild",
        remote: "github.com/example/alpha",
        has_wiki: true,
        has_indexes: true,
        last_seen_commit: "a".repeat(40),
      },
      {
        name: "beta",
        path: "beta",
        kind: "sub-guild",
        remote: "github.com/example/beta",
        has_wiki: false,
        has_indexes: true,
        last_seen_commit: "b".repeat(40),
      },
      {
        name: "gamma",
        path: "gamma",
        kind: "sub-guild",
        remote: "github.com/example/gamma",
        has_wiki: false,
        has_indexes: false,
        last_seen_commit: "c".repeat(40),
      },
    ],
    query_recipe: {
      mechanism: "guild-memory MCP wiki_search/wiki_get/wiki_list",
      fan_out: "iterate sub_guilds where has_wiki",
    },
  };
  await writeFileDeep(
    join(root, ".guild", "workspace.json"),
    JSON.stringify(workspace, null, 2),
  );

  // alpha — wiki + KG
  await writeFileDeep(
    join(root, "alpha", ".guild", "wiki", "index.md"),
    "# Alpha Wiki\n\nAlpha index.\n",
  );
  await writeFileDeep(
    join(root, "alpha", ".guild", "wiki", "standards", "hooks.md"),
    [
      "---",
      "type: standard",
      "labels:",
      "  - hooks",
      "  - shell",
      "---",
      "# shell-hook-json-parsing",
      "Body.",
      "",
    ].join("\n"),
  );
  await writeFileDeep(
    join(root, "alpha", ".guild", "indexes", "knowledge-graph.json"),
    JSON.stringify({
      nodes: [{ id: "alpha-node", type: "file", name: "alpha.ts" }],
      edges: [{ source: "alpha-node", target: "alpha-node", type: "self" }],
    }),
  );

  // beta — KG only
  await writeFileDeep(
    join(root, "beta", ".guild", "indexes", "knowledge-graph.json"),
    JSON.stringify({
      nodes: [{ id: "beta-node", type: "module", name: "beta", custom_field: 42 }],
      edges: [],
      extra_top_level: { kept: true },
    }),
  );

  // gamma — a repo dir with no .guild artifacts at all
  await writeFileDeep(join(root, "gamma", "README.md"), "# gamma\n");
}
