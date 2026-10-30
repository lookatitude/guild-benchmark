// guild-components-reader.ts — read-only listing of a live project's Guild
// components (agents, skills, workflow/loop/team registries) and memory
// (`.guild/memory/**`).
//
// Invariants (same as project-reader.ts):
//   - READ-ONLY, zero plugin imports; files are read by format only.
//   - Absent files/dirs yield empty lists, never errors.
//   - Never manufacture values: a field is present only when the file states it.
//   - Containment: a source's `.guild/` must sit physically where it sits
//     lexically under the project root, and every file read must realpath
//     inside that `.guild/`. Symlinked dirs are not descended; symlinked files
//     that escape are skipped.

import { realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectReadError, resolveGuildSources, type GuildSource } from "./project-reader.js";
import type {
  GuildComponentKind,
  GuildComponentRow,
  MemoryEntry,
  MemoryEntryKind,
  ProjectComponentsResponse,
  ProjectMemoryResponse,
} from "./types.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_SKILL_DEPTH = 6;
const MAX_FILES_PER_DIR = 2000;
export const MEMORY_EXCERPT_CHARS = 280;
const DESCRIPTION_CHARS = 400;

interface ContainedSource {
  name: string;
  root: string;
  guildReal: string;
}

/** Resolve sources, optionally filtered by `?guild=`, keeping only contained `.guild/` dirs. */
async function containedSources(projectRoot: string, guild?: string): Promise<ContainedSource[]> {
  const root = resolve(projectRoot);
  const sources: GuildSource[] = await resolveGuildSources(root);
  // resolveGuildSources drops a workspace root with no wiki/runs/graph; components
  // and memory can still live there, so keep the root itself in the set.
  if (!sources.some((s) => resolve(s.root) === root)) {
    sources.unshift({ name: "workspace", root });
  }
  if (guild !== undefined) {
    if (!sources.some((s) => s.name === guild)) {
      throw new ProjectReadError("bad_request", "unknown guild source");
    }
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    throw new ProjectReadError("not_found", "project root not found");
  }
  const out: ContainedSource[] = [];
  for (const source of sources) {
    if (guild !== undefined && source.name !== guild) continue;
    const lexical = join(resolve(source.root), ".guild");
    let guildReal: string;
    try {
      guildReal = realpathSync(lexical);
    } catch {
      continue; // no .guild/ — contributes nothing
    }
    if (guildReal !== resolve(rootReal, relative(root, lexical))) continue; // symlinked escape
    out.push({ name: source.name, root: resolve(source.root), guildReal });
  }
  return out;
}

/** Return the file's text when it is a regular file contained in `guildReal`. */
async function readContained(
  guildReal: string,
  file: string,
): Promise<{ text: string; mtime: Date } | undefined> {
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) {
      const real = realpathSync(file);
      if (!isInside(guildReal, real)) return undefined;
      const target = await lstat(real);
      if (!target.isFile() || target.size > MAX_FILE_BYTES) return undefined;
      return { text: await readFile(real, "utf8"), mtime: target.mtime };
    }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    if (!isInside(guildReal, realpathSync(file))) return undefined;
    return { text: await readFile(file, "utf8"), mtime: st.mtime };
  } catch {
    return undefined;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Directory entries of a real (non-symlinked) directory, else []. */
async function realDirEntries(dir: string) {
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.slice(0, MAX_FILES_PER_DIR);
  } catch {
    return [];
  }
}

function relPosix(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length) };
}

function str(value: unknown, max = DESCRIPTION_CHARS): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/\s+/g, " ").trim();
  if (t.length === 0) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

// ---- components -------------------------------------------------------------

export async function listProjectComponents(
  projectRoot: string,
  guild?: string,
): Promise<ProjectComponentsResponse> {
  const sources = await containedSources(projectRoot, guild);
  const components: GuildComponentRow[] = [];
  const outSources: ProjectComponentsResponse["sources"] = [];
  for (const src of sources) {
    const present = new Set<GuildComponentKind>();

    const agentsDir = join(src.root, ".guild", "agents");
    for (const entry of await realDirEntries(agentsDir)) {
      if (!/\.md$/i.test(entry.name)) continue;
      const file = join(agentsDir, entry.name);
      const read = await readContained(src.guildReal, file);
      if (!read) continue;
      present.add("agent");
      const { data } = splitFrontmatter(read.text);
      const tier = str(data.tier) ?? str(data.default_tier);
      const model = str(data.model);
      const description = str(data.description);
      components.push({
        kind: "agent",
        name: str(data.name) ?? entry.name.replace(/\.md$/i, ""),
        source_guild: src.name,
        path: relPosix(src.root, file),
        ...(description ? { description } : {}),
        ...(tier ? { tier } : {}),
        ...(model ? { model } : {}),
      });
    }

    for (const file of await findSkillFiles(join(src.root, ".guild", "skills"), 0)) {
      const read = await readContained(src.guildReal, file);
      if (!read) continue;
      present.add("skill");
      const { data } = splitFrontmatter(read.text);
      const description = str(data.description);
      const tier = str(data.tier);
      const model = str(data.model);
      components.push({
        kind: "skill",
        name: str(data.name) ?? basename(join(file, "..")),
        source_guild: src.name,
        path: relPosix(src.root, file),
        ...(description ? { description } : {}),
        ...(tier ? { tier } : {}),
        ...(model ? { model } : {}),
      });
    }

    const registries: [GuildComponentKind, string][] = [
      ["workflow", "workflows"],
      ["loop", "loops"],
      ["team", "teams"],
    ];
    for (const [kind, dir] of registries) {
      const file = join(src.root, ".guild", dir, "registry.yaml");
      const read = await readContained(src.guildReal, file);
      if (!read) continue;
      present.add(kind);
      let parsed: unknown;
      try {
        parsed = parseYaml(read.text);
      } catch {
        continue;
      }
      const list =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)[dir]
          : undefined;
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const obj = item as Record<string, unknown>;
        const name = str(obj.id) ?? str(obj.name);
        if (!name) continue;
        const description = str(obj.description) ?? str(obj.purpose);
        components.push({
          kind,
          name,
          source_guild: src.name,
          path: relPosix(src.root, file),
          ...(description ? { description } : {}),
        });
      }
    }
    outSources.push({ guild: src.name, present: [...present] });
  }
  components.sort(
    (a, b) =>
      a.source_guild.localeCompare(b.source_guild) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
  return { components, total: components.length, sources: outSources };
}

async function findSkillFiles(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_SKILL_DEPTH) return [];
  const out: string[] = [];
  for (const entry of await realDirEntries(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await findSkillFiles(full, depth + 1)));
    } else if (entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink())) {
      out.push(full);
    }
  }
  return out;
}

// ---- memory -------------------------------------------------------------------

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})(?:[T ][0-9:.]+Z?)?\b/;

function dateFromFrontmatter(data: Record<string, unknown>): string | undefined {
  for (const key of ["date", "updated_at", "created_at", "generated_at"]) {
    const v = data[key];
    if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function excerptOf(body: string): { excerpt?: string; excerpt_truncated?: boolean } {
  const text = body
    .split(/\r?\n/)
    .filter((line) => !/^#\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return {};
  if (text.length <= MEMORY_EXCERPT_CHARS) return { excerpt: text, excerpt_truncated: false };
  return { excerpt: text.slice(0, MEMORY_EXCERPT_CHARS), excerpt_truncated: true };
}

function textEntry(
  kind: MemoryEntryKind,
  src: ContainedSource,
  file: string,
  read: { text: string; mtime: Date },
): MemoryEntry {
  const { data, body } = splitFrontmatter(read.text);
  const fmDate = dateFromFrontmatter(data);
  const contentDate = fmDate ? undefined : ISO_DATE.exec(body)?.[1];
  const title =
    str(data.title, 200) ?? firstHeading(body) ?? basename(file).replace(/\.[^.]+$/, "");
  return {
    kind,
    source_guild: src.name,
    path: relPosix(src.root, file),
    title,
    ...(fmDate
      ? { date: fmDate, date_source: "frontmatter" as const }
      : contentDate
        ? { date: contentDate, date_source: "content" as const }
        : { date: read.mtime.toISOString(), date_source: "mtime" as const }),
    ...excerptOf(body),
  };
}

export async function listProjectMemory(
  projectRoot: string,
  guild?: string,
): Promise<ProjectMemoryResponse> {
  const sources = await containedSources(projectRoot, guild);
  const entries: MemoryEntry[] = [];
  const outSources: ProjectMemoryResponse["sources"] = [];
  for (const src of sources) {
    const present = new Set<MemoryEntryKind>();
    const memoryDir = join(src.root, ".guild", "memory");
    const buckets: [MemoryEntryKind, string, RegExp][] = [
      ["summary", "summaries", /\.md$/i],
      ["lesson", "lessons", /\.(md|txt|ya?ml|json)$/i],
    ];
    for (const [kind, sub, pattern] of buckets) {
      const dir = join(memoryDir, sub);
      for (const entry of await realDirEntries(dir)) {
        if (!pattern.test(entry.name) || entry.name.startsWith(".")) continue;
        const file = join(dir, entry.name);
        const read = await readContained(src.guildReal, file);
        if (!read) continue;
        present.add(kind);
        entries.push(textEntry(kind, src, file, read));
      }
    }

    const indexFile = join(memoryDir, "recall-index.json");
    const indexRead = await readContained(src.guildReal, indexFile);
    if (indexRead) {
      present.add("recall-index");
      let parsed: Record<string, unknown> = {};
      try {
        const v = JSON.parse(indexRead.text);
        if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const generated = typeof parsed.generated_at === "string" ? parsed.generated_at : undefined;
      entries.push({
        kind: "recall-index",
        source_guild: src.name,
        path: relPosix(src.root, indexFile),
        title: "Recall index",
        ...(generated
          ? { date: generated, date_source: "content" as const }
          : { date: indexRead.mtime.toISOString(), date_source: "mtime" as const }),
        ...(Array.isArray(parsed.entries) ? { entry_count: parsed.entries.length } : {}),
      });
    }
    outSources.push({ guild: src.name, present: [...present] });
  }
  entries.sort(
    (a, b) =>
      a.source_guild.localeCompare(b.source_guild) ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      a.path.localeCompare(b.path),
  );
  return { entries, total: entries.length, sources: outSources };
}
