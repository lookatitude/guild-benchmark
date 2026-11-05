import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import MetricsPage from "../routes/MetricsPage";
import pageSource from "../routes/MetricsPage.tsx?raw";
import type { MetricReport, ServedEntry } from "../lib/metrics-types";
import fx from "./fixtures/metrics-u04.json";
import { installMockFetch, type MockFetchHandle } from "./fixtures/mockFetch";

// AT45/AT46 — the metrics view renders what POST /api/project/metrics/* returned.
// The fixture is real server output (tests/c9-metric-report.at45-46.test.ts "U04 ui
// fixture"): a workspace with an offline source, hosts, models and revisions.
const reportAll = fx.report_all as unknown as MetricReport;
const reportModel = fx.report_model as unknown as MetricReport;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let handle: MockFetchHandle | undefined;
const bodies: Record<string, unknown[]> = {};
function mount() {
  for (const k of Object.keys(bodies)) delete bodies[k];
  handle = installMockFetch({
    override: (u, init) => {
      const m = /\/api\/project\/metrics\/(\w+)$/.exec(u);
      if (!m) return undefined;
      const body = JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>;
      (bodies[m[1]!] ??= []).push(body);
      if (m[1] === "report") return json(body.group_by === "all" ? reportAll : reportModel);
      if (m[1] === "drilldown") return json(fx.drilldown);
      if (m[1] === "analysis") return json(fx.analysis);
      if (m[1] === "compare") return json(fx.compare);
      return json({ error: "unexpected" }, 500);
    },
  });
  render(
    <MemoryRouter>
      <MetricsPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  handle?.reset();
  vi.restoreAllMocks();
});

const show = (v: number | null) => (v === null ? "unknown" : String(v));
async function groupByModel(initiative = "") {
  await screen.findByTestId("metric-table");
  if (initiative) fireEvent.change(screen.getByLabelText(/Initiative/), { target: { value: initiative } });
  fireEvent.change(screen.getByLabelText(/Group by/), { target: { value: "observed_model" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(screen.getByTestId("report-scope")).toHaveTextContent("Grouped by observed_model"));
}
function open(metricId: string) {
  fireEvent.click(within(screen.getByTestId(`metric-${metricId}`)).getAllByRole("button")[0]!);
}

describe("AT45 · chart/report parity", () => {
  it("lists every catalog metric with its exact returned value, unit, coverage and formula version", async () => {
    mount();
    await screen.findByTestId("metric-table");
    expect(bodies.report).toEqual([{ group_by: "all" }]);
    expect(reportAll.metrics).toHaveLength(104);
    for (const m of reportAll.metrics) {
      const row = screen.getByTestId(`metric-${m.metric_id}`);
      expect(row).toHaveTextContent(m.formula_version);
      if (m.state === "refused") {
        expect(row).toHaveTextContent(`refused (${m.refusal.code})`);
        continue;
      }
      expect(row).toHaveTextContent(m.unit_label);
      // Exact values, unknown stays unknown (never 0).
      expect(within(row).getAllByRole("cell")[1]).toHaveTextContent(new RegExp(`^${show(m.points[0]!.value).replace(".", "\\.")}$`));
      expect(row).toHaveTextContent(`${m.coverage.state}:`);
    }
    expect(screen.getByTestId("metric-M02.elapsed_ms")).toHaveTextContent("unknown");
  });

  it("an unavailable source is shown, not hidden; omissions are listed", async () => {
    mount();
    const banner = await screen.findByTestId("unavailable-sources");
    expect(banner).toHaveTextContent("offline");
    expect(banner).toHaveTextContent("unknown, not zero");
    expect(screen.getByTestId("omissions")).toHaveTextContent(`Omissions (${reportAll.omissions.length})`);
  });

  it("detail shows formula, scope, missingness, cost basis; chart names unit, filters and grouping; table has exact values", async () => {
    mount();
    await groupByModel("init-1");
    expect(bodies.report![1]).toEqual({ group_by: "observed_model", filters: [{ dimension: "initiative", values: ["init-1"] }] });
    open("M09.total_tokens");
    const detail = screen.getByTestId("metric-detail");
    const e = reportModel.metrics.find((m) => m.metric_id === "M09.total_tokens") as ServedEntry;
    expect(detail).toHaveTextContent(e.formula);
    expect(detail).toHaveTextContent(e.scope);
    expect(detail).toHaveTextContent(e.missingness);
    expect(screen.getByTestId("cost-basis")).toHaveTextContent(e.cost_bases.join(", "));
    const caption = screen.getByTestId("chart-caption");
    expect(caption).toHaveTextContent(`Unit: ${e.unit_label} (${e.unit})`);
    expect(caption).toHaveTextContent("Filters: none");
    expect(caption).toHaveTextContent("Grouped by observed_model");
    for (const p of e.points) {
      const row = screen.getByTestId(`point-${p.key}`);
      const cells = within(row).getAllByRole("cell");
      expect(cells[1]).toHaveTextContent(new RegExp(`^${show(p.value)}$`));
      expect(cells[2]).toHaveTextContent(new RegExp(`^${show(p.known_subtotal)}$`));
      expect(cells[3]).toHaveTextContent(new RegExp(`^${show(p.exact_total)}$`));
    }
    expect(within(screen.getByTestId("point-model-w")).getAllByRole("cell")[1]).toHaveTextContent(/^unknown$/);
  });

  it("evidence drilldown sends the report's own pinned query and lists the request records", async () => {
    mount();
    await groupByModel();
    open("M09.total_tokens");
    fireEvent.click(screen.getByRole("button", { name: "Evidence for model-y" }));
    await screen.findByTestId("drilldown-records");
    const e = reportModel.metrics.find((m) => m.metric_id === "M09.total_tokens") as ServedEntry;
    const sent = bodies.drilldown![0] as { request: { query: unknown; query_hash: string; operation: string }; point_key: string; group_by: string };
    expect(sent.request.query).toEqual(e.query);
    expect(sent.request.query_hash).toBe(e.query_hash);
    expect(sent).toMatchObject({ point_key: "model-y", group_by: "observed_model", request: { operation: "metric_drilldown" } });
    expect(within(screen.getByTestId("drilldown-records")).getAllByRole("listitem")).toHaveLength(fx.drilldown.records.length);
  });

  it("the exported report is byte-for-byte the served report", async () => {
    let blob: Blob | undefined;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return "blob:report";
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    mount();
    await screen.findByTestId("metric-table");
    fireEvent.click(screen.getByRole("button", { name: "Export report (JSON)" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await blob!.text())).toEqual(reportAll);
  });

  it("has no frontend formula engine", () => {
    expect(pageSource).not.toMatch(/\.reduce\(|Math\.|computeMetricSeries|from "[^"]*\/c9\//);
  });
});

describe("AT46 · human analysis", () => {
  it("percentiles show their sample count; unknown stays unknown", async () => {
    mount();
    await groupByModel();
    open("M05.latency_p50_ms");
    expect(screen.getByTestId("sample-count")).toHaveTextContent("n = unknown");
    expect(screen.getByTestId("sample-count")).toHaveTextContent("M05.sample_count");
  });

  it("a derived estimate without pricing is a refusal with its reason, not a value", async () => {
    mount();
    await groupByModel();
    open("M10.derived_estimate_usd");
    expect(screen.getByTestId("metric-refused")).toHaveTextContent("input_unavailable");
  });

  it("ranking without declared difficulty is withheld; null usage is listed as unknown, never ranked", async () => {
    mount();
    await groupByModel();
    open("M09.total_tokens");
    fireEvent.change(screen.getByLabelText(/Difficulty of model-x/), { target: { value: "easy" } });
    fireEvent.click(screen.getByRole("button", { name: "Rank" }));
    const out = await screen.findByTestId("ranking-result");
    expect(bodies.analysis![0]).toMatchObject({ group_by: "observed_model", direction: "asc", difficulty: { "model-x": "easy" } });
    expect(out).toHaveTextContent("Not ranked: no declared task difficulty");
    expect(within(out).queryAllByRole("table")).toHaveLength(0);
    expect(screen.getByTestId("unranked")).toHaveTextContent("model-w not ranked (unknown)");
  });

  it("cohort comparison is descriptive only and shows why no difference is computed", async () => {
    mount();
    await groupByModel();
    open("M09.total_tokens");
    fireEvent.change(screen.getByLabelText(/^B/), { target: { value: "model-z" } });
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    const out = await screen.findByTestId("compare-result");
    expect(out).toHaveTextContent("Descriptive only");
    expect(out).toHaveTextContent("not a causal gain");
    expect(out).toHaveTextContent("not computed (a cohort has incomplete coverage)");
    expect(out).not.toHaveTextContent(/^Improvement/);
  });
});
