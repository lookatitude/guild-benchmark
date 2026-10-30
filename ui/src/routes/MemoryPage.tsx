import { useMemo, useState } from "react";
import type { MemoryEntry, MemoryEntryKind, ProjectMemoryResponse } from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// Read-only view over GET /api/project/memory (guild-components-reader.ts).
// Every date carries where it came from; excerpts are bounded by the server.
const KINDS: MemoryEntryKind[] = ["summary", "lesson", "recall-index"];

const DATE_LABEL: Record<MemoryEntry["date_source"], string> = {
  frontmatter: "frontmatter",
  content: "from content",
  mtime: "file mtime",
};

export default function MemoryPage() {
  const { data, error, status } = useFetch<ProjectMemoryResponse>(api.projectMemory());
  const [kind, setKind] = useState<MemoryEntryKind | "all">("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.entries ?? []).filter(
      (row) =>
        (kind === "all" || row.kind === kind) &&
        (q === "" ||
          [row.title, row.excerpt, row.path, row.source_guild]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q))),
    );
  }, [data, kind, query]);

  return (
    <section>
      <h1>Memory</h1>
      <p className="muted">
        Summaries, lessons, and the recall index under each source's <code>.guild/memory/</code>.
      </p>
      {status === "loading" ? <div className="loading">Loading memory...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {/no project root configured|404/i.test(error?.message ?? "")
            ? "Start the server with --project-root to read Guild memory."
            : `Could not load memory: ${error?.message ?? "unknown error"}`}
        </div>
      ) : null}
      {status === "success" && data && data.entries.length === 0 ? (
        <div className="empty">No memory summaries, lessons, or recall index found in the configured sources.</div>
      ) : null}
      {status === "success" && data && data.entries.length > 0 ? (
        <>
          {data.truncated ? (
            <div className="error" role="status" data-testid="listing-truncated">
              Listing stopped at the server's directory walk limit; some memory entries are not shown.
            </div>
          ) : null}
          <div className="filter-bar">
            <div className="field field-compact">
              <label htmlFor="memory-kind">Kind</label>
              <select
                id="memory-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as MemoryEntryKind | "all")}
              >
                <option value="all">All</option>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="field field-search">
              <label htmlFor="memory-filter">Filter</label>
              <input
                id="memory-filter"
                type="search"
                placeholder="Title, excerpt, source, or path"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="empty">No memory entries match this filter.</div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Kind</th>
                    <th>Source</th>
                    <th>Date</th>
                    <th>Excerpt</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.source_guild}:${row.path}`}>
                      <td>
                        <strong>{row.title}</strong>
                        <div className="muted">
                          <code>{row.path}</code>
                        </div>
                      </td>
                      <td>{row.kind}</td>
                      <td>{row.source_guild}</td>
                      <td>
                        {row.date}
                        <div className="muted" data-testid="memory-date-source">
                          {DATE_LABEL[row.date_source]}
                        </div>
                      </td>
                      <td>
                        {row.kind === "recall-index"
                          ? row.entry_count === undefined
                            ? "—"
                            : `${row.entry_count} entries`
                          : row.excerpt
                            ? `${row.excerpt}${row.excerpt_truncated ? "…" : ""}`
                            : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
