import { NavLink, Route, Routes } from "react-router-dom";
import DashboardPage from "./routes/DashboardPage";
import RunsListPage from "./routes/RunsListPage";
import RunDetailPage from "./routes/RunDetailPage";
import ProjectRunDetailPage from "./routes/ProjectRunDetailPage";
import ComparePage from "./routes/ComparePage";
import TriggerPanelPage from "./routes/TriggerPanelPage";
import ImportAuditPage from "./routes/ImportAuditPage";
import DemoPage from "./routes/DemoPage";
import KnowledgePage from "./routes/KnowledgePage";
import WikiPage from "./routes/WikiPage";
import InitiativesPage from "./routes/InitiativesPage";

// Grouped by what an operator is exploring. Guild components (agents, skills,
// workflow graphs, hooks, adapters) have no read API yet, so no entry.
const NAV: { group: string; items: { to: string; label: string; end?: boolean }[] }[] = [
  { group: "Overview", items: [{ to: "/", label: "Overview", end: true }] },
  {
    group: "Work",
    items: [
      { to: "/initiatives", label: "Initiatives" },
      { to: "/runs", label: "Runs" },
    ],
  },
  {
    group: "Knowledge",
    items: [
      { to: "/knowledge", label: "Graph" },
      { to: "/wiki", label: "Wiki" },
    ],
  },
  {
    group: "Evaluations",
    items: [
      { to: "/compare", label: "Compare" },
      { to: "/demo", label: "Demo" },
    ],
  },
  {
    group: "Operations",
    items: [
      { to: "/cases", label: "Trigger" },
      { to: "/import", label: "Import" },
    ],
  },
];

export default function App() {
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Primary">
        <div className="brand-lockup">
          <img
            className="brand-mark brand-mark-image"
            src="/brand/guildstack-logo-128.png"
            alt=""
            aria-hidden="true"
          />
          <span className="brand">
            Guild Stack
            <span>Console</span>
          </span>
        </div>
        <div className="nav-links">
          {NAV.map((section) => (
            <div className="nav-group" key={section.group} role="group" aria-label={section.group}>
              <span className="nav-group-label">{section.group}</span>
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      </nav>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/initiatives" element={<InitiativesPage />} />
          <Route path="/runs" element={<RunsListPage />} />
          <Route path="/runs/:run_id" element={<RunDetailPage />} />
          <Route path="/project-runs/:run_id" element={<ProjectRunDetailPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/cases" element={<TriggerPanelPage />} />
          <Route path="/import" element={<ImportAuditPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/demo/:case_slug" element={<DemoPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/wiki" element={<WikiPage />} />
          <Route
            path="*"
            element={
              <div className="empty">
                Unknown route. <NavLink to="/runs">Back to runs</NavLink>.
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
