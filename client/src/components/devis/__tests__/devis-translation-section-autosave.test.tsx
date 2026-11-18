// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DevisLineItem } from "@shared/schema";
import { DevisTranslationSection } from "../DevisTranslationSection";

vi.mock("../DevisCostAnalysisCard", () => ({ DevisCostAnalysisCard: () => null }));
vi.mock("../DevisLineContextEditor", () => ({ DevisLineContextEditor: ({ readOnly }: { readOnly: boolean }) => <div>Context {readOnly ? "read-only" : "editable"}</div> }));
function mount(architectControlled: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/api/devis", 42, "translation"], { status: "draft", architectControlled, headerTranslated: { summary: "Reviewed overview" },
    lineTranslations: [{ lineNumber: 1, translation: "Manual English", explanation: "Client explanation" }] });
  client.setQueryData(["/api/devis", 42, "line-contexts"], { contexts: [] });
  return render(<QueryClientProvider client={client}><DevisTranslationSection devisId={42} devisCode="DEV-42"
    lineItems={[{ id: 100, devisId: 42, lineNumber: 1, description: "Texte français", checkNotes: "Private architect note" } as DevisLineItem]}
    reviewChecks={[{ id: 7, devisId: 42, lineItemId: 100, origin: "line_item", status: "open", query: "Confirm finish" }]} /></QueryClientProvider>);
}
afterEach(cleanup);
describe("saved package preview replaces unsafe competing autosave paths", () => {
  it.each([false, true])("routes ordinary/corrected (%s) quotation edits into the one workspace", async corrected => {
    mount(corrected);
    expect(screen.getByText("Manual English")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Context read-only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approve|Re-translate|Regenerate/ })).not.toBeInTheDocument();
    const listener = vi.fn();
    window.addEventListener("quotation-review-open", listener);
    fireEvent.click(screen.getByRole("button", { name: "Review/edit quotation" }));
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe(42);
    window.removeEventListener("quotation-review-open", listener);
    expect(screen.getByRole("link", { name: "Original contractor PDF" })).toHaveAttribute("href", "/api/devis/42/pdf?variant=original");
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
