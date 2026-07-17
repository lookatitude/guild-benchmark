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

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/runs", label: "Runs" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/wiki", label: "Wiki" },
  { to: "/compare", label: "Compare" },
  { to: "/cases", label: "Trigger" },
  { to: "/import", label: "Import" },
  { to: "/demo", label: "Demo" },
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
            Guild
            <span>Dashboard</span>
          </span>
        </div>
        <div className="nav-links">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
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
