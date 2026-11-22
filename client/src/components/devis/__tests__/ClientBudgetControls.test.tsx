// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ClientBudgetEntry, ClientBudgetState } from "@shared/client-budget";
const expectedMoney = (value: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value).replace(/\s+/g, " ");

const { request, toast } = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/queryClient")>(),
  apiRequest: request,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
import { ApiError, queryClient } from "@/lib/queryClient";
import { ClientBudgetAuditDetail, ClientBudgetControls } from "../ClientBudgetControls";

const key = ["/api/projects", "24", "client-budget"];
const url = "/api/projects/24/client-budget";
function entry(devisId: number, title: string, ht: string, ttc: string): ClientBudgetEntry {
  return { devisId, title, reference: `REN-${devisId}`, contractor: "Atelier Renaud", amountHt: ht, amountTtc: ttc };
}
function budget(): ClientBudgetState {
  const unsigned = entry(1, "Window joinery", "100.00", "120.00");
  const signed = entry(3, "Roof repair", "210.00", "252.00");
  const excluded = entry(4, "Old heating option", "50.00", "60.00");
  return {
    version: "version-a", signedHt: 270, signedTtc: 324, readOnly: false,
    candidates: [
      { devisId: 1, shared: unsigned, current: { ...unsigned, reference: "REN-1-REV", amountHt: "140.00", amountTtc: "168.00" }, changed: true, signed: false, blockedReason: null, excluded: false },
      { devisId: 2, shared: null, current: entry(2, "Interior doors", "70.00", "84.00"), changed: false, signed: false, blockedReason: null, excluded: false },
      { devisId: 3, shared: signed, current: { ...signed, title: "Current roof title", amountHt: "270.00", amountTtc: "324.00" }, changed: true, signed: true, blockedReason: null, excluded: false },
      { devisId: 4, shared: excluded, current: excluded, changed: false, signed: false, blockedReason: "Superseded quotation", excluded: true },
    ],
  };
}
function mount(state = budget(), props: { devisId?: number; isArchived?: boolean } = {}) {
  queryClient.setQueryData(key, state);
  return render(<QueryClientProvider client={queryClient}><ClientBudgetControls projectId="24" {...props} /></QueryClientProvider>);
}
function openManager() {
  fireEvent.click(screen.getByRole("button", { name: "Manage client budget" }));
}
function expand() {
  const summary = screen.getByText(/Quotation breakdown/);
  if (!summary.closest("details")?.open) fireEvent.click(summary);
}
function row(name: string, signed = false) {
  return screen.getByRole("checkbox", { name: `${name} · ${signed ? "Signed" : "Unsigned"}` }).closest("div")!;
}
function review() {
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
}
function confirmSave() {
  fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed alternatives/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm and save client budget" }));
}
function putCalls() {
  return request.mock.calls.filter(([method]) => method === "PUT");
}
function expectAmounts(container: HTMLElement, ht: number, ttc: number) {
  const text = container.textContent?.replace(/\s+/g, " ");
  expect(text).toContain(expectedMoney(ht));
  expect(text).toContain(expectedMoney(ttc));
  expect(text).toContain("HT");
  expect(text).toContain("TTC");
}
beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  request.mockImplementation(async () => ({ json: async () => budget() }));
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("ClientBudgetControls", () => {
  it("reviews unavailable PDF totals from the quotation row and saves only an indicative budget override", async () => {
    const state = budget();
    Object.assign(state.candidates[1], { current: null, figuresUnavailable: true, blockedReason: "Extraction incomplete", canReviewIndicative: true, sourcePdfUrl: "/api/devis/2/pdf" });
    mount(state, { devisId: 2 });
    expect(screen.getByRole("checkbox", { name: "Include in client budget" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Review PDF totals for indicative budget" }));
    expect(screen.getAllByText("Amounts unavailable").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Review original PDF totals" }));
    expect(screen.getByRole("link", { name: "Open original PDF" })).toHaveAttribute("href", "/api/devis/2/pdf?variant=original");
    const confirm = screen.getByRole("button", { name: "I checked these totals against the PDF" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Source total HT"), { target: { value: "1 287,41" } });
    fireEvent.change(screen.getByLabelText("Source total TTC"), { target: { value: "1544.89" } });
    fireEvent.change(screen.getByLabelText("PDF page"), { target: { value: "3" } });
    fireEvent.click(confirm);
    const target = row("Quotation 2");
    fireEvent.change(within(target).getByRole("textbox"), { target: { value: "Interior door draft" } });
    review();
    const confirmation = screen.getByRole("region", { name: "Confirm client budget" });
    expectAmounts(confirmation, 1287.41, 1544.89);
    expect(within(confirmation).getByText(/Indicative · PDF totals reviewed/)).toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
    confirmSave();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][2].entries.find((item: { devisId: number }) => item.devisId === 2)).toEqual({
      devisId: 2, title: "Interior door draft", refresh: true,
      reviewedTotals: { amountHt: "1287.41", amountTtc: "1544.89", pdfPage: 3, confirmedFromPdf: true },
    });
  });
  it("retains a saved reviewed snapshot without resubmitting or refreshing its evidence", async () => {
    const state = budget();
    state.candidates[0].shared!.basis = "reviewed_source_total";
    Object.assign(state.candidates[0], { current: null, figuresUnavailable: true, blockedReason: "Extraction incomplete", canReviewIndicative: true });
    mount(state); openManager(); review(); confirmSave();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][2].entries[0]).toEqual({ devisId: 1, title: "Window joinery", refresh: false });
  });
  it.each(["signed", "excluded", "archived"] as const)("does not permit an indicative override for %s quotations", (status) => {
    const state = budget();
    Object.assign(state.candidates[1], { canReviewIndicative: true, current: null, figuresUnavailable: true, signed: status === "signed", excluded: status === "excluded" });
    mount(state, { isArchived: status === "archived" }); openManager(); expand();
    const action = screen.queryByRole("button", { name: "Review original PDF totals" });
    if (status === "archived") expect(action).toBeDisabled();
    else expect(action).not.toBeInTheDocument();
  });
  it("stages the row checkbox and confirms one versioned save with an edited English title", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    mount(budget(), { devisId: 2 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in client budget" }));
    expect(putCalls()).toHaveLength(0);
    const title = within(row("Interior doors")).getByRole("textbox", { name: /Public English title/ });
    expect(title).toHaveValue("Interior doors");
    expect(title).toHaveAttribute("maxlength", "500");
    fireEvent.change(title, { target: { value: "  Oak interior doors  " } });
    review();
    expect(screen.getByRole("button", { name: "Confirm and save client budget" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Confirm client budget" })).toHaveTextContent("Oak interior doors");
    confirmSave();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(request).toHaveBeenCalledWith("PUT", url, {
      version: "version-a", alternativesReviewed: true,
      entries: [
        { devisId: 1, title: "Window joinery", refresh: false },
        { devisId: 2, title: "Oak interior doors", refresh: true },
        { devisId: 3, title: "Roof repair", refresh: false },
        { devisId: 4, title: "Old heating option", refresh: false },
      ],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/projects", "24", "client-share", "audit"] });
  });

  it("keeps existing unsigned amounts frozen without an explicit update", async () => {
    mount(); openManager(); review();
    const confirmation = screen.getByRole("region", { name: "Confirm client budget" });
    const frozen = within(confirmation).getByText("Window joinery").closest("div")!;
    expectAmounts(frozen, 100, 120);
    expect(frozen).toHaveTextContent("REN-1");
    expect(frozen).not.toHaveTextContent("REN-1-REV");
    confirmSave();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][2].entries[0]).toEqual({ devisId: 1, title: "Window joinery", refresh: false });
  });

  it("uses current unsigned amounts only after explicit update and can revert to saved amounts", async () => {
    mount(); openManager(); expand();
    const quotation = row("Window joinery");
    fireEvent.click(within(quotation).getByRole("button", { name: "Update client budget to current amounts" }));
    expect(within(quotation).getByRole("button", { name: "Keep saved amounts instead" })).toBeEnabled();
    fireEvent.click(within(quotation).getByRole("button", { name: "Keep saved amounts instead" }));
    expect(within(quotation).getByText("Using saved client budget amounts.", { exact: false })).toBeVisible();
    fireEvent.click(within(quotation).getByRole("button", { name: "Update client budget to current amounts" }));
    review();
    const confirmed = within(screen.getByRole("region", { name: "Confirm client budget" })).getByText("Window joinery").closest("div")!;
    expectAmounts(confirmed, 140, 168);
    expect(confirmed).toHaveTextContent("REN-1-REV");
    confirmSave();
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(putCalls()[0][2].entries[0].refresh).toBe(true);
  });

  it("uses live signed amounts and saved signed titles without double-counting, and excludes lifecycle-inactive entries", () => {
    mount(); openManager();
    const total = screen.getByRole("region", { name: "Client budget total preview" });
    expectAmounts(within(total).getByText("Preview total").closest("div")!, 370, 444);
    review();
    const signed = within(screen.getByRole("region", { name: "Confirm client budget" })).getByText("Roof repair").closest("div")!;
    expectAmounts(signed, 270, 324);
    expect(signed.textContent?.replace(/\s+/g, " ")).not.toContain(expectedMoney(210));
    expect(signed).toHaveTextContent("Signed — live amounts");
    expect(screen.queryByText("Current roof title")).not.toBeInTheDocument();
    expect(screen.getByText("Inactive — excluded from the client budget")).toBeVisible();
  });

  it("retains valid unsigned snapshots when current amounts are invalid, while disabling new include and refresh", () => {
    const state = budget();
    state.candidates[0].blockedReason = "Current amounts are invalid";
    state.candidates[0].current = null;
    state.candidates[1].blockedReason = "Current amounts are invalid";
    mount(state); openManager(); expand();
    expectAmounts(within(screen.getByRole("region", { name: "Client budget total preview" })).getByText("Preview total").closest("div")!, 370, 444);
    const saved = row("Window joinery");
    expect(within(saved).getByRole("checkbox")).toBeEnabled();
    expect(saved).toHaveTextContent("Saved valid amounts remain shared");
    expect(within(saved).queryByRole("button", { name: /Update client budget/ })).not.toBeInTheDocument();
    expect(within(row("Interior doors")).getByRole("checkbox")).toBeDisabled();
    fireEvent.click(within(saved).getByRole("checkbox"));
    expectAmounts(within(screen.getByRole("region", { name: "Client budget total preview" })).getByText("Preview total").closest("div")!, 270, 324);
  });

  it("cancels staged inclusion without saving, and reopens with the saved selection", () => {
    mount(budget(), { devisId: 2 });
    fireEvent.click(screen.getByRole("checkbox", { name: "Include in client budget" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(window.confirm).toHaveBeenCalledWith("Discard your unsaved client budget changes?");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include in client budget" })).not.toBeChecked();
    expect(putCalls()).toHaveLength(0);
  });

  it("retains the draft after a 409, requires explicit reload and never silently retries with a new version", async () => {
    request.mockRejectedValueOnce(new ApiError(409, "Stale version", {}));
    mount(); openManager(); expand();
    fireEvent.change(within(row("Window joinery")).getByRole("textbox"), { target: { value: "Retained draft title" } });
    review(); confirmSave();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your draft has been retained"));
    expect(screen.getByText("Retained draft title")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm and save client budget" })).toBeDisabled();
    expect(putCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Back to selection" }));
    expand();
    expect(within(row("Window joinery")).getByRole("textbox")).toHaveValue("Retained draft title");
    expect(screen.getByRole("button", { name: "Review changes" })).toBeDisabled();
    const fresh = { ...budget(), version: "version-b" };
    request.mockResolvedValueOnce({ json: async () => fresh });
    fireEvent.click(screen.getByRole("button", { name: "Reload latest budget" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", url));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(putCalls()).toHaveLength(1);
    review(); confirmSave();
    await waitFor(() => expect(putCalls()).toHaveLength(2));
    expect(putCalls()[1][2].version).toBe("version-b");
  });

  it.each([{ readOnly: true, isArchived: false }, { readOnly: false, isArchived: true }])("supports read-only review without save controls: %o", (mode) => {
    mount({ ...budget(), readOnly: mode.readOnly }, { isArchived: mode.isArchived });
    openManager(); expand();
    expect(screen.getByRole("status")).toHaveTextContent("read-only");
    expect(within(row("Window joinery")).getByRole("checkbox")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(putCalls()).toHaveLength(0);
  });

  it("preserves a draft after a failed save and lets the user retry without changing the version", async () => {
    request.mockRejectedValueOnce(new Error("Connection interrupted"));
    mount(); openManager(); expand();
    fireEvent.change(within(row("Window joinery")).getByRole("textbox"), { target: { value: "Revised public title" } });
    review(); confirmSave();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Connection interrupted"));
    expect(screen.getByText("Revised public title")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save client budget" }));
    await waitFor(() => expect(putCalls()).toHaveLength(2));
    expect(putCalls()[1][2]).toEqual(putCalls()[0][2]);
  });

  it("preserves a conflicted draft when explicit reload is canceled or fails", async () => {
    request.mockRejectedValueOnce(new ApiError(409, "Stale version", {}));
    mount(); openManager(); expand();
    fireEvent.change(within(row("Window joinery")).getByRole("textbox"), { target: { value: "Keep this draft" } });
    review(); confirmSave();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("retained"));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest budget" }));
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error("Reload is offline"));
    fireEvent.click(screen.getByRole("button", { name: "Reload latest budget" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Reload is offline"));
    expect(screen.getByText("Keep this draft")).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm and save client budget" })).toBeDisabled();
    expect(putCalls()).toHaveLength(1);
  });

  it("does not unmount the editor or lose a draft if a background refresh fails", async () => {
    mount(); openManager(); expand();
    fireEvent.change(within(row("Window joinery")).getByRole("textbox"), { target: { value: "Draft survives refresh error" } });
    await act(async () => {
      await queryClient.fetchQuery({
        queryKey: key,
        staleTime: 0,
        queryFn: async () => { throw new Error("Background refresh failed"); },
      }).catch(() => {});
    });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Your existing draft is retained"));
    expect(within(row("Window joinery")).getByRole("textbox")).toHaveValue("Draft survives refresh error");
  });

  it("loads through the explicit project endpoint and offers retry after an initial load failure", async () => {
    request.mockRejectedValueOnce(new Error("Offline"));
    render(<QueryClientProvider client={queryClient}><ClientBudgetControls projectId="24" /></QueryClientProvider>);
    openManager();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not be loaded"));
    fireEvent.click(screen.getByRole("button", { name: "Retry loading" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Client budget total preview" })).toBeVisible());
    expect(request).toHaveBeenCalledWith("GET", url);
  });
});

describe("ClientBudgetAuditDetail", () => {
  it("shows a collapsed count and readable title and amount changes rather than raw JSON", () => {
    const detail = JSON.stringify({
      before: [entry(1, "Window joinery", "100.00", "120.00")],
      after: [entry(1, "Oak windows", "140.00", "168.00"), entry(2, "Interior doors", "70.00", "84.00")],
      alternativesReviewed: true,
    });
    render(<ClientBudgetAuditDetail detail={detail} />);
    const summary = screen.getByText("Client budget updated · 2 selected · 2 changed");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText(detail)).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(screen.getByText(/Before: Window joinery/)).toBeVisible();
    expect(screen.getByText(/After: Oak windows/)).toBeVisible();
    expect(screen.getByText("Added · Interior doors")).toBeVisible();
    expect(screen.getByText("Preferred alternatives reviewed before saving.")).toBeVisible();
  });

  it("handles malformed historical JSON without exposing it or crashing", () => {
    render(<ClientBudgetAuditDetail detail='{"before":"legacy"}' />);
    expect(screen.getByText("Client budget updated. Change details are unavailable.")).toBeVisible();
    expect(screen.queryByText(/legacy/)).not.toBeInTheDocument();
  });
});
