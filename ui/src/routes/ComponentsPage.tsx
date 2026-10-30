import { useMemo, useState } from "react";
import type { GuildComponentKind, ProjectComponentsResponse } from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// Read-only view over GET /api/project/components (guild-components-reader.ts).
// Shows only the fields each `.guild/` file states.
const KINDS: GuildComponentKind[] = ["agent", "skill", "workflow", "loop", "team"];

export default function ComponentsPage() {
  const { data, error, status } = useFetch<ProjectComponentsResponse>(api.projectComponents());
  const [kind, setKind] = useState<GuildComponentKind | "all">("all");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.components ?? []).filter(
      (row) =>
        (kind === "all" || row.kind === kind) &&
        (q === "" ||
          [row.name, row.description, row.source_guild, row.path, row.tier, row.model]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(q))),
    );
  }, [data, kind, query]);

  return (
    <section>
      <h1>Components</h1>
      <p className="muted">
        Agents, skills, and workflow, loop, and team registries found under each source's{" "}
        <code>.guild/</code>.
      </p>
      {status === "loading" ? <div className="loading">Loading components...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {/no project root configured|404/i.test(error?.message ?? "")
            ? "Start the server with --project-root to read Guild components."
            : `Could not load components: ${error?.message ?? "unknown error"}`}
        </div>
      ) : null}
      {status === "success" && data && data.components.length === 0 ? (
        <div className="empty">No agents, skills, or registry entries found in the configured sources.</div>
      ) : null}
      {status === "success" && data && data.components.length > 0 ? (
        <>
          {data.truncated ? (
            <div className="error" role="status" data-testid="listing-truncated">
              Listing stopped at the server's directory walk limit; some components are not shown.
            </div>
          ) : null}
          <div className="filter-bar">
            <div className="field field-compact">
              <label htmlFor="components-kind">Kind</label>
              <select
                id="components-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as GuildComponentKind | "all")}
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
              <label htmlFor="components-filter">Filter</label>
              <input
                id="components-filter"
                type="search"
                placeholder="Name, description, source, or path"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <p className="muted">
            {rows.length === data.components.length
              ? `${data.total} components`
              : `Showing ${rows.length} of ${data.total} components`}
          </p>
          {rows.length === 0 ? (
            <div className="empty">No components match this filter.</div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Source</th>
                    <th>Tier / model</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.source_guild}:${row.kind}:${row.path}:${row.name}`}>
                      <td>
                        <strong>{row.name}</strong>
                        <div className="muted">
                          <code>{row.path}</code>
                        </div>
                      </td>
                      <td>{row.kind}</td>
                      <td>{row.source_guild}</td>
                      <td>{[row.tier, row.model].filter(Boolean).join(" / ") || "—"}</td>
                      <td>{row.description ?? "—"}</td>
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
