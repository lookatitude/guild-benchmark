import { useMemo, useState } from "react";
import type {
  ProjectWikiListResponse,
  ProjectWikiPageResponse,
  WikiPageSummary,
} from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// SC-12 / G-18 — Wiki browser: page list grouped by source_guild +
// preformatted page rendering over GET /api/project/wiki[/page]. No markdown
// dependency in this repo, so content renders as preformatted text on
// purpose (repo dependency posture — see plan lane B1).

export default function WikiPage() {
  const { data, error, status } = useFetch<ProjectWikiListResponse>(api.projectWiki());
  const [selected, setSelected] = useState<WikiPageSummary | null>(null);

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
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [data]);

  const isNoProjectRoot =
    status === "error" && /no project root configured/i.test(error?.message ?? "");

  return (
    <section>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <h1>Wiki</h1>
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
            <div>
              {groups.map(([guild, pages]) => (
                <div className="card" key={guild}>
                  <h3>
                    <span className="badge-source">{guild}</span>{" "}
                    <span className="muted">
                      {pages.length} page{pages.length === 1 ? "" : "s"}
                    </span>
                  </h3>
                  <ul className="wiki-page-list">
                    {pages.map((p) => (
                      <li key={`${guild}/${p.path}`}>
                        <button
                          onClick={() => setSelected(p)}
                          aria-pressed={
                            selected?.path === p.path &&
                            selected?.source_guild === guild
                          }
                          style={{
                            background: "none",
                            border: 0,
                            padding: 0,
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          {p.title}
                        </button>{" "}
                        <span className="muted">
                          <code>{p.path}</code>
                        </span>
                        {p.labels?.map((label) => (
                          <span key={label} className="badge-source">
                            {label}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
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
                  <pre className="wiki-content">{page.data.content}</pre>
                </div>
              ) : null}
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
