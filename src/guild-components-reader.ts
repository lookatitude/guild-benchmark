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

import { realpathSync, type Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { ProjectReadError, resolveGuildSources, type GuildSource } from "./project-reader.js";
import { readContainedRegularFile, type BoundedRead } from "./safe-read.js";
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

/** Per-request walk budget shared by every source and directory. */
export interface WalkLimits {
  maxEntries: number;
  maxDirs: number;
}

export const DEFAULT_WALK_LIMITS: WalkLimits = { maxEntries: 20_000, maxDirs: 2_000 };

interface Budget {
  limits: WalkLimits;
  entries: number;
  dirs: number;
  truncated: boolean;
}

function newBudget(limits: WalkLimits): Budget {
  return { limits, entries: 0, dirs: 0, truncated: false };
}
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

/** Bounded no-follow read of a regular file contained in `guildReal`; symlinks are refused. */
function readContained(guildReal: string, file: string): Promise<BoundedRead | undefined> {
  return readContainedRegularFile(file, MAX_FILE_BYTES, guildReal);
}

/**
 * Stream a real (non-symlinked) directory's entries, charging each against the
 * request budget. Stops early and marks the budget truncated when exhausted.
 */
async function eachDirEntry(
  dir: string,
  budget: Budget,
  visit: (entry: Dirent) => Promise<void>,
): Promise<void> {
  if (budget.truncated) return;
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return;
  } catch {
    return;
  }
  if (budget.dirs >= budget.limits.maxDirs) {
    budget.truncated = true;
    return;
  }
  budget.dirs += 1;
  let handle;
  try {
    handle = await opendir(dir);
  } catch {
    return;
  }
  try {
    for await (const entry of handle) {
      if (budget.entries >= budget.limits.maxEntries) {
        budget.truncated = true;
        break;
      }
      budget.entries += 1;
      await visit(entry);
      if (budget.truncated) break;
    }
  } catch {
    // unreadable mid-iteration — keep what was collected
  }
}

function relPosix(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  // Opening and closing delimiters are lines that are exactly `---`
  // (trailing spaces/tabs and CRLF allowed); `---not-a-delimiter` is content.
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
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
  limits: WalkLimits = DEFAULT_WALK_LIMITS,
): Promise<ProjectComponentsResponse> {
  const sources = await containedSources(projectRoot, guild);
  const budget = newBudget(limits);
  const components: GuildComponentRow[] = [];
  const outSources: ProjectComponentsResponse["sources"] = [];
  for (const src of sources) {
    const present = new Set<GuildComponentKind>();

    const agentsDir = join(src.root, ".guild", "agents");
    await eachDirEntry(agentsDir, budget, async (entry) => {
      if (!/\.md$/i.test(entry.name)) return;
      const file = join(agentsDir, entry.name);
      const read = await readContained(src.guildReal, file);
      if (!read) return;
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
    });

    const skillFiles: string[] = [];
    await findSkillFiles(join(src.root, ".guild", "skills"), 0, budget, skillFiles);
    for (const file of skillFiles) {
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
  return {
    components,
    total: components.length,
    truncated: budget.truncated,
    sources: outSources,
  };
}

/** Collect SKILL.md paths into `out` (no array spreading), charging the budget. */
async function findSkillFiles(
  dir: string,
  depth: number,
  budget: Budget,
  out: string[],
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) return;
  await eachDirEntry(dir, budget, async (entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await findSkillFiles(full, depth + 1, budget, out);
    } else if (entry.name === "SKILL.md" && entry.isFile()) {
      out.push(full);
    }
  });
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
  limits: WalkLimits = DEFAULT_WALK_LIMITS,
): Promise<ProjectMemoryResponse> {
  const sources = await containedSources(projectRoot, guild);
  const budget = newBudget(limits);
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
      await eachDirEntry(dir, budget, async (entry) => {
        if (!pattern.test(entry.name) || entry.name.startsWith(".")) return;
        const file = join(dir, entry.name);
        const read = await readContained(src.guildReal, file);
        if (!read) return;
        present.add(kind);
        entries.push(textEntry(kind, src, file, read));
      });
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
  return { entries, total: entries.length, truncated: budget.truncated, sources: outSources };
}
