import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import ImportAuditPage from "../routes/ImportAuditPage";
import { installMockFetch } from "./fixtures/mockFetch";

function RunDestinationProbe() {
  const { run_id } = useParams<{ run_id: string }>();
  return <div data-testid="nav-target-run-id">{run_id}</div>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/import"]}>
      <Routes>
        <Route path="/import" element={<ImportAuditPage />} />
        <Route path="/runs/:run_id" element={<RunDestinationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ImportAuditPage", () => {
  let handle: ReturnType<typeof installMockFetch> | undefined;

  afterEach(() => {
    handle?.reset();
  });

  it("Import button is disabled when run_dir is empty", () => {
    handle = installMockFetch();
    mount();
    expect(screen.getByTestId("import-button")).toBeDisabled();
  });

  it("Import button is enabled once run_dir has content", async () => {
    handle = installMockFetch();
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/project/.guild/runs/run-abc",
    );
    expect(screen.getByTestId("import-button")).toBeEnabled();
  });

  it("submits run_dir only when run_id is blank", async () => {
    handle = installMockFetch();
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/project/.guild/runs/run-abc",
    );
    await userEvent.click(screen.getByTestId("import-button"));

    await waitFor(() => {
      const post = handle!.fetchSpy.mock.calls.find(([, init]) => {
        const i = init as RequestInit | undefined;
        return i?.method === "POST";
      });
      expect(post).toBeTruthy();
    });

    const postCall = handle!.fetchSpy.mock.calls.find(([, init]) => {
      const i = init as RequestInit | undefined;
      return i?.method === "POST";
    })!;
    const [url, init] = postCall as [string, RequestInit];
    expect(url).toMatch(/\/api\/imports\/audit-log$/);
    expect(JSON.parse(init.body as string)).toEqual({
      run_dir: "/tmp/project/.guild/runs/run-abc",
    });
  });

  it("submits run_dir and run_id when both are filled", async () => {
    handle = installMockFetch();
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/project/.guild/runs/run-abc",
    );
    await userEvent.type(screen.getByTestId("run-id-input"), "my-run-001");
    await userEvent.click(screen.getByTestId("import-button"));

    await waitFor(() => {
      const post = handle!.fetchSpy.mock.calls.find(([, init]) => {
        const i = init as RequestInit | undefined;
        return i?.method === "POST";
      });
      expect(post).toBeTruthy();
    });

    const postCall = handle!.fetchSpy.mock.calls.find(([, init]) => {
      const i = init as RequestInit | undefined;
      return i?.method === "POST";
    })!;
    expect(JSON.parse((postCall[1] as RequestInit).body as string)).toEqual({
      run_dir: "/tmp/project/.guild/runs/run-abc",
      run_id: "my-run-001",
    });
  });

  it("navigates to /runs/<run_id> on 201 success", async () => {
    handle = installMockFetch();
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/project/.guild/runs/run-abc",
    );
    await userEvent.click(screen.getByTestId("import-button"));

    // Default mock returns run_id "audit-imported-001" (mockFetch.ts).
    const target = await screen.findByTestId("nav-target-run-id");
    expect(target).toHaveTextContent("audit-imported-001");
  });

  it("shows import-error-400 panel on 400 response", async () => {
    handle = installMockFetch({
      override: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && /\/api\/imports\/audit-log$/.test(url)) {
          return new Response(
            JSON.stringify({ error: "no v1.4 events found in run directory" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/project/.guild/runs/empty",
    );
    await userEvent.click(screen.getByTestId("import-button"));

    const banner = await screen.findByTestId("import-error-400");
    expect(banner).toHaveTextContent(/no v1\.4 events found/);
    expect(screen.getByTestId("import-button")).toBeEnabled();
  });

  it("shows import-error-network panel when fetch throws", async () => {
    handle = installMockFetch({
      override: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && /\/api\/imports\/audit-log$/.test(url)) {
          throw new TypeError("Failed to fetch");
        }
        return undefined;
      },
    });
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/project/.guild/runs/run-abc",
    );
    await userEvent.click(screen.getByTestId("import-button"));

    const banner = await screen.findByTestId("import-error-network");
    expect(banner).toHaveTextContent(/Couldn't reach server/i);
    expect(banner).toHaveTextContent(/Failed to fetch/);
    expect(screen.getByTestId("import-button")).toBeEnabled();
  });

  it("clears error state when run_dir is changed after a failure", async () => {
    handle = installMockFetch({
      override: (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && /\/api\/imports\/audit-log$/.test(url)) {
          return new Response(
            JSON.stringify({ error: "bad path" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return undefined;
      },
    });
    mount();
    await userEvent.type(
      screen.getByTestId("run-dir-input"),
      "/tmp/bad-path",
    );
    await userEvent.click(screen.getByTestId("import-button"));
    expect(await screen.findByTestId("import-error-400")).toBeInTheDocument();

    await userEvent.type(screen.getByTestId("run-dir-input"), "/extra");
    expect(screen.queryByTestId("import-error-400")).not.toBeInTheDocument();
  });
});
