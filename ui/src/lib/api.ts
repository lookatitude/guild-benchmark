// Typed wrappers around fetch("/api/...") — purely URL builders so the
// useFetch hook can call them with a string. All requests are proxied via
// vite.config.ts in dev (→ http://127.0.0.1:3055) and served by the same
// backend in production.

import type {
  AuditLogImportRequest,
  AuditLogImportResponse,
  ProjectAnalysisRequest,
  ProjectAnalysisResponse,
  ProjectComparisonResponse,
  ProjectComparisonTargetsResponse,
  ProjectInitiativesResponse,
  ProjectRunDetailResponse,
  ProjectRunsListResponse,
  RunPostRequest,
  RunPostResponse,
} from "../../../src/types";

const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api";

export const api = {
  base: API_BASE,
  runs: (caseSlug?: string) =>
    caseSlug
      ? `${API_BASE}/runs?case=${encodeURIComponent(caseSlug)}`
      : `${API_BASE}/runs`,
  runDetail: (runId: string) => `${API_BASE}/runs/${encodeURIComponent(runId)}`,
  lifecycleRecord: (runId: string) =>
    `${API_BASE}/runs/${encodeURIComponent(runId)}/lifecycle-record`,
  artifact: (runId: string, path: string) =>
    `${API_BASE}/runs/${encodeURIComponent(runId)}/artifacts/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  comparison: (baseline: string, candidate: string) =>
    `${API_BASE}/comparisons/${encodeURIComponent(baseline)}/${encodeURIComponent(
      candidate,
    )}`,
  cases: () => `${API_BASE}/cases`,
  // SC-12 — live-project knowledge routes (active only when the server was
  // started with `serve --project-root <abs>`; 404 otherwise).
  projectOverview: () => `${API_BASE}/project/overview`,
  projectRuns: () => `${API_BASE}/project/runs`,
  projectRunDetail: (runId: string, guild?: string) =>
    `${API_BASE}/project/runs/${encodeURIComponent(runId)}${
      guild ? `?guild=${encodeURIComponent(guild)}` : ""
    }`,
  // One file under a live run's directory; each path segment is encoded.
  projectRunArtifact: (runId: string, path: string, guild?: string) =>
    `${API_BASE}/project/runs/${encodeURIComponent(runId)}/artifacts/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}${guild ? `?guild=${encodeURIComponent(guild)}` : ""}`,
  projectInitiatives: () => `${API_BASE}/project/initiatives`,
  projectComparisonTargets: () => `${API_BASE}/project/comparison-targets`,
  projectComparison: (baseline: string, candidate: string) =>
    `${API_BASE}/project/comparisons?baseline=${encodeURIComponent(
      baseline,
    )}&candidate=${encodeURIComponent(candidate)}`,
  projectKnowledgeGraph: () => `${API_BASE}/project/knowledge-graph`,
  projectWiki: () => `${API_BASE}/project/wiki`,
  projectComponents: () => `${API_BASE}/project/components`,
  projectMemory: () => `${API_BASE}/project/memory`,
  projectWikiPage: (path: string, guild?: string) =>
    `${API_BASE}/project/wiki/page?path=${encodeURIComponent(path)}${
      guild ? `&guild=${encodeURIComponent(guild)}` : ""
    }`,
};

export type {
  ProjectAnalysisResponse,
  ProjectComparisonResponse,
  ProjectComparisonTargetsResponse,
  ProjectInitiativesResponse,
  ProjectRunsListResponse,
  ProjectRunDetailResponse,
};

export type PostRunErrorBody = {
  error?: string;
  reason?: string;
  current_run_id?: string;
  [k: string]: unknown;
};

export class PostRunError extends Error {
  status: number;
  body: PostRunErrorBody;
  constructor(status: number, body: PostRunErrorBody, message: string) {
    super(message);
    this.name = "PostRunError";
    this.status = status;
    this.body = body;
  }
}

export class ImportAuditLogError extends Error {
  status: number;
  body: PostRunErrorBody;
  constructor(status: number, body: PostRunErrorBody, message: string) {
    super(message);
    this.name = "ImportAuditLogError";
    this.status = status;
    this.body = body;
  }
}

export class ProjectAnalyzeError extends Error {
  status: number;
  body: PostRunErrorBody;
  constructor(status: number, body: PostRunErrorBody, message: string) {
    super(message);
    this.name = "ProjectAnalyzeError";
    this.status = status;
    this.body = body;
  }
}

// POST /api/runs — backend (T2) returns 202 + Location + RunPostResponse on
// success; 409 with { reason: "run_in_flight", current_run_id } when another
// run is already in flight; 400 on shape error. Network failures throw the
// underlying TypeError untouched (caller treats as "couldn't reach server").
export async function postRun(req: RunPostRequest): Promise<RunPostResponse> {
  const res = await fetch(`${API_BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(req),
  });
  if (res.status === 202) {
    return (await res.json()) as RunPostResponse;
  }
  const body: PostRunErrorBody = await res.json().catch(() => ({}));
  const message =
    typeof body.error === "string"
      ? body.error
      : typeof body.reason === "string"
        ? body.reason
        : `unexpected status ${res.status}`;
  throw new PostRunError(res.status, body, message);
}

export async function importAuditLog(
  req: AuditLogImportRequest,
): Promise<AuditLogImportResponse> {
  const res = await fetch(`${API_BASE}/imports/audit-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(req),
  });
  if (res.status === 201) {
    return (await res.json()) as AuditLogImportResponse;
  }
  const body: PostRunErrorBody = await res.json().catch(() => ({}));
  const message =
    typeof body.error === "string"
      ? body.error
      : typeof body.reason === "string"
        ? body.reason
        : `unexpected status ${res.status}`;
  throw new ImportAuditLogError(res.status, body, message);
}

export async function analyzeProjectTarget(
  req: ProjectAnalysisRequest,
): Promise<ProjectAnalysisResponse> {
  const res = await fetch(`${API_BASE}/project/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(req),
  });
  if (res.status === 200) {
    return (await res.json()) as ProjectAnalysisResponse;
  }
  const body: PostRunErrorBody = await res.json().catch(() => ({}));
  const message =
    typeof body.error === "string"
      ? body.error
      : typeof body.reason === "string"
        ? body.reason
        : `unexpected status ${res.status}`;
  throw new ProjectAnalyzeError(res.status, body, message);
}
