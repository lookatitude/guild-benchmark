import { Link } from "react-router-dom";
import type { ProjectInitiativesResponse } from "../../../src/types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";

// Read-only view over GET /api/project/initiatives (project-reader.ts
// listProjectInitiatives). Shows only what the initiative records state.
export default function InitiativesPage() {
  const { data, error, status } = useFetch<ProjectInitiativesResponse>(api.projectInitiatives());

  return (
    <section>
      <h1>Initiatives</h1>
      <p className="muted">
        Durable work tracked under each source's <code>.guild/initiatives/</code>, with the runs
        that reference it.
      </p>
      {status === "loading" ? <div className="loading">Loading initiatives...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {/no project root configured|404/i.test(error?.message ?? "")
            ? "Start the server with --project-root to read initiatives."
            : `Could not load initiatives: ${error?.message ?? "unknown error"}`}
        </div>
      ) : null}
      {status === "success" && data && data.initiatives.length === 0 ? (
        <div className="empty">No initiatives found in the configured sources.</div>
      ) : null}
      {status === "success" && data && data.initiatives.length > 0 ? (
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Initiative</th>
              <th>Source</th>
              <th>Status</th>
              <th>Execution</th>
              <th>Runs</th>
              <th>Comparable</th>
            </tr>
          </thead>
          <tbody>
            {data.initiatives.map((row) => (
              <tr key={`${row.source_guild}:${row.id}`}>
                <td>
                  <strong>{row.title ?? row.id}</strong>
                  <div className="muted">
                    <code>{row.id}</code>
                    {row.scope ? ` · ${row.scope}` : ""}
                  </div>
                </td>
                <td>{row.source_guild}</td>
                <td>{row.status ?? "—"}</td>
                <td>{row.execution_status ?? "—"}</td>
                <td>
                  {row.run_ids.length === 0
                    ? "0"
                    : row.run_ids.map((id, i) => (
                        <span key={id}>
                          {i > 0 ? ", " : ""}
                          <Link to={`/project-runs/${encodeURIComponent(id)}?guild=${encodeURIComponent(row.source_guild)}`}>
                            {id}
                          </Link>
                        </span>
                      ))}
                </td>
                <td title={row.comparison_reasons.join("; ")}>
                  {row.comparison_eligible ? `yes (${row.eligible_run_ids.length})` : "no"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : null}
    </section>
  );
}
