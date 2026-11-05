import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  ProjectRunWorkflowResponse,
  WorkflowEvidence,
  WorkflowInvocation,
  WorkflowNode,
  WorkflowObligation,
  WorkflowProjectionV2,
} from "../../../src/workflow-projection-types";
import { useFetch } from "../hooks/useFetch";
import { api } from "../lib/api";
import "../styles/workflow-inspector.css";

// P06 composed workflow inspector (U02). Read-only view of one run's C8
// WorkflowProjection v2. The compiled definition and this run's execution
// overlay render in separate regions; nothing here can edit either.

const VIEWS = [
  { id: "expanded", label: "Expanded graph" },
  { id: "components", label: "Components" },
  { id: "text", label: "Text" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

/** Rules AT41 holds the rendered inspector to. Empty means the DOM complies. */
export function inspectorContractViolations(root: ParentNode): string[] {
  const out: string[] = [];
  const defs = Array.from(root.querySelectorAll('[data-testid="wf-definition"]'));
  if (defs.some((d) => d.querySelector('[data-testid="wf-overlay"]'))) out.push("overlay is nested inside the definition");
  if (defs.some((d) => d.querySelector('[data-testid^="wf-invocation-"], [data-testid^="wf-obligation-"]'))) {
    out.push("overlay content inside the definition");
  }
  if (root.querySelector("input, textarea, select, form, [contenteditable]")) out.push("editable control present");
  const buttons = Array.from(root.querySelectorAll("button"));
  if (buttons.some((b) => (b.type === "submit" && b.closest("form") !== null) || /\b(save|edit|apply|delete|submit|update|write|persist)\b/i.test(b.textContent ?? ""))) {
    out.push("mutating action present");
  }
  return out;
}

/** Nodes in breadth-first order from entry; unreachable nodes follow in document order. */
function orderedNodes(p: WorkflowProjectionV2): WorkflowNode[] {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([p.entry]);
  const queue = [p.entry];
  const order: WorkflowNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;
    order.push(node);
    for (const e of p.edges) {
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return [...order, ...p.nodes.filter((n) => !seen.has(n.id))];
}

function next(p: WorkflowProjectionV2, id: string): string {
  const edges = p.edges.filter((e) => e.from === id);
  return edges.length === 0 ? "none" : edges.map((e) => `${e.to} (${e.on})`).join(", ");
}

function componentLabel(p: WorkflowProjectionV2, n: WorkflowNode): string {
  const comp = p.components.find((c) => c.id === n.component_id);
  return comp ? `${comp.id}@${comp.version}` : `${n.component_id} (not in component list)`;
}

function ports(list: { name: string; type: string }[]): string {
  return list.length === 0 ? "none declared" : list.map((x) => `${x.name}: ${x.type}`).join(", ");
}

function nodeTags(n: WorkflowNode): string[] {
  const tags: string[] = [n.effect];
  if (n.gate_role) tags.push(`protected gate ${n.gate_role}`);
  if (n.within_gate) tags.push(`inside ${n.within_gate} gate`);
  tags.push(n.required ? "required" : "optional");
  return tags;
}

export function workflowText(p: WorkflowProjectionV2): string {
  const lines = [
    `workflow ${p.workflow.id} (${p.workflow.source_id}) class ${p.class}`,
    `revision ${p.workflow.revision}`,
    `definition ${p.definition_hash}`,
    `compiler ${p.compiler_hash}`,
    `policy ${p.policy_hash}`,
    `expanded ${p.expanded_hash}`,
    `entry ${p.entry}`,
    `protected gates ${p.protected_gates.length === 0 ? "none" : p.protected_gates.join(", ")}`,
    "components",
    ...p.components.map((c) => `  ${c.id}@${c.version} ${c.sha256}`),
    "nodes",
  ];
  for (const n of orderedNodes(p)) {
    const scope = [n.effect, n.gate_role ? `protected gate ${n.gate_role}` : "", n.within_gate ? `inside ${n.within_gate}` : "", n.required ? "" : "optional"]
      .filter(Boolean)
      .join(", ");
    lines.push(`  ${n.id} [${scope}] -> ${next(p, n.id)}`);
    lines.push(`    component ${componentLabel(p, n)} ${n.component_hash}; role ${n.role}`);
    lines.push(`    inputs ${ports(n.inputs)}; outputs ${ports(n.outputs)}`);
  }
  return lines.join("\n");
}

function Hash({ value }: { value: string }) {
  return <code className="wf-hash">{value}</code>;
}

function DefinitionPins({ p }: { p: WorkflowProjectionV2 }) {
  const rows: [string, ReactNode][] = [
    ["Workflow", <code>{p.workflow.id}</code>],
    ["Source", <code>{p.workflow.source_id}</code>],
    ["Class", p.class],
    ["Revision", <Hash value={p.workflow.revision} />],
    ["Definition hash", <Hash value={p.definition_hash} />],
    ["Compiler hash", <Hash value={p.compiler_hash} />],
    ["Policy hash", <Hash value={p.policy_hash} />],
    ["Expanded hash", <Hash value={p.expanded_hash} />],
    ["Entry", <code>{p.entry}</code>],
    ["Protected gates", p.protected_gates.length === 0 ? "none" : p.protected_gates.join(", ")],
  ];
  return (
    <dl className="wf-pins">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function ExpandedView({ p }: { p: WorkflowProjectionV2 }) {
  return (
    <ol className="wf-nodes" data-testid="wf-view-expanded">
      {orderedNodes(p).map((n) => (
        <li key={n.id} className="wf-node" data-testid={`wf-node-${n.id}`} data-effect={n.effect}>
          <h4>
            <code>{n.id}</code>
          </h4>
          <ul className="wf-tags" aria-label="Node kind">
            {nodeTags(n).map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p>
            <span className="wf-k">Component:</span> <code>{componentLabel(p, n)}</code> <Hash value={n.component_hash} />
          </p>
          <p>
            <span className="wf-k">Role:</span> {n.role}
          </p>
          <p>
            <span className="wf-k">Capabilities:</span> {n.capabilities.length === 0 ? "none" : n.capabilities.join(", ")}
          </p>
          <p>
            <span className="wf-k">Inputs:</span> {ports(n.inputs)}
          </p>
          <p>
            <span className="wf-k">Outputs:</span> {ports(n.outputs)}
          </p>
          <p>
            <span className="wf-k">Next:</span> {next(p, n.id)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function ComponentsView({ p }: { p: WorkflowProjectionV2 }) {
  return (
    <ul className="wf-components" data-testid="wf-view-components">
      {p.components.map((c) => {
        const users = p.nodes.filter((n) => n.component_id === c.id).map((n) => n.id);
        return (
          <li key={c.id} className="wf-node" data-testid={`wf-component-${c.id}`}>
            <h4>
              <code>
                {c.id}@{c.version}
              </code>
            </h4>
            <p>
              <span className="wf-k">Hash:</span> <Hash value={c.sha256} />
            </p>
            <p>
              <span className="wf-k">Used by:</span> {users.length === 0 ? "no nodes" : users.join(", ")}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function ViewTabs({ p }: { p: WorkflowProjectionV2 }) {
  const [view, setView] = useState<ViewId>("expanded");
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const select = (id: ViewId) => {
    setView(id);
    refs.current[id]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = VIEWS.length - 1;
    const to = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(VIEWS[to].id);
  };
  return (
    <>
      <div role="tablist" aria-label="Definition view" className="wf-tabs">
        {VIEWS.map((v, i) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`wf-tab-${v.id}`}
            aria-controls={`wf-panel-${v.id}`}
            aria-selected={view === v.id}
            tabIndex={view === v.id ? 0 : -1}
            ref={(el) => {
              refs.current[v.id] = el;
            }}
            onClick={() => select(v.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`wf-panel-${view}`} aria-labelledby={`wf-tab-${view}`} tabIndex={0} className="wf-panel">
        {view === "expanded" ? <ExpandedView p={p} /> : null}
        {view === "components" ? <ComponentsView p={p} /> : null}
        {view === "text" ? (
          <pre className="wf-text" data-testid="wf-view-text">
            {workflowText(p)}
          </pre>
        ) : null}
      </div>
    </>
  );
}

function roundsLeft(inv: WorkflowInvocation): string {
  const left = inv.max_rounds - inv.round;
  return left <= 0 ? "Round budget used" : `${left} round${left === 1 ? "" : "s"} left`;
}

function Invocation({ inv }: { inv: WorkflowInvocation }) {
  return (
    <li className="wf-node" data-testid={`wf-invocation-${inv.id}`} data-state={inv.state}>
      <h4>
        <code>{inv.id}</code> <span className={`wf-state wf-state-${inv.state}`}>{inv.state}</span>
      </h4>
      <p>
        <span className="wf-k">Node:</span> <code>{inv.node_id}</code>
      </p>
      <p>
        <span className="wf-k">Loop:</span> Round {inv.round} of {inv.max_rounds} · {roundsLeft(inv)}
      </p>
      <p>
        <span className="wf-k">Unresolved questions:</span>{" "}
        {inv.unresolved_questions.length === 0 ? "none recorded" : inv.unresolved_questions.join(", ")}
      </p>
      <p>
        <span className="wf-k">Pinned definition:</span> <Hash value={inv.definition_hash} />
      </p>
      <p>
        <span className="wf-k">Subject:</span> <Hash value={inv.subject_hash} />
      </p>
    </li>
  );
}

function EvidenceItem({ e }: { e: WorkflowEvidence }) {
  const availability =
    e.availability === "available" ? "available" : `unavailable (${e.availability}): ${e.reason ?? "reason not recorded"}`;
  return (
    <>
      <code>{e.path}</code> <Hash value={e.sha256} /> · {e.schema_version} · observed {e.observed_at} · {availability}
    </>
  );
}

function Obligation({ ob }: { ob: WorkflowObligation }) {
  const invalid = ob.status === "invalidated";
  return (
    <li className={`wf-node wf-obligation${invalid ? " wf-invalid" : ""}`} data-testid={`wf-obligation-${ob.id}`} data-status={ob.status}>
      <h4>
        <code>{ob.id}</code> <span className={`wf-state wf-state-${ob.status}`}>{ob.status}</span>
      </h4>
      {invalid ? (
        <p className="wf-invalid-note" role="note">
          Invalidated: this evidence no longer counts.
        </p>
      ) : null}
      <p>
        <span className="wf-k">Kind:</span> {ob.kind} · <span className="wf-k">Node:</span> <code>{ob.node_id}</code> ·{" "}
        <span className="wf-k">Invocation:</span> <code>{ob.invocation_id}</code> · <span className="wf-k">Round:</span> {ob.round}
      </p>
      <p>
        <span className="wf-k">Authority:</span> {ob.authority} · <span className="wf-k">Subject:</span> <Hash value={ob.subject_hash} />
      </p>
      {ob.evidence.length === 0 ? (
        <p>No evidence recorded.</p>
      ) : (
        <ul className="wf-evidence" aria-label="Evidence">
          {ob.evidence.map((e) => (
            <li key={`${e.path}:${e.sha256}`}>
              {invalid ? (
                <s>
                  <EvidenceItem e={e} />
                </s>
              ) : (
                <EvidenceItem e={e} />
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Inspector({ p }: { p: WorkflowProjectionV2 }) {
  return (
    <>
      <section className="card wf-region" data-testid="wf-definition" aria-labelledby="wf-def-h">
        <h2 id="wf-def-h">Definition</h2>
        <p className="muted">Compiled and pinned for this run. Read-only.</p>
        <DefinitionPins p={p} />
        <ViewTabs p={p} />
      </section>
      <section className="card wf-region wf-overlay" data-testid="wf-overlay" aria-labelledby="wf-ovl-h">
        <h2 id="wf-ovl-h">Execution overlay</h2>
        <p className="muted">What this run did. Not part of the definition. Read-only.</p>
        <h3>Invocations</h3>
        {p.invocations.length === 0 ? (
          <p>No invocations recorded.</p>
        ) : (
          <ul className="wf-nodes">
            {p.invocations.map((inv) => (
              <Invocation key={inv.id} inv={inv} />
            ))}
          </ul>
        )}
        <h3>Assurance obligations</h3>
        {p.obligations.length === 0 ? (
          <p>No obligations recorded.</p>
        ) : (
          <ul className="wf-nodes">
            {p.obligations.map((ob) => (
              <Obligation key={ob.id} ob={ob} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function WorkflowInspectorPage() {
  const { run_id: runId } = useParams<{ run_id: string }>();
  const [searchParams] = useSearchParams();
  const guild = searchParams.get("guild") ?? undefined;
  const { data, error, status } = useFetch<ProjectRunWorkflowResponse>(runId ? api.projectRunWorkflow(runId, guild) : null);

  return (
    <section className="wf-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Composed workflow</p>
          <h1>
            Run <code>{runId}</code>
          </h1>
        </div>
        {runId ? <Link to={`/project-runs/${encodeURIComponent(runId)}${guild ? `?guild=${encodeURIComponent(guild)}` : ""}`}>Run detail</Link> : null}
      </header>
      {status === "loading" ? <div className="loading">Loading workflow...</div> : null}
      {status === "error" ? (
        <div className="error" role="alert">
          {error?.message ?? "failed to load workflow"}
        </div>
      ) : null}
      {status === "success" && data?.status === "unavailable" ? (
        <div className="empty" data-testid="wf-unavailable">
          Workflow unavailable: {data.reason}.
        </div>
      ) : null}
      {status === "success" && data?.status === "refused" ? (
        <div className="error" role="alert" data-testid="wf-refused">
          <p>This run's workflow projection was refused. Nothing from it is shown.</p>
          <ul>
            {data.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {status === "success" && data?.status === "available" ? <Inspector p={data.projection} /> : null}
    </section>
  );
}
