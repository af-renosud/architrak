// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QuotationApprovalReview } from "../QuotationApprovalReview";
import { setQuotationWork } from "../quotation-review-state";

const api = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", () => ({ apiRequest: (...args: unknown[]) => api(...args) }));
let version: string;
let blockers: Array<{ key: string; message: string }>;
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
  <QuotationApprovalReview devisId={8828} onLocate={() => {}} />
</QueryClientProvider>);
beforeEach(() => {
  version = "snapshot-a"; blockers = [];
  setQuotationWork(8828, "pending-context", false);
  setQuotationWork(8828, "pending-image", false);
  api.mockReset();
  api.mockImplementation(async (method: string) => ({ json: async () => method === "GET" ? { version, status: "draft", blockers } : { status: "finalised" } }));
});
afterEach(cleanup);
describe("latest reviewed approval token", () => {
  it("requires explicit review and posts the readiness version to the existing finalise endpoint", async () => {
    mount();
    const check = await screen.findByRole("checkbox");
    await waitFor(() => expect(check).toBeEnabled());
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", "/api/devis/8828/translation/finalise", { expectedVersion: "snapshot-a" }));
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
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", expect.any(String), { expectedVersion: "snapshot-b" }));
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
    await waitFor(() => expect(api).toHaveBeenCalledWith("POST", expect.any(String), { expectedVersion: "snapshot-c" }));
  });
  it("fails closed when actual VAT/amounts are missing", async () => {
    blockers = [{ key: "row-101", message: "VAT rate is missing on item 1" }, { key: "row-102", message: "Line amount HT is missing on item 2" }];
    mount();
    await screen.findByText("VAT rate is missing on item 1");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
  });
});
