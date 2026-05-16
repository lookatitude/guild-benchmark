import { NavLink, Route, Routes } from "react-router-dom";
import RunsListPage from "./routes/RunsListPage";
import RunDetailPage from "./routes/RunDetailPage";
import ComparePage from "./routes/ComparePage";
import TriggerPanelPage from "./routes/TriggerPanelPage";
import ImportAuditPage from "./routes/ImportAuditPage";
import DemoPage from "./routes/DemoPage";

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Runs", end: true },
  { to: "/compare", label: "Compare" },
  { to: "/cases", label: "Trigger" },
  { to: "/import", label: "Import" },
  { to: "/demo", label: "Demo" },
];

export default function App() {
  return (
    <div className="app-shell">
      <nav className="app-nav" aria-label="Primary">
        <span className="brand">Guild Benchmark</span>
        {NAV.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<RunsListPage />} />
          <Route path="/runs/:run_id" element={<RunDetailPage />} />
          <Route path="/compare" element={<ComparePage />} />
          <Route path="/cases" element={<TriggerPanelPage />} />
          <Route path="/import" element={<ImportAuditPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/demo/:case_slug" element={<DemoPage />} />
          <Route
            path="*"
            element={
              <div className="empty">
                Unknown route. <NavLink to="/">Back to runs</NavLink>.
              </div>
            }
          />
        </Routes>
      </main>
    </div>
  );
}
