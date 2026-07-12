// LifecycleTimeline.tsx — SC-9: renders the entry-to-close timeline from
// lifecycle-timeline.ts. Matches the existing dashboard's React + CSS-variable
// pattern. Pure presentational component; receives already-fetched TimelineEntry[].

import type { TimelineEntry } from "../../../src/types";

interface Props {
  entries: TimelineEntry[];
}

function fmtDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// Color-code by entry kind so the timeline is scannable at a glance.
function kindColor(kind: TimelineEntry["kind"]): string {
  switch (kind) {
    case "run_started":
    case "run_closed":
      return "var(--status-pass-fg)";
    case "phase":
      return "var(--color-link)";
    case "gate":
      return "var(--status-timeout-fg)";
    case "specialist_dispatch":
    case "specialist_receipt":
      return "var(--color-fg-muted)";
    case "escalation":
    case "tool_call":
      return "var(--status-fail-fg)";
    default:
      return "inherit";
  }
}

// SC9-1: a malformed record element (null / undefined / non-object, or one
// missing the required string `kind` / `at`) must not crash the render. We
// filter to well-formed entries and skip the rest rather than dereferencing
// `entry.at`/`entry.kind`/`entry.label` blindly.
function isWellFormed(entry: unknown): entry is TimelineEntry {
  if (entry === null || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return typeof e.kind === "string" && typeof e.at === "string";
}

// SC9-2: render the optional `detail` payload as compact `key: value` pairs so
// gate decisions, specialist task/lane ids, phase status, and escalation
// choices are surfaced rather than silently dropped. React escapes all values
// (no dangerouslySetInnerHTML), so run-local data is XSS-safe.
function formatDetail(detail: TimelineEntry["detail"]): string {
  if (!detail || typeof detail !== "object") return "—";
  const parts = Object.entries(detail).map(([k, v]) => {
    let value: string;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      value = String(v);
    } else {
      // JSON.stringify throws on circular references — fall back rather than crash.
      try {
        value = JSON.stringify(v) ?? "[object]";
      } catch {
        value = "[object]";
      }
    }
    return `${k}: ${value}`;
  });
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export function LifecycleTimeline({ entries }: Props) {
  const safeEntries = (Array.isArray(entries) ? entries : []).filter(isWellFormed);
  return (
    <section>
      <h2>Lifecycle timeline</h2>
      {safeEntries.length === 0 ? (
        <p
          data-testid="lifecycle-timeline-empty"
          className="muted"
          style={{ textAlign: "center", padding: "var(--space-5)" }}
        >
          No lifecycle data — this run was not imported via the lifecycle importer.
        </p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            aria-label="Lifecycle timeline"
            data-testid="lifecycle-timeline-table"
          >
            <thead>
              <tr>
                <th>Time (UTC)</th>
                <th>Kind</th>
                <th>Label</th>
                <th>Duration</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {safeEntries.map((entry, i) => (
                <tr key={i} data-testid={`timeline-row-${i}`}>
                  <td
                    data-testid={`timeline-at-${i}`}
                    style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}
                  >
                    {entry.at || "—"}
                  </td>
                  <td
                    data-testid={`timeline-kind-${i}`}
                    style={{ color: kindColor(entry.kind), whiteSpace: "nowrap" }}
                  >
                    {entry.kind}
                  </td>
                  <td data-testid={`timeline-label-${i}`}>
                    {typeof entry.label === "string" ? entry.label : "—"}
                  </td>
                  <td
                    data-testid={`timeline-duration-${i}`}
                    style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}
                  >
                    {fmtDuration(entry.duration_ms)}
                  </td>
                  <td
                    data-testid={`timeline-detail-${i}`}
                    className="muted"
                    style={{ fontFamily: "var(--font-mono)", fontSize: "12px" }}
                  >
                    {formatDetail(entry.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
