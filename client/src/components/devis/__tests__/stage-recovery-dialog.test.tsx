// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StageRecoveryDialog, type StageRecoveryRequest } from "../StageRecoveryDialog";
import { apiRequest, projectScopedKey, queryClient } from "@/lib/queryClient";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(),
  projectScopedKey: (id: string, resource: string) => ["/api/projects", String(id), resource],
  queryClient: { setQueryData: vi.fn(), invalidateQueries: vi.fn() },
}));

const updated = { id: 42, signOffStage: "client_signed_off", signedPdfStorageKey: "signed/evidence.pdf" };
const reason = "Reconcile the internal review with the retained signed PDF.";
function Fixture({ request }: { request: StageRecoveryRequest }) {
  const [open, setOpen] = useState(true);
  return open ? <StageRecoveryDialog devisId={42} projectId="9" request={request} onClose={() => setOpen(false)} /> : null;
}
function setup(request: StageRecoveryRequest = { action: "restore", expectedStage: "approved_for_signing" }) {
  const cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={cache}><Fixture request={request} /></QueryClientProvider>);
  return {
    confirm: screen.getByTestId("button-stage-recovery-confirm-42"),
    input: screen.getByLabelText("Reason (required)"),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiRequest).mockResolvedValue({ json: async () => updated } as Response);
});
afterEach(cleanup);

describe("audited stage recovery confirmation", () => {
  it("cancel closes without any request, invalidation, cache update, or toast", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: reason } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(apiRequest).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
  it("requires a trimmed reason of 10–2000 characters", () => {
    const { input, confirm } = setup();
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "  short  " } });
    expect(confirm).toBeDisabled();
    fireEvent.change(input, { target: { value: "0123456789" } });
    expect(confirm).toBeEnabled();
    fireEvent.change(input, { target: { value: "a".repeat(2000) } });
    expect(confirm).toBeEnabled();
    fireEvent.change(input, { target: { value: "a".repeat(2001) } });
    expect(confirm).toBeDisabled();
    expect(input).toHaveAttribute("maxlength", "2000");
    expect(apiRequest).not.toHaveBeenCalled();
  });
  it.each([
    ["approved_for_signing", "received"],
    ["approved_for_signing", "checked_internal"],
    ["sent_to_client", "received"],
    ["sent_to_client", "checked_internal"],
    ["sent_to_client", "approved_for_signing"],
    ["client_signed_off", "received"],
    ["client_signed_off", "checked_internal"],
    ["client_signed_off", "approved_for_signing"],
    ["client_signed_off", "sent_to_client"],
  ])("POSTs the confirmed reopening from %s to %s only after confirmation", async (expectedStage, targetStage) => {
    const { input, confirm } = setup({ action: "reopen", expectedStage, targetStage, targetLabel: targetStage });
    expect(apiRequest).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: `  ${reason}  ` } });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledExactlyOnceWith("POST", "/api/devis/42/stage-recovery", {
      action: "reopen", expectedStage, targetStage, confirmed: true, reason,
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(queryClient.setQueryData).toHaveBeenCalledWith(["/api/devis", 42], updated);
    for (const key of ["devis", "devis-readiness", "financial-summary"]) {
      expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: projectScopedKey("9", key) });
    }
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42] });
  });
  it.each(["received", "checked_internal", "approved_for_signing", "sent_to_client"])("restores from %s without sending a targetStage", async (expectedStage) => {
    const { input, confirm } = setup({ action: "restore", expectedStage });
    expect(screen.getByRole("dialog")).toHaveTextContent("existing signed PDF");
    expect(screen.getByRole("dialog")).toHaveTextContent("insurance requirements are not overridden");
    fireEvent.change(input, { target: { value: reason } });
    fireEvent.click(confirm);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledExactlyOnceWith("POST", "/api/devis/42/stage-recovery", {
      action: "restore", expectedStage, confirmed: true, reason,
    }));
  });
  it("does not report success prematurely and blocks cancellation while saving", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(apiRequest).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { input, confirm } = setup();
    fireEvent.change(input, { target: { value: reason } });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(toast).not.toHaveBeenCalled();
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
    resolve({ json: async () => updated } as Response);
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: "Signed status restored" }));
  });
  it("keeps the reason and dialog on failure, allows retry, and shows no success toast", async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Stage changed. Refresh before retrying."));
    const { input, confirm } = setup();
    fireEvent.change(input, { target: { value: reason } });
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Stage changed"));
    expect(input).toHaveValue(reason);
    expect(confirm).toBeEnabled();
    expect(toast).not.toHaveBeenCalled();
    expect(queryClient.setQueryData).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });
});
