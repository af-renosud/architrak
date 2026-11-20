// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QuotationApprovalReview, type TranslationReadinessBlocker } from "../QuotationApprovalReview";
import { setQuotationWork } from "../quotation-review-state";
import type { QuotationIssue } from "@shared/quotation-decision";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...args: unknown[]) => api(...args) }));
let version: string;
let blockers: TranslationReadinessBlocker[];
let sendingPrerequisites: QuotationIssue[];
const mount = (onLocate = vi.fn()) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
  <QuotationApprovalReview devisId={8828} onLocate={onLocate} />
</QueryClientProvider>);
beforeEach(() => {
  version = "snapshot-a"; blockers = []; sendingPrerequisites = [];
  setQuotationWork(8828, "pending-context", false);
  setQuotationWork(8828, "pending-image", false);
  api.mockReset();
  api.mockImplementation(async (method: string) => ({ json: async () => method === "GET" ? { version, status: "draft", blockers, sendingPrerequisites } : { status: "finalised" } }));
});
afterEach(cleanup);
describe("latest reviewed approval token", () => {
  it("distinguishes an unrecorded source check from missing VAT and an actual discrepancy while keeping every action visible", async () => {
    blockers = [
      { key: "source", code: "SOURCE_CONFIRMATION_REQUIRED", message: "Financial backstop required",
        target: { section: "source", field: "sourceTtc" } },
      { key: "line-102", code: "VAT_MISSING", message: "Item 2: VAT rate is missing. Copy it from the PDF.",
        target: { section: "financial", rowId: 102, field: "vatRate" } },
      { key: "line-103", code: "VAT_MISSING", message: "Item 3: VAT rate is missing. Copy it from the PDF.",
        target: { section: "financial", rowId: 103, field: "vatRate" } },
      { key: "totals", code: "TTC_MISMATCH", message: "Working total differs from the original PDF by 16,33 €.",
        target: { section: "financial", field: "totalHt" } },
    ];
    const locate = vi.fn();
    mount(locate);
    const figures = within(await screen.findByRole("region", { name: "Source & figures" }));
    const source = figures.getByRole("button", { name: /not recorded yet — not a known discrepancy/ });
    expect(source).toBeVisible();
    expect(figures.getAllByRole("button", { name: /VAT rate is missing/ })).toHaveLength(2);
    expect(figures.getByRole("button", { name: /differs from the original PDF/ })).toBeVisible();
    expect(within(figures.getByLabelText("About the total difference")).getByRole("button", { name: "Why am I seeing this?" })).toBeVisible();
    expect(within(figures.getByLabelText("About missing financial information")).getByRole("button", { name: "Why am I seeing this?" })).toBeVisible();
    expect(figures.getAllByRole("button", { name: "Why am I seeing this?" })).toHaveLength(2);
    expect(screen.queryByText("Financial backstop required")).toBeNull();
    fireEvent.click(source);
    expect(locate).toHaveBeenCalledWith("source", { section: "source", field: "sourceTtc" });
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    expect(api.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });
  it("groups source/figures and saved content and passes structured navigation targets without interpreting messages", async () => {
    const target: QuotationIssue["target"] = { section: "financial", rowId: 102, field: "vatRate", page: 4 };
    blockers = [{ key: "opaque", code: "FINANCIAL_FIELD_REQUIRED", message: "Vérifier la donnée", target },
      { key: "also-opaque", code: "TRANSLATION_MISSING", message: "Texte anglais à revoir",
        target: { section: "translation", rowId: 103, field: "descriptionEn" } }];
    const locate = vi.fn();
    mount(locate);
    const figures = within(await screen.findByRole("region", { name: "Source & figures" }));
    fireEvent.click(figures.getByRole("button", { name: "Vérifier la donnée" }));
    expect(locate).toHaveBeenCalledWith("opaque", target);
    const content = within(screen.getByRole("region", { name: "Saved content" }));
    expect(content.getByRole("button", { name: "Texte anglais à revoir" })).toBeVisible();
    expect(content.queryByText("Vérifier la donnée")).toBeNull();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
  it("keeps sending prerequisites separate and does not turn them into approval gates or save requirements", async () => {
    sendingPrerequisites = [{ code: "SIGNER_REQUIRED", key: "signature", message: "Choose the client signer before sending",
      severity: "blocker", target: { section: "signature" }, resolution: "open_signature" }];
    mount();
    const check = await screen.findByRole("checkbox");
    await waitFor(() => expect(check).toBeEnabled());
    const message = screen.getByText("Choose the client signer before sending");
    expect(message.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", expect.any(String), { expectedVersion: "snapshot-a", confirmedReview: true }));
    expect(api.mock.calls.filter(([method]) => method !== "GET")).toHaveLength(1);
  });
  it("requires explicit review and posts the readiness version to the existing finalise endpoint", async () => {
    mount();
    const check = await screen.findByRole("checkbox");
    await waitFor(() => expect(check).toBeEnabled());
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", "/api/devis/8828/translation/finalise", { expectedVersion: "snapshot-a", confirmedReview: true }));
  });
  it("blocks approval for context debounce/save and image upload, then demands review of a fresh token", async () => {
    mount(); const check = await screen.findByRole("checkbox");
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);
    act(() => { setQuotationWork(8828, "pending-context", true, "Context saving"); setQuotationWork(8828, "pending-image", true, "Image uploading"); });
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    version = "snapshot-b";
    act(() => setQuotationWork(8828, "pending-context", false));
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    act(() => setQuotationWork(8828, "pending-image", false));
    await waitFor(() => expect(check).toBeEnabled());
    expect(check).not.toBeChecked();
    fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", expect.any(String), { expectedVersion: "snapshot-b", confirmedReview: true }));
  });
  it("recovers a stale-version rejection in place and cannot reuse the old review", async () => {
    const fallback = api.getMockImplementation()!;
    api.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "POST" && version === "snapshot-a") {
        version = "snapshot-c"; throw Object.assign(new Error("Quotation changed (409)."), { status: 409 });
      }
      return fallback(...args);
    });
    mount(); const check = await screen.findByRole("checkbox");
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check); fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(check).toBeEnabled());
    expect(check).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    fireEvent.click(check); fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", expect.any(String), { expectedVersion: "snapshot-c", confirmedReview: true }));
  });
  it("fails closed when actual VAT/amounts are missing", async () => {
    blockers = [{ key: "row-101", message: "VAT rate is missing on item 1" }, { key: "row-102", message: "Line amount HT is missing on item 2" }];
    mount();
    await screen.findByText("VAT rate is missing on item 1");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
  });
});
