import type { ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  EvidenceSummary,
  LineageAttempt,
  LineageExecution,
  LineageOperation,
  LineageRun,
  LineageTransfer,
  ProjectRunLineageResponse,
  StateAxes,
  UsageView,
} from "../../../src/run-lineage-types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";
import "../styles/run-lineage.css";

// P05 run lineage (U01). Read-only view of one logical run: executions,
// task attempts, transfers, operations and usage. The run's own four state
// axes are the only source of run status; a dispatch receipt or a host exit is
// shown as what it is, never as run success. No control here mutates anything.

type Available = Extract<ProjectRunLineageResponse, { status: "available" }>;

/** The run status the page shows. Only the logical run's own state axes count. */
export function displayedRunState(run: LineageRun): StateAxes {
  return run.state;
}

/** A response belongs to this view only if it answers this exact (run, guild) request. */
export function correlates(data: ProjectRunLineageResponse, runId: string, guild: string | undefined): boolean {
  return data.requested.run_id === runId && data.requested.guild === (guild ?? null);
}

const AXES: { key: keyof StateAxes; label: string }[] = [
  { key: "lifecycle", label: "Lifecycle" },
  { key: "outcome", label: "Outcome" },
  { key: "acceptance", label: "Acceptance" },
  { key: "observability", label: "Observability" },
];

function Axes({ state, testid }: { state: StateAxes; testid: string }) {
  return (
    <dl className="ln-axes" data-testid={testid}>
      {AXES.map((a) => (
        <div key={a.key} className="ln-axis" data-axis={a.key} data-value={state[a.key]}>
          <dt>{a.label}</dt>
          <dd data-testid={`${testid}-${a.key}`}>{state[a.key]}</dd>
        </div>
      ))}
    </dl>
  );
}

function Hash({ value }: { value: string | null }) {
  return value === null ? <span className="ln-missing">none</span> : <code className="ln-hash">{value}</code>;
}

function Evidence({ e }: { e: EvidenceSummary }) {
  return (
    <span className="ln-evidence" data-availability={e.availability}>
      <span className="ln-badge">{e.availability}</span> <code className="ln-hash">{e.sha256}</code>
      {e.reason ? <span className="ln-k"> · {e.reason}</span> : null}
    </span>
  );
}

function Num({ v, unit }: { v: number | null; unit?: string }) {
  return v === null ? <span className="ln-missing">missing</span> : <>{unit === "$" ? `$${v.toFixed(4)}` : v.toLocaleString("en-US")}</>;
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="ln-region" aria-labelledby={`${id}-h`} data-testid={id}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

function RunSummary({ run }: { run: LineageRun }) {
  return (
    <Section id="ln-run" title="Logical run">
      <Axes state={displayedRunState(run)} testid="ln-run-state" />
      <dl className="ln-pins">
        <dt>Source</dt>
        <dd>
          <code>{run.source_id}</code>
        </dd>
        <dt>Revision</dt>
        <dd>
          <Hash value={run.revision} />
        </dd>
        <dt>Phase</dt>
        <dd>{run.phase}</dd>
        <dt>Created</dt>
        <dd>{run.created_at}</dd>
        <dt>Controller</dt>
        <dd data-testid="ln-controller">
          <code>{run.controller.host_id}</code> · epoch {run.controller.epoch} · {run.controller.state}
        </dd>
        <dt>Initiative</dt>
        <dd>{run.initiative_id ?? <span className="ln-missing">none</span>}</dd>
        <dt>Parent run</dt>
        <dd>{run.parent_run ? <code>{run.parent_run.id}</code> : <span className="ln-missing">none</span>}</dd>
        <dt>Initial command</dt>
        <dd>
          <code className="ln-text" data-testid="ln-command">
            {run.initial_command}
          </code>
        </dd>
        <dt>Initial prompt</dt>
        <dd data-testid="ln-prompt">{run.initial_prompt ? <Evidence e={run.initial_prompt} /> : <span className="ln-missing">not recorded</span>}</dd>
        <dt>Workflow pin</dt>
        <dd>
          <Hash value={run.workflow_hash} />
        </dd>
        <dt>Settings pin</dt>
        <dd>
          <Hash value={run.settings_hash} />
        </dd>
      </dl>
    </Section>
  );
}

function ExecutionRow({ e, run }: { e: LineageExecution; run: LineageRun }) {
  return (
    <li className="ln-card" data-testid={`ln-execution-${e.source_id}-${e.execution_id}`}>
      <h3>
        Execution <code>{e.execution_id}</code>
      </h3>
      <p>
        <span className="ln-k">Host</span> <code>{e.original_host_id}</code> · <span className="ln-k">session</span>{" "}
        {e.host_session_id ? <code>{e.host_session_id}</code> : <span className="ln-missing">unknown</span>} ·{" "}
        <span className="ln-k">epoch</span> {e.issued_controller_epoch} · <span className="ln-k">admission</span> {e.admission}
      </p>
      <p>
        <span className="ln-k">Interval</span> {e.interval.start} → {e.interval.end ?? <span className="ln-missing">open</span>} ·{" "}
        <span className="ln-k">clock</span> {e.interval.clock_basis}
      </p>
      <p data-testid="ln-seal">
        {e.seal ? (
          <>
            Segment sealed ({e.seal.outcome_state}) at {e.seal.sealed_at}.{" "}
            <strong>Host exit closes this segment only; the logical run is {run.state.lifecycle}.</strong>
            {e.seal.matches_segment ? null : <span className="ln-warn"> Seal names a different segment revision.</span>}
          </>
        ) : (
          <span className="ln-k">Segment not sealed.</span>
        )}
      </p>
      <p>
        <span className="ln-k">Definition pin</span> <Hash value={e.pins.definition} />
      </p>
    </li>
  );
}

function AttemptRow({ a }: { a: LineageAttempt }) {
  return (
    <li className="ln-card" data-testid={`ln-attempt-${a.source_id}-${a.attempt_id}`}>
      <h3>
        Attempt <code>{a.attempt_id}</code> · #{a.ordinal}
      </h3>
      <p>
        <span className="ln-k">Task</span> {a.logical_task_id ? <code>{a.logical_task_id}</code> : <span className="ln-missing">none</span>} ·{" "}
        <span className="ln-k">execution</span> <code>{a.execution_id}</code> · <span className="ln-k">agent</span>{" "}
        {a.agent_instance_id ? <code>{a.agent_instance_id}</code> : <span className="ln-missing">unknown</span>}
      </p>
      <Axes state={a.state} testid={`ln-attempt-state-${a.attempt_id}`} />
      <p>
        <span className="ln-k">Handoff (assignment)</span> <Evidence e={a.assignment} />
      </p>
      <p>
        <span className="ln-k">Results</span>{" "}
        {a.results.length === 0 ? <span className="ln-missing">none recorded</span> : a.results.map((r, i) => <Evidence key={i} e={r} />)}
      </p>
      <p>
        <span className="ln-k">Accepted by epoch</span>{" "}
        {a.accepted_by_controller_epoch === null ? <span className="ln-missing">not accepted</span> : a.accepted_by_controller_epoch} ·{" "}
        <span className="ln-k">receipt loss</span> {a.receipt_loss_reconciled ? "reconciled" : "unreconciled"} ·{" "}
        <span className="ln-k">effects</span> {a.uncertain_effects ? "uncertain" : "certain"}
      </p>
    </li>
  );
}

function UsageBlock({ usage }: { usage: UsageView }) {
  if (usage.status === "missing" || usage.status === "refused") {
    return (
      <p className="ln-missing" data-testid="ln-usage-status" data-status={usage.status}>
        Usage {usage.status}: {usage.reason}
      </p>
    );
  }
  return (
    <>
      <p data-testid="ln-usage-status" data-status={usage.status}>
        Usage {usage.status === "partial" ? "partial (some values missing; nothing is filled in)" : "available"} · analysis{" "}
        <code>{usage.analysis_id}</code>
      </p>
      <div className="ln-scroll">
        <table className="ln-table">
          <caption className="ln-k">Per accounting identity; missing values stay missing.</caption>
          <thead>
            <tr>
              <th scope="col">Identity</th>
              <th scope="col">Inclusion</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Total</th>
              <th scope="col">Cost</th>
              <th scope="col">Basis</th>
            </tr>
          </thead>
          <tbody>
            {usage.entries.map((u, i) => (
              <tr key={`${u.accounting_identity}-${i}`} data-testid={`ln-usage-${u.accounting_identity}`}>
                <td>
                  <code>{u.accounting_identity}</code>
                  {u.final ? null : <span className="ln-k"> (not final)</span>}
                </td>
                <td>{u.inclusion}</td>
                <td>
                  <Num v={u.input_inclusive} />
                </td>
                <td>
                  <Num v={u.output} />
                </td>
                <td>
                  <Num v={u.total} />
                </td>
                <td>
                  <Num v={u.cost_usd} unit="$" />
                </td>
                <td>{u.cost_basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {usage.losses.length > 0 ? (
        <ul className="ln-list">
          {usage.losses.map((l) => (
            <li key={l.code}>
              Loss <code>{l.code}</code>: {l.count === null ? "count unknown" : l.count} · {l.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function TransferRow({ t }: { t: LineageTransfer }) {
  return (
    <li className="ln-card" data-testid={`ln-transfer-${t.operation_id}`} data-state={t.state}>
      <h3>
        Transfer <code>{t.operation_id}</code> · {t.state}
      </h3>
      <p>
        <code>{t.source_work.kind}:{t.source_work.id}</code> → <code>{t.destination_work.source_id}</code> /{" "}
        <code>{t.destination_work.kind}:{t.destination_work.id}</code>
      </p>
      <p>
        <span className="ln-k">Stages</span> {t.stages.join(" → ")} · <span className="ln-k">recorded</span> {t.recorded_at}
      </p>
      <p>
        <span className="ln-k">Target acknowledgement</span> {t.target_ack ? <Evidence e={t.target_ack} /> : <span className="ln-missing">not acknowledged</span>}
      </p>
    </li>
  );
}

const RECEIPT_LABEL: Record<NonNullable<LineageOperation["receipt"]>["state"], string> = {
  accepted: "Accepted for processing. This is not an outcome.",
  running: "Running. No outcome yet.",
  applied: "Applied.",
  failed: "Failed.",
  recovery_needed: "Recovery needed.",
};

function OperationRow({ o }: { o: LineageOperation }) {
  return (
    <li className="ln-card" data-testid={`ln-operation-${o.operation_id}`}>
      <h3>
        Operation <code>{o.operation_id}</code> {o.operation ? <>· {o.operation}</> : null}
      </h3>
      <p data-testid={`ln-authority-${o.operation_id}`} data-status={o.authority.status}>
        {o.authority.status === "pins_current" ? (
          "Pins current: the approval binds this exact preview and every pinned revision still matches. Policy and grant admission are the controller's; this view does not authorize."
        ) : (
          <>
            <strong>Stale.</strong> {o.authority.codes.join(", ")}
          </>
        )}
      </p>
      <p>
        <span className="ln-k">Preview</span> <Hash value={o.preview_hash} /> · <span className="ln-k">epoch</span>{" "}
        {o.controller_epoch ?? <span className="ln-missing">unknown</span>} · <span className="ln-k">expires</span>{" "}
        {o.expires_at ?? <span className="ln-missing">unknown</span>}
      </p>
      {o.targets.length > 0 ? (
        <ul className="ln-list">
          {o.targets.map((t) => (
            <li key={`${t.source_id}-${t.kind}-${t.id}`}>
              <span className="ln-k">target</span> <code>{t.source_id}</code> / <code>{t.kind}:{t.id}</code> @ <Hash value={t.revision} />
            </li>
          ))}
          {o.dependencies.map((t) => (
            <li key={`d-${t.source_id}-${t.kind}-${t.id}`}>
              <span className="ln-k">dependency</span> <code>{t.source_id}</code> / <code>{t.kind}:{t.id}</code> @ <Hash value={t.revision} />
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <span className="ln-k">Approval</span>{" "}
        {o.approval ? `${o.approval.decision} by ${o.approval.actor_label} at ${o.approval.at}` : <span className="ln-missing">none</span>}
      </p>
      <p data-testid={`ln-receipt-${o.operation_id}`} data-state={o.receipt?.state ?? "none"}>
        <span className="ln-k">Receipt</span>{" "}
        {o.receipt ? (
          <>
            {o.receipt.effect_kind}: {RECEIPT_LABEL[o.receipt.state]}
            {o.receipt.correlation === "correlated" ? null : <span className="ln-warn"> Receipt does not match this preview.</span>}
          </>
        ) : (
          <span className="ln-missing">none</span>
        )}
      </p>
    </li>
  );
}

function LineageBody({ d }: { d: Available }) {
  return (
    <>
      <p className="ln-k" data-testid="ln-snapshot">
        Source <code>{d.source_guild}</code> · snapshot <code className="ln-hash">{d.input_revision}</code>
      </p>
      <RunSummary run={d.run} />
      <Section id="ln-blockers" title="Close blockers">
        <p className="ln-k">Derived from the records on disk. The controller makes the close decision.</p>
        {d.close_blockers.length === 0 ? (
          <p>None found.</p>
        ) : (
          <ul className="ln-list">
            {d.close_blockers.map((b, i) => (
              <li key={i} data-testid={`ln-blocker-${b.code}`}>
                <code>{b.code}</code> · {b.subject}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section id="ln-executions" title="Executions">
        {d.executions.length === 0 ? (
          <p className="ln-missing">No execution segments recorded.</p>
        ) : (
          <ul className="ln-cards">
            {d.executions.map((e) => (
              <ExecutionRow key={`${e.source_id}-${e.execution_id}`} e={e} run={d.run} />
            ))}
          </ul>
        )}
      </Section>
      <Section id="ln-attempts" title="Task attempts">
        {d.attempts.length === 0 ? (
          <p className="ln-missing">No task attempts recorded.</p>
        ) : (
          <ul className="ln-cards">
            {d.attempts.map((a) => (
              <AttemptRow key={`${a.source_id}-${a.attempt_id}`} a={a} />
            ))}
          </ul>
        )}
      </Section>
      <Section id="ln-usage" title="Usage">
        <UsageBlock usage={d.usage} />
      </Section>
      <Section id="ln-transfers" title="Follow-up transfers">
        {d.transfers.length === 0 ? (
          <p className="ln-k">No transfers recorded.</p>
        ) : (
          <ul className="ln-cards">
            {d.transfers.map((t) => (
              <TransferRow key={t.operation_id} t={t} />
            ))}
          </ul>
        )}
      </Section>
      <Section id="ln-operations" title="Operations">
        <p className="ln-k" data-testid="ln-controls-unavailable">
          Operation controls are unavailable: no qualified operation capability is installed. This view only reads.
        </p>
        {d.operations.length === 0 ? null : (
          <ul className="ln-cards">
            {d.operations.map((o) => (
              <OperationRow key={o.operation_id} o={o} />
            ))}
          </ul>
        )}
      </Section>
      {d.refused.length > 0 ? (
        <Section id="ln-refused" title="Refused records">
          <ul className="ln-list">
            {d.refused.map((r, i) => (
              <li key={i}>
                <code>{r.file}</code> · {r.reason}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

export default function RunLineagePage() {
  const { run_id: runId } = useParams<{ run_id: string }>();
  const [searchParams] = useSearchParams();
  const guild = searchParams.get("guild") ?? undefined;
  const { data, status, error } = useFetch<ProjectRunLineageResponse>(runId ? api.projectRunLineage(runId, guild) : null);
  const back = runId ? `/project-runs/${encodeURIComponent(runId)}${guild ? `?guild=${encodeURIComponent(guild)}` : ""}` : "/runs";
  const ok = status === "success" && data !== undefined && runId !== undefined;
  const matches = ok && correlates(data, runId, guild);

  return (
    <section className="ln-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Run lineage</p>
          <h1>
            Run <code>{runId}</code>
          </h1>
        </div>
        <Link to={back}>Back to run</Link>
      </header>
      {status === "loading" ? <div className="loading">Loading lineage...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {error?.message ?? "failed to load lineage"}
        </div>
      ) : null}
      {ok && !matches ? (
        <div className="error" role="alert" data-testid="ln-uncorrelated">
          The response answers a different run or source. Nothing is shown.
        </div>
      ) : null}
      {matches && data.status !== "available" ? (
        <p className="ln-missing" data-testid="ln-status" data-status={data.status}>
          Lineage {data.status}: {data.reason}
        </p>
      ) : null}
      {matches && data.status === "available" ? <LineageBody d={data} /> : null}
    </section>
  );
}
