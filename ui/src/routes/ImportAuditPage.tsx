import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { importAuditLog, ImportAuditLogError } from "../lib/api";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error-400"; message: string }
  | { kind: "error-network"; message: string };

const IDLE: SubmitState = { kind: "idle" };

export default function ImportAuditPage() {
  const [runDir, setRunDir] = useState("");
  const [runId, setRunId] = useState("");
  const [submit, setSubmit] = useState<SubmitState>(IDLE);
  const navigate = useNavigate();

  const submitting = submit.kind === "submitting";
  const canSubmit = runDir.trim().length > 0 && !submitting;

  async function onImport(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmit({ kind: "submitting" });
    try {
      const res = await importAuditLog({
        run_dir: runDir.trim(),
        ...(runId.trim() ? { run_id: runId.trim() } : {}),
      });
      navigate(`/runs/${encodeURIComponent(res.run_id)}`);
    } catch (err) {
      if (err instanceof ImportAuditLogError) {
        setSubmit({ kind: "error-400", message: err.message });
        return;
      }
      const msg = err instanceof Error ? err.message : "couldn't reach server";
      setSubmit({ kind: "error-network", message: msg });
    }
  }

  return (
    <section>
      <h1>Import audit log</h1>
      <p className="muted">
        Paste the path to a local{" "}
        <code>.guild/runs/&lt;run-id&gt;</code> directory. The server will copy
        the artifacts, score the run, and redirect you to the run detail page.
      </p>

      <form onSubmit={onImport} style={{ maxWidth: 560 }}>
        <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <label htmlFor="run-dir-input">
            <strong>Run directory</strong>{" "}
            <span className="muted">(required)</span>
            <input
              id="run-dir-input"
              data-testid="run-dir-input"
              type="text"
              value={runDir}
              onChange={(e) => {
                setRunDir(e.target.value);
                setSubmit(IDLE);
              }}
              placeholder="/path/to/project/.guild/runs/run-abc123"
              style={{ display: "block", width: "100%", marginTop: 4 }}
              disabled={submitting}
            />
          </label>

          <label htmlFor="run-id-input">
            <strong>Benchmark run id</strong>{" "}
            <span className="muted">(optional — auto-generated if blank)</span>
            <input
              id="run-id-input"
              data-testid="run-id-input"
              type="text"
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value);
                setSubmit(IDLE);
              }}
              placeholder="audit-run-abc123"
              style={{ display: "block", width: "100%", marginTop: 4 }}
              disabled={submitting}
            />
          </label>

          <div>
            <button
              type="submit"
              disabled={!canSubmit}
              aria-busy={submitting || undefined}
              data-testid="import-button"
            >
              {submitting ? "Importing…" : "Import"}
            </button>
          </div>

          {submit.kind === "error-400" ? (
            <div className="error" role="alert" data-testid="import-error-400">
              {submit.message}
            </div>
          ) : null}

          {submit.kind === "error-network" ? (
            <div className="error" role="alert" data-testid="import-error-network">
              Couldn't reach server: {submit.message}
            </div>
          ) : null}
        </div>
      </form>
    </section>
  );
}
