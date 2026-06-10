// project-reader.ts — read-only access into a live Guild project's
// knowledge artifacts (.guild/wiki/** + .guild/indexes/knowledge-graph.json).
//
// SC-12 / G-17 (v2-gap-closure): `serve --project-root <abs>` mounts the
// /api/project/* routes on top of this module. Contract pinned in
// `.guild/spec/v2-gap-closure.md §The cross-repo dashboard contract`.
//
// Invariants:
//   - READ-ONLY. This module never writes anywhere, and never copies child
//     artifacts up to the workspace root (docs/v2/04 invariant).
//   - Zero plugin imports (telemetry split) — files are read by format only.
//   - Workspace-aware (codex G-plan finding #3): when
//     `<root>/.guild/workspace.json` (guild.workspace.v1) exists, federate
//     across `sub_guilds` read-only and tag every page/node/edge with
//     `source_guild`. A plain project root reads its own `.guild/` directly
//     with `source_guild = "project"`.
//   - Lenient readers: workspace.json and knowledge-graph.json are accepted
//     when they are "shape-like" ({nodes,edges}-ish); unknown fields pass
//     through untouched.
//   - Path traversal on wiki page reads is rejected with the same
//     safeJoinUnder pattern server.ts uses for artifacts.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

// Response shapes live in types.ts next to every other HTTP contract the UI
// imports (see types.ts §"live-project knowledge routes").
import type {
  ProjectKnowledgeGraphResponse,
  ProjectSource,
  ProjectWikiListResponse,
  ProjectWikiPageResponse,
  WikiPageSummary,
} from "./types.js";

// Tagged error so the route layer can map reader failures onto HTTP codes
// without string-matching messages.
export type ProjectReadErrorKind =
  | "not_found" // missing file/dir → 404
  | "bad_request" // traversal, missing/ambiguous params → 400
  | "ambiguous_guild"; // workspace mode, >1 wiki source, no &guild= → 400

export class ProjectReadError extends Error {
  kind: ProjectReadErrorKind;
  constructor(kind: ProjectReadErrorKind, message: string) {
    super(message);
    this.name = "ProjectReadError";
    this.kind = kind;
  }
}

// ---- guild-source resolution ----------------------------------------------

export interface GuildSource {
  /** sub-guild name (workspace mode) or "project" (plain root). */
  name: string;
  /** absolute path of the guild's repo root. */
  root: string;
  /** absolute `.guild/wiki` dir — present only when it exists on disk. */
  wikiRoot?: string;
  /** absolute knowledge-graph.json — present only when it exists on disk. */
  kgPath?: string;
}

interface WorkspaceSubGuildLike {
  name?: unknown;
  path?: unknown;
  has_wiki?: unknown;
}

/**
 * Resolve the set of guild sources under a project root.
 *
 * Workspace mode: `<root>/.guild/workspace.json` exists AND parses to an
 * object with a `sub_guilds` array (lenient — any other field is ignored).
 * Each entry contributes a source when its `name` + `path` are strings;
 * wikiRoot is attached when `has_wiki` is truthy OR the dir exists on disk,
 * kgPath when the child index file exists.
 *
 * Plain mode: single source named "project" pointing at the root itself.
 */
export async function resolveGuildSources(projectRoot: string): Promise<GuildSource[]> {
  const root = resolve(projectRoot);
  const workspacePath = join(root, ".guild", "workspace.json");
  if (existsSync(workspacePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(workspacePath, "utf8"));
    } catch {
      parsed = undefined;
    }
    const subGuilds =
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { sub_guilds?: unknown }).sub_guilds)
        ? ((parsed as { sub_guilds: unknown[] }).sub_guilds as WorkspaceSubGuildLike[])
        : undefined;
    if (subGuilds) {
      const sources: GuildSource[] = [];
      for (const sg of subGuilds) {
        if (typeof sg?.name !== "string" || typeof sg?.path !== "string") continue;
        const childRoot = resolve(root, sg.path);
        const wikiRoot = join(childRoot, ".guild", "wiki");
        const kgPath = join(childRoot, ".guild", "indexes", "knowledge-graph.json");
        const hasWiki = sg.has_wiki === true || existsSync(wikiRoot);
        const hasKg = existsSync(kgPath);
        sources.push({
          name: sg.name,
          root: childRoot,
          ...(hasWiki && existsSync(wikiRoot) ? { wikiRoot } : {}),
          ...(hasKg ? { kgPath } : {}),
        });
      }
      return sources;
    }
    // workspace.json exists but is malformed / sub_guilds missing —
    // fall through to plain-root behavior (lenient reader).
  }
  const wikiRoot = join(root, ".guild", "wiki");
  const kgPath = join(root, ".guild", "indexes", "knowledge-graph.json");
  return [
    {
      name: "project",
      root,
      ...(existsSync(wikiRoot) ? { wikiRoot } : {}),
      ...(existsSync(kgPath) ? { kgPath } : {}),
    },
  ];
}

// ---- knowledge graph -------------------------------------------------------

/**
 * Lenient KG reader: accepts any JSON object; `nodes` / `edges` arrays are
 * taken when present (non-object entries are dropped); unknown fields on each
 * node/edge pass through untouched. Every node/edge is tagged with
 * `source_guild`.
 *
 * Throws ProjectReadError("not_found") when NO source has a KG file.
 */
export async function readProjectKnowledgeGraph(
  projectRoot: string,
): Promise<ProjectKnowledgeGraphResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const withKg = sources.filter((s) => s.kgPath);
  if (withKg.length === 0) {
    throw new ProjectReadError(
      "not_found",
      "no knowledge-graph.json found under the project root",
    );
  }
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  const out: ProjectSource[] = [];
  for (const src of withKg) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(src.kgPath!, "utf8"));
    } catch {
      // Unreadable / non-JSON index — skip the source rather than failing
      // the whole federated view (lenient reader).
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const graph = parsed as { nodes?: unknown; edges?: unknown };
    for (const n of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (n !== null && typeof n === "object" && !Array.isArray(n)) {
        nodes.push({ ...(n as Record<string, unknown>), source_guild: src.name });
      }
    }
    for (const e of Array.isArray(graph.edges) ? graph.edges : []) {
      if (e !== null && typeof e === "object" && !Array.isArray(e)) {
        edges.push({ ...(e as Record<string, unknown>), source_guild: src.name });
      }
    }
    out.push({ guild: src.name, path: src.kgPath! });
  }
  if (out.length === 0) {
    throw new ProjectReadError(
      "not_found",
      "no readable knowledge-graph.json found under the project root",
    );
  }
  return { nodes, edges, sources: out };
}

// ---- wiki list --------------------------------------------------------------

/**
 * List every `.md` page across all wiki sources. Paths are relative to the
 * owning guild's `.guild/wiki/`; title is the first `# ` H1 (else the
 * filename); labels come from frontmatter when trivially parseable.
 *
 * Throws ProjectReadError("not_found") when NO source has a wiki dir.
 */
export async function listProjectWikiPages(
  projectRoot: string,
): Promise<ProjectWikiListResponse> {
  const sources = await resolveGuildSources(projectRoot);
  const withWiki = sources.filter((s) => s.wikiRoot);
  if (withWiki.length === 0) {
    throw new ProjectReadError(
      "not_found",
      "no .guild/wiki directory found under the project root",
    );
  }
  const pages: WikiPageSummary[] = [];
  for (const src of withWiki) {
    const files = await walkMarkdownFiles(src.wikiRoot!);
    for (const abs of files) {
      const rel = relative(src.wikiRoot!, abs).split(sep).join("/");
      let raw = "";
      try {
        raw = await readFile(abs, "utf8");
      } catch {
        continue; // unreadable page — skip, never fail the listing
      }
      const title = extractTitle(raw, rel);
      const labels = extractFrontmatterLabels(raw);
      pages.push({
        path: rel,
        title,
        source_guild: src.name,
        ...(labels && labels.length > 0 ? { labels } : {}),
      });
    }
  }
  pages.sort((a, b) =>
    a.source_guild === b.source_guild
      ? a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0
      : a.source_guild < b.source_guild
        ? -1
        : 1,
  );
  return { pages };
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdownFiles(full)));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** First `# `-prefixed line wins; else the filename without extension. */
export function extractTitle(markdown: string, relPath: string): string {
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "");
}

/**
 * Trivially-parseable frontmatter labels. Recognized forms inside a leading
 * `---` block:
 *   labels: [a, b]      (inline flow list)
 *   labels:             (block list)
 *     - a
 *     - b
 * Anything else → undefined (no labels). No YAML dependency on this path.
 */
export function extractFrontmatterLabels(markdown: string): string[] | undefined {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return undefined;
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; i++) {
    const m = /^labels:\s*(.*)$/.exec(fm[i]);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      const items = inline
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    if (inline === "") {
      const items: string[] = [];
      for (let j = i + 1; j < fm.length; j++) {
        const item = /^\s+-\s+(.+?)\s*$/.exec(fm[j]);
        if (!item) break;
        items.push(item[1].replace(/^["']|["']$/g, ""));
      }
      return items.length > 0 ? items : undefined;
    }
    return undefined; // scalar labels value — not a list, skip
  }
  return undefined;
}

// ---- wiki page get -----------------------------------------------------------

/**
 * Read one wiki page. `relPath` is relative to the owning guild's
 * `.guild/wiki/`. In workspace mode with more than one wiki source the
 * `guildName` parameter is required (ambiguous_guild otherwise); with exactly
 * one source it defaults to that source. Traversal (absolute paths, `..`
 * escapes) is rejected via the safeJoinUnder pattern — the resolved path must
 * stay under that guild's wiki root.
 */
export async function readProjectWikiPage(
  projectRoot: string,
  relPath: string,
  guildName?: string,
): Promise<ProjectWikiPageResponse> {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    throw new ProjectReadError("bad_request", "path query parameter is required");
  }
  if (isAbsolute(relPath)) {
    throw new ProjectReadError("bad_request", "path traversal denied");
  }
  const sources = await resolveGuildSources(projectRoot);
  const withWiki = sources.filter((s) => s.wikiRoot);
  if (withWiki.length === 0) {
    throw new ProjectReadError(
      "not_found",
      "no .guild/wiki directory found under the project root",
    );
  }
  let source: GuildSource | undefined;
  if (guildName !== undefined && guildName !== "") {
    source = withWiki.find((s) => s.name === guildName);
    if (!source) {
      throw new ProjectReadError("not_found", `unknown guild: ${guildName}`);
    }
  } else if (withWiki.length === 1) {
    source = withWiki[0];
  } else {
    throw new ProjectReadError(
      "ambiguous_guild",
      "guild query parameter is required when multiple wiki sources exist",
    );
  }
  const target = safeJoinUnder(source.wikiRoot!, relPath);
  if (!target) {
    throw new ProjectReadError("bad_request", "path traversal denied");
  }
  if (!existsSync(target)) {
    throw new ProjectReadError("not_found", `wiki page not found: ${relPath}`);
  }
  let content: string;
  try {
    content = await readFile(target, "utf8");
  } catch {
    throw new ProjectReadError("not_found", `wiki page not readable: ${relPath}`);
  }
  return {
    path: normalize(relPath).split(sep).join("/"),
    source_guild: source.name,
    content,
  };
}

// Same traversal guard as server.ts (kept duplicated on purpose — the spec
// pins "the safeJoinUnder pattern"; project-reader stays import-free of
// server internals so it is unit-testable in isolation).
export function safeJoinUnder(root: string, rest: string): string | null {
  const normalisedRest = normalize(rest).replace(/^([\\/]+)/, "");
  if (normalisedRest === ".." || normalisedRest.startsWith(`..${sep}`)) return null;
  const target = resolve(root, normalisedRest);
  const rel = relative(root, target);
  if (rel.startsWith("..") || resolve(root, rel) !== target) return null;
  return target;
}
