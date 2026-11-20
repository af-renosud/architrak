// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DevisLineItem } from "@shared/schema";
import { DevisTranslationSection } from "../DevisTranslationSection";

vi.mock("../DevisCostAnalysisCard", () => ({ DevisCostAnalysisCard: () => null }));
vi.mock("../QuotationApprovalReview", () => ({ QuotationApprovalReview: ({ onLocate }: {
  onLocate: (key: string, target: { section: "financial"; rowId: number; field: string; page: number }) => void;
}) => <div>Approval checklist here<button type="button" onClick={() =>
  onLocate("opaque", { section: "financial", rowId: 100, field: "vatRate", page: 2 })}>Locate figure issue</button></div> }));
vi.mock("../DevisLineContextEditor", () => ({ DevisLineContextEditor: ({ readOnly }: { readOnly: boolean }) => <div>Context {readOnly ? "read-only" : "editable"}</div> }));
function mount(architectControlled: boolean, status = "draft", readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/api/devis", 42, "translation"], { status, architectControlled, headerTranslated: { summary: "Reviewed overview" },
    lineTranslations: [{ lineNumber: 1, translation: "Manual English", explanation: "Client explanation" }] });
  client.setQueryData(["/api/devis", 42, "line-contexts"], { contexts: [] });
  const view = render(<QueryClientProvider client={client}><DevisTranslationSection devisId={42} devisCode="DEV-42" readOnly={readOnly}
    lineItems={[{ id: 100, devisId: 42, lineNumber: 1, description: "Texte français", checkNotes: "Private architect note" } as DevisLineItem]}
    reviewChecks={[{ id: 7, devisId: 42, lineItemId: 100, origin: "line_item", status: "open", query: "Confirm finish" }]} /></QueryClientProvider>);
  return { ...view, client };
}
afterEach(cleanup);
describe("saved package preview replaces unsafe competing autosave paths", () => {
  it("opens the one workspace at the structured row and field from the saved translation checklist", () => {
    mount(false);
    fireEvent.click(screen.getByRole("button", { name: "Approve translation" }));
    const listener = vi.fn();
    window.addEventListener("quotation-review-open", listener);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Locate figure issue" }));
      expect(listener).toHaveBeenCalledOnce();
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ devisId: 42, rowId: 100, field: "vatRate", page: 2 });
      expect(screen.getByText("Context editable")).toBeVisible();
    } finally { window.removeEventListener("quotation-review-open", listener); }
  });
  it("keeps saved wording mounted after a failed background refresh", async () => {
    const { client } = mount(false);
    client.getQueryCache().find({ queryKey: ["/api/devis", 42, "translation"], exact: true })!
      .setState({ status: "error", error: new Error("Temporary network error") });
    expect(await screen.findByText(/Your displayed content has been kept/)).toBeInTheDocument();
    expect(screen.getByText("Manual English")).toBeInTheDocument();
    expect(screen.getByText("Context editable")).toBeInTheDocument();
  });
  it.each([false, true])("routes ordinary/corrected (%s) quotation edits into the one workspace", async corrected => {
    mount(corrected);
    expect(screen.getByText("Manual English")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Context editable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve translation" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve translation" }));
    expect(screen.getByText("Approval checklist here")).toBeInTheDocument();
    const listener = vi.fn();
    window.addEventListener("quotation-review-open", listener);
    fireEvent.click(screen.getByRole("button", { name: "Review/edit quotation" }));
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe(42);
    window.removeEventListener("quotation-review-open", listener);
    expect(screen.getByRole("link", { name: "Original contractor PDF" })).toHaveAttribute("href", "/api/devis/42/pdf?variant=original");
  });
  it.each(["finalised", "processing", "pending"])("keeps context protected while %s", status => {
    mount(true, status);
    expect(screen.getByText("Context read-only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate explanation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Fill empty contexts" })).toBeDisabled();
    if (status === "finalised") {
      expect(screen.getByRole("button", { name: "Reopen for review" })).toBeEnabled();
      expect(screen.getByText(/To change context here, reopen for review first/)).toBeInTheDocument();
    }
  });
  it("does not permit edits or reopening for archived/inactive records", () => {
    mount(true, "finalised", true);
    expect(screen.getByText("Context read-only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate explanation" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reopen for review" })).toBeDisabled();
  });
  it("retains line-linked internal notes separately from the client wording", () => {
    mount(false);
    fireEvent.click(screen.getByRole("button", { name: /Notes \/ questions/ }));
    expect(screen.getByText("Private architect note")).toBeInTheDocument();
    expect(screen.getByText("Confirm finish")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show plain-English explanations" }));
    expect(screen.getByText("Client explanation")).toBeInTheDocument();
  });
});
