import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ProjectWikiListResponse,
  ProjectWikiPageResponse,
  WikiPageSummary,
} from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// SC-12 / G-18 — Wiki browser: page list grouped by source_guild +
// markdown page rendering over GET /api/project/wiki[/page].

function sourceRank(guild: string): number {
  if (guild === "workspace") return 0;
  if (guild === "project") return 1;
  return 2;
}

function pageMatchesQuery(page: WikiPageSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [page.title, page.path, ...(page.labels ?? [])]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function stripFrontmatter(content: string): string {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export default function WikiPage() {
  const { data, error, status } = useFetch<ProjectWikiListResponse>(api.projectWiki());
  const [selected, setSelected] = useState<WikiPageSummary | null>(null);
  const [activeGuild, setActiveGuild] = useState("");
  const [query, setQuery] = useState("");

  // Always pass &guild= — readProjectWikiPage accepts the owning guild name
  // in both plain ("project") and workspace modes, which sidesteps the
  // ambiguous-guild 400 when several wikis federate.
  const pageUrl = selected
    ? api.projectWikiPage(selected.path, selected.source_guild)
    : null;
  const page = useFetch<ProjectWikiPageResponse>(pageUrl);

  const groups = useMemo(() => {
    const map = new Map<string, WikiPageSummary[]>();
    for (const p of data?.pages ?? []) {
      const list = map.get(p.source_guild) ?? [];
      list.push(p);
      map.set(p.source_guild, list);
    }
    return [...map.entries()]
      .map(([guild, pages]) => ({
        guild,
        pages: [...pages].sort((a, b) =>
          a.title === b.title ? a.path.localeCompare(b.path) : a.title.localeCompare(b.title),
        ),
      }))
      .sort((a, b) => {
        const rankDelta = sourceRank(a.guild) - sourceRank(b.guild);
        return rankDelta === 0 ? a.guild.localeCompare(b.guild) : rankDelta;
      });
  }, [data]);

  useEffect(() => {
    if (groups.length === 0) {
      if (activeGuild) setActiveGuild("");
      return;
    }
    if (!groups.some((group) => group.guild === activeGuild)) {
      setActiveGuild(groups[0].guild);
      setSelected(null);
      setQuery("");
    }
  }, [activeGuild, groups]);

  const activeGroup = groups.find((group) => group.guild === activeGuild) ?? groups[0];
  const filteredPages = useMemo(
    () => activeGroup?.pages.filter((pageSummary) => pageMatchesQuery(pageSummary, query)) ?? [],
    [activeGroup, query],
  );

  const isNoProjectRoot =
    status === "error" && /no project root configured/i.test(error?.message ?? "");

  return (
    <section>
      <header className="page-header">
        <div>
          <p className="eyebrow">Knowledge library</p>
          <h1>Wiki</h1>
          <p className="muted">Project wiki pages plus workspace docs/knowledge when available.</p>
        </div>
      </header>
      {status === "loading" ? <div className="loading">Loading wiki pages…</div> : null}
      {isNoProjectRoot ? (
        <div className="empty" data-testid="wiki-no-project-root">
          Live-project mode is off. Restart the server with{" "}
          <code>npm run benchmark -- serve --project-root &lt;abs-path&gt;</code> to
          browse the project&apos;s wiki.
        </div>
      ) : status === "error" ? (
        <div className="error" role="alert">
          {error?.message ?? "failed to load wiki pages"}
        </div>
      ) : null}
      {status === "success" && data ? (
        data.pages.length === 0 ? (
          <div className="empty">The project wiki has no pages yet.</div>
        ) : (
          <div className="wiki-layout">
            <div className="wiki-list-panel">
              <div
                className="segmented wiki-source-tabs"
                role="tablist"
                aria-label="Wiki sources"
                data-testid="wiki-source-tabs"
              >
                {groups.map((group) => (
                  <button
                    key={group.guild}
                    type="button"
                    role="tab"
                    aria-selected={group.guild === activeGroup?.guild}
                    className={group.guild === activeGroup?.guild ? "active" : ""}
                    onClick={() => {
                      setActiveGuild(group.guild);
                      setSelected(null);
                      setQuery("");
                    }}
                  >
                    <span>{group.guild}</span>
                    <span className="tab-count">{group.pages.length}</span>
                  </button>
                ))}
              </div>

              <div className="wiki-list-header">
                <div>
                  <h3>
                    <span className="badge-source">{activeGroup?.guild}</span>
                    <span className="muted">
                      {activeGroup?.pages.length ?? 0} page
                      {(activeGroup?.pages.length ?? 0) === 1 ? "" : "s"}
                    </span>
                  </h3>
                  <p className="muted">
                    {filteredPages.length === (activeGroup?.pages.length ?? 0)
                      ? "Showing all pages"
                      : `Showing ${filteredPages.length} of ${activeGroup?.pages.length ?? 0} pages`}
                  </p>
                </div>
              </div>

              <div className="field wiki-page-search">
                <label htmlFor="wiki-page-filter">Filter pages</label>
                <input
                  id="wiki-page-filter"
                  type="search"
                  placeholder="Title, path, or label"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>

              {filteredPages.length === 0 ? (
                <div className="empty">No wiki pages match this filter.</div>
              ) : (
                <ul className="wiki-page-list">
                  {filteredPages.map((p) => (
                    <li key={`${p.source_guild}/${p.path}`}>
                      <button
                        className="wiki-page-row"
                        type="button"
                        onClick={() => setSelected(p)}
                        aria-pressed={
                          selected?.path === p.path &&
                          selected?.source_guild === p.source_guild
                        }
                      >
                        <span className="wiki-page-row-title">{p.title}</span>
                        <span className="wiki-page-row-path">
                          <code>{p.path}</code>
                        </span>
                        {p.labels && p.labels.length > 0 ? (
                          <span className="wiki-page-row-labels">
                            {p.labels.map((label) => (
                              <span key={label} className="badge-source">
                                {label}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              {!selected ? (
                <div className="empty">Select a page to read it.</div>
              ) : page.status === "loading" ? (
                <div className="loading">Loading {selected.path}…</div>
              ) : page.status === "error" ? (
                <div className="error" role="alert">
                  {page.error?.message ?? "failed to load page"}
                </div>
              ) : page.status === "success" && page.data ? (
                <div className="card" data-testid="wiki-page-content">
                  <h3>
                    {selected.title}{" "}
                    <span className="badge-source">{page.data.source_guild}</span>
                  </h3>
                  <p className="muted">
                    <code>{page.data.path}</code>
                  </p>
                  <article className="wiki-content" data-testid="wiki-markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {stripFrontmatter(page.data.content)}
                    </ReactMarkdown>
                  </article>
                </div>
              ) : null}
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
