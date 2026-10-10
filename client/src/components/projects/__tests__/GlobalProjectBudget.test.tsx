// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GlobalProjectBudget } from "../GlobalProjectBudget";
import { apiRequest, ApiError, projectScopedKey } from "@/lib/queryClient";
import type { FinancialSummary } from "@/lib/financial-summary";
import { externalWorkForm, validateExternalWork, type ExternalWork, type ExternalWorksResponse } from "@/lib/external-works";

vi.mock("@/lib/queryClient", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/queryClient")>(),
  apiRequest: vi.fn(),
}));

const entry: ExternalWork = {
  id: 24, projectId: 12, reference: "HIST-024", description: "Completed terrace",
  amountHt: "8740.00", amountTtc: "9177.00", companyName: "Atelier Morel", lot: "Terrace",
  completionDate: "2025-02-28", status: "active", version: 3, voidReason: null,
  createdAt: "2025-03-01T10:00:00Z", updatedAt: "2025-03-01T10:00:00Z",
};
const summary = {
  totalContractedHt: 18230, totalContractedTtc: 21876,
  totalExternalHt: 8740, totalExternalTtc: 9177,
  totalCombinedCostHt: 26970, totalCombinedCostTtc: 31053,
} as FinancialSummary;

function setup({ readOnly = false, data = { entries: [entry], history: [] } as ExternalWorksResponse } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => data }, mutations: { retry: false } },
  });
  client.setQueryData(projectScopedKey(12, "external-works"), data);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><GlobalProjectBudget projectId={12} summary={summary} readOnly={readOnly} /></QueryClientProvider>);
  return { client, invalidate, data };
}

function fillCreate() {
  fireEvent.click(screen.getByRole("button", { name: "Add external works" }));
  fireEvent.change(screen.getByLabelText("External reference *"), { target: { value: "HIST-025" } });
  fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Completed windows" } });
  fireEvent.change(screen.getByLabelText("Amount HT (€) *"), { target: { value: "874.25" } });
  fireEvent.change(screen.getByLabelText("Amount TTC (€) *"), { target: { value: "874.25" } });
  fireEvent.click(screen.getByLabelText(/I confirm these are agreed/));
}

beforeEach(() => vi.mocked(apiRequest).mockReset());
afterEach(cleanup);

describe("GlobalProjectBudget", () => {
  it("keeps the zero-state compact and leaves managed and certified meaning explicit", () => {
    setup({ data: { entries: [], history: [] } });
    expect(screen.getByText("Combined project cost")).toBeTruthy();
    expect(screen.queryByText(/No active external works recorded/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View register (0 active)" }));
    expect(screen.getByText("No active external works recorded")).toBeTruthy();
    expect(screen.getByText(/Pending unsigned quotations remain separate/).textContent).toContain("not paid or certified");
  });

  it("creates with explicit equal HT/TTC and invalidates all three canonical project resources", async () => {
    const { invalidate } = setup();
    vi.mocked(apiRequest).mockResolvedValue({} as Response);
    fillCreate();
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/projects/12/external-works",
      expect.objectContaining({ reference: "HIST-025", amountHt: "874.25", amountTtc: "874.25", confirmedCompleted: true })));
    await waitFor(() => {
      for (const resource of ["financial-summary", "external-works", "certificats"]) {
        expect(invalidate).toHaveBeenCalledWith({ queryKey: projectScopedKey("12", resource) });
      }
    });
  });

  it("requires explicit managed-overlap acknowledgement before retrying a create", async () => {
    setup();
    vi.mocked(apiRequest)
      .mockRejectedValueOnce(new ApiError(409, "Overlap", { code: "MANAGED_OVERLAP", overlaps: [{ id: 18, reference: "DEV-018" }] }))
      .mockResolvedValueOnce({} as Response);
    fillCreate();
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await screen.findByText("DEV-018");
    const save = screen.getByRole("button", { name: "Save external works" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((screen.getByLabelText("External reference *") as HTMLInputElement).value).toBe("HIST-025");
    fireEvent.click(screen.getByLabelText(/I reviewed these references/));
    fireEvent.click(save);
    await waitFor(() => expect(apiRequest).toHaveBeenLastCalledWith("POST", "/api/projects/12/external-works", expect.objectContaining({ acknowledgeOverlap: true })));
  });

  it("keeps unsaved edits on duplicate-reference errors and does not acknowledge overlaps implicitly", async () => {
    setup();
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(409, "Duplicate", { code: "DUPLICATE_REFERENCE" }));
    fireEvent.click(screen.getByRole("button", { name: "View register (1 active)" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "My unsaved detail" } });
    fireEvent.click(screen.getByLabelText(/I confirm these are agreed/));
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await screen.findByText(/This reference already exists/);
    expect((screen.getByLabelText("Description *") as HTMLTextAreaElement).value).toBe("My unsaved detail");
    expect(apiRequest).toHaveBeenCalledWith("PATCH", "/api/projects/12/external-works/24", expect.objectContaining({ version: 3, description: "My unsaved detail" }));
    expect(vi.mocked(apiRequest).mock.calls[0][2]).not.toHaveProperty("acknowledgeOverlap");
  });

  it("requires explicit conflict review and preserves edits across a refetch", async () => {
    const { data } = setup();
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(409, "Conflict", { code: "VERSION_CONFLICT" })).mockResolvedValueOnce({} as Response);
    fireEvent.click(screen.getByRole("button", { name: "View register (1 active)" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Description *"), { target: { value: "Keep my detail" } });
    fireEvent.click(screen.getByLabelText(/I confirm these are agreed/));
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await screen.findByText(/Your unsaved content is preserved/);
    data.entries = [{ ...entry, version: 4, description: "Someone else's detail" }];
    fireEvent.click(screen.getByRole("button", { name: "Review latest version" }));
    await screen.findByText("Server version 4 · active");
    expect((screen.getByLabelText("Description *") as HTMLTextAreaElement).value).toBe("Keep my detail");
    fireEvent.click(screen.getByRole("button", { name: "Use this version, keep my edits" }));
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await waitFor(() => expect(apiRequest).toHaveBeenLastCalledWith("PATCH", "/api/projects/12/external-works/24", expect.objectContaining({ version: 4, description: "Keep my detail" })));
  });

  it("requires a reason to void and posts the versioned lifecycle action", async () => {
    setup();
    vi.mocked(apiRequest).mockResolvedValue({} as Response);
    fireEvent.click(screen.getByRole("button", { name: "View register (1 active)" }));
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.change(screen.getByLabelText("Void reason *"), { target: { value: "Duplicate scope removed" } });
    fireEvent.click(screen.getByRole("button", { name: "Void entry" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/projects/12/external-works/24/void", { version: 3, reason: "Duplicate scope removed" }));
  });

  it("shows voided entries only on request, allows restore, and displays actor/time/reason history", async () => {
    setup({ data: {
      entries: [{ ...entry, status: "void", voidReason: "Migrated twice" }],
      history: [{ id: 1, entryId: 24, action: "void", actorName: "Camille Laurent", createdAt: "2025-03-02T14:30:00Z", before: { status: "active" }, after: { status: "void" }, reason: "Migrated twice" }],
    } });
    vi.mocked(apiRequest).mockResolvedValue({} as Response);
    fireEvent.click(screen.getByRole("button", { name: "View register (0 active)" }));
    expect(screen.queryByText(/HIST-024/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Show voided entries"));
    expect(screen.getByText("Void reason: Migrated twice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore entry" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("POST", "/api/projects/12/external-works/24/restore", { version: 3 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore entry" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
    expect(screen.getByText(/Camille Laurent/)).toBeTruthy();
    expect(document.querySelector('time[datetime="2025-03-02T14:30:00Z"]')).toBeTruthy();
    expect(screen.getByText("Reason: Migrated twice")).toBeTruthy();
  });

  it("makes archived projects read-only without hiding the register or audit history", () => {
    setup({ readOnly: true });
    expect(screen.queryByRole("button", { name: "Add external works" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View register (1 active)" }));
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Void" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Audit history" }));
    expect(screen.getByText("No changes recorded yet.")).toBeTruthy();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("also requires an explicit overlap acknowledgement when restoring", async () => {
    setup({ data: { entries: [{ ...entry, status: "void", voidReason: "Reviewed migration" }], history: [] } });
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(409, "Overlap", {
      code: "MANAGED_OVERLAP", overlaps: [{ id: 19, reference: "DEV-019" }],
    })).mockResolvedValueOnce({} as Response);
    fireEvent.click(screen.getByRole("button", { name: "View register (0 active)" }));
    fireEvent.click(screen.getByLabelText("Show voided entries"));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore entry" }));
    await screen.findByText("DEV-019");
    expect((screen.getByRole("button", { name: "Restore entry" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText(/I reviewed these references/));
    fireEvent.click(screen.getByRole("button", { name: "Restore entry" }));
    await waitFor(() => expect(apiRequest).toHaveBeenLastCalledWith("POST", "/api/projects/12/external-works/24/restore", { version: 3, acknowledgeOverlap: true }));
  });

  it("discards an overlap acknowledgement after content changes and requests a fresh check", async () => {
    setup();
    vi.mocked(apiRequest).mockRejectedValueOnce(new ApiError(409, "Overlap", {
      code: "MANAGED_OVERLAP", overlaps: [{ id: 19, reference: "DEV-019" }],
    })).mockResolvedValueOnce({} as Response);
    fillCreate();
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await screen.findByText("DEV-019");
    fireEvent.click(screen.getByLabelText(/I reviewed these references/));
    fireEvent.change(screen.getByLabelText("External reference *"), { target: { value: "HIST-NEW" } });
    expect(screen.queryByText("DEV-019")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save external works" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiRequest).mock.calls[1][2]).not.toHaveProperty("acknowledgeOverlap");
  });
});

describe("external work validation", () => {
  const valid = { ...externalWorkForm(entry), confirmedCompleted: true };
  it.each(["", "-1", "1.234", "10000000000", "1e3", "NaN", "12,50"])("rejects invalid explicit money %s", amountHt => {
    expect(validateExternalWork({ ...valid, amountHt })).not.toBeNull();
  });
  it("accepts zero, mixed VAT, zero VAT and the exact maximum without calculating tax", () => {
    for (const [amountHt, amountTtc] of [["0", "0"], ["8740", "9177"], ["9999999999.99", "9999999999.99"]]) {
      expect(validateExternalWork({ ...valid, amountHt, amountTtc })).toBeNull();
    }
  });
  it("rejects TTC below HT, impossible dates and missing confirmation", () => {
    expect(validateExternalWork({ ...valid, amountTtc: "1" })).toMatch(/greater/);
    expect(validateExternalWork({ ...valid, completionDate: "2025-02-29" })).toMatch(/valid completion date/);
    expect(validateExternalWork({ ...valid, confirmedCompleted: false })).toMatch(/Confirm/);
  });
});
