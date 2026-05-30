// LifecycleTimeline.test.tsx
//
// SC-9: lifecycle-timeline rendering test.
// TDD RED phase — written BEFORE the component exists.
//
// Tests cover:
//   1. Renders a timeline section heading + one row per TimelineEntry.
//   2. Renders the entry kind, label, and timestamp.
//   3. Renders duration_ms when present.
//   4. Handles an empty timeline gracefully (shows "no lifecycle data" notice).
//   5. Renders run_started / run_closed markers distinctly.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LifecycleTimeline } from "../components/LifecycleTimeline";
import type { TimelineEntry } from "../../../src/types";

const SAMPLE_ENTRIES: TimelineEntry[] = [
  {
    at: "2026-05-01T10:00:00Z",
    kind: "run_started",
    label: "run_started",
    detail: { run_id: "run-learn-001" },
  },
  {
    at: "2026-05-01T10:01:00Z",
    kind: "phase",
    label: "detect",
  },
  {
    at: "2026-05-01T10:05:00Z",
    kind: "phase",
    label: "learn (end)",
    duration_ms: 240000,
    detail: { status: "completed" },
  },
  {
    at: "2026-05-01T10:08:30Z",
    kind: "specialist_dispatch",
    label: "wiki-ingest",
    detail: { task_id: "T1", lane_id: "W1" },
  },
  {
    at: "2026-05-01T10:09:00Z",
    kind: "gate",
    label: "post-learn",
    detail: { decision: "approve", source: "user" },
  },
  {
    at: "2026-05-01T10:10:00Z",
    kind: "run_closed",
    label: "run_closed",
    detail: { run_id: "run-learn-001" },
  },
];

describe("LifecycleTimeline", () => {
  it("renders a heading and one row per TimelineEntry", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    expect(
      screen.getByRole("heading", { name: /lifecycle timeline/i }),
    ).toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    // 1 header row + 6 data rows
    expect(rows).toHaveLength(7);
  });

  it("renders the kind, label, and timestamp for each entry", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    // run_started row
    expect(screen.getByTestId("timeline-kind-0")).toHaveTextContent("run_started");
    expect(screen.getByTestId("timeline-label-0")).toHaveTextContent("run_started");
    expect(screen.getByTestId("timeline-at-0")).toHaveTextContent(
      "2026-05-01T10:00:00Z",
    );

    // phase detect row
    expect(screen.getByTestId("timeline-kind-1")).toHaveTextContent("phase");
    expect(screen.getByTestId("timeline-label-1")).toHaveTextContent("detect");

    // gate row
    expect(screen.getByTestId("timeline-kind-4")).toHaveTextContent("gate");
    expect(screen.getByTestId("timeline-label-4")).toHaveTextContent("post-learn");
  });

  it("renders duration_ms formatted when present, dash when absent", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    // Entry index 2 has duration_ms: 240000 (= 240 s = 4 min)
    expect(screen.getByTestId("timeline-duration-2")).toHaveTextContent("240.0 s");

    // Entry index 1 (detect) has no duration_ms
    expect(screen.getByTestId("timeline-duration-1")).toHaveTextContent("—");
  });

  it("renders an empty-state notice when entries array is empty", () => {
    render(<LifecycleTimeline entries={[]} />);

    expect(screen.getByTestId("lifecycle-timeline-empty")).toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-timeline-empty")).toHaveTextContent(
      /no lifecycle data/i,
    );
    // No table should be rendered
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders run_started and run_closed rows with their kind set", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    expect(screen.getByTestId("timeline-kind-0")).toHaveTextContent("run_started");
    expect(screen.getByTestId("timeline-kind-5")).toHaveTextContent("run_closed");
  });

  it("renders specialist_dispatch kind in the label column", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    expect(screen.getByTestId("timeline-kind-3")).toHaveTextContent(
      "specialist_dispatch",
    );
    expect(screen.getByTestId("timeline-label-3")).toHaveTextContent("wiki-ingest");
  });

  // SC9-1: a malformed record (null / undefined / non-object element in the
  // timeline) must NOT crash the whole render. Malformed elements are skipped;
  // valid ones still render.
  it("skips malformed (null/undefined/non-object) entries without crashing", () => {
    const mixed = [
      null,
      {
        at: "2026-05-01T10:00:00Z",
        kind: "phase",
        label: "valid-entry",
      },
      undefined,
      "not-an-object",
      42,
      {
        at: "2026-05-01T10:05:00Z",
        kind: "gate",
        label: "second-valid",
        detail: { decision: "approve" },
      },
    ] as unknown as TimelineEntry[];

    // Must not throw.
    render(<LifecycleTimeline entries={mixed} />);

    // Only the two valid entries are rendered (indices 0 and 1 after filtering).
    expect(screen.getByTestId("timeline-label-0")).toHaveTextContent("valid-entry");
    expect(screen.getByTestId("timeline-label-1")).toHaveTextContent("second-valid");
    // 1 header row + 2 valid data rows = 3 rows total.
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  // SC9-1: an entry missing a string `kind` or `at` is also treated as
  // malformed and skipped (defends the kindColor switch + at cell).
  it("skips entries lacking a string kind", () => {
    const mixed = [
      { at: "2026-05-01T10:00:00Z", label: "no-kind" },
      { at: "2026-05-01T10:01:00Z", kind: "phase", label: "has-kind" },
    ] as unknown as TimelineEntry[];

    render(<LifecycleTimeline entries={mixed} />);

    expect(screen.getByTestId("timeline-label-0")).toHaveTextContent("has-kind");
    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1 valid row
  });

  // SC9-2: the `detail` payload (gate decisions, task/lane ids, phase status,
  // escalation choices) must be surfaced, not silently dropped.
  it("renders the detail payload when present", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    // Entry index 3 (specialist_dispatch) has detail { task_id: "T1", lane_id: "W1" }
    const detail3 = screen.getByTestId("timeline-detail-3");
    expect(detail3).toHaveTextContent("task_id");
    expect(detail3).toHaveTextContent("T1");
    expect(detail3).toHaveTextContent("lane_id");
    expect(detail3).toHaveTextContent("W1");

    // Entry index 4 (gate) has detail { decision: "approve", source: "user" }
    const detail4 = screen.getByTestId("timeline-detail-4");
    expect(detail4).toHaveTextContent("decision");
    expect(detail4).toHaveTextContent("approve");
    expect(detail4).toHaveTextContent("source");
    expect(detail4).toHaveTextContent("user");
  });

  // SC9-2: detail cell is empty (no stray content) when the entry has no detail.
  it("renders an empty detail cell when detail is absent", () => {
    render(<LifecycleTimeline entries={SAMPLE_ENTRIES} />);

    // Entry index 1 (detect phase) has no detail.
    const detail1 = screen.getByTestId("timeline-detail-1");
    expect(detail1).toHaveTextContent("—");
  });

  // SC9-2 (codex): a circular-reference object detail value must not crash the
  // render — JSON.stringify throws on circular refs, so it's wrapped in try/catch.
  it("renders a fallback for a circular-reference detail value without throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const entries = [
      { at: "2026-05-01T10:00:00Z", kind: "phase", label: "circ", detail: { bad: circular } },
    ] as unknown as TimelineEntry[];

    // Must not throw.
    render(<LifecycleTimeline entries={entries} />);

    const detail0 = screen.getByTestId("timeline-detail-0");
    expect(detail0).toHaveTextContent("bad");
    expect(detail0).toHaveTextContent("[object]");
  });
});
