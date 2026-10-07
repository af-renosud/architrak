// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryClient } from "@/lib/queryClient";
import type { EmailDocumentWithFiling } from "@shared/email-document-filing";
import EmailDocuments from "../email-documents";

vi.mock("@/components/layout/AppLayout", () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function doc(id: number, name: string) {
  return {
    id, attachmentFileName: name, extractionStatus: "completed", documentType: "quotation", projectId: null,
    emailFrom: "atelier@example.test", emailSubject: "Plans à vérifier",
    filing: { state: "not_filed", label: "Not filed", reason: null, intakeId: null, projectId: null, promotedKind: null, promotedId: null, destination: null, isActive: false },
  } as EmailDocumentWithFiling;
}
const docs = [doc(118, "Menuiserie.pdf"), doc(119, "Façade.pdf")];
const request = vi.fn();
beforeEach(() => {
  queryClient.clear();
  window.history.replaceState(null, "", "/email-documents");
  queryClient.setQueryData(["/api/email-documents"], docs);
  queryClient.setQueryData(["/api/projects"], []);
  queryClient.setQueryData(["/api/gmail/status"], { configured: false });
  queryClient.setQueryData(["/api/email-documents/settings/purge"], { purgeDays: 30 });
  queryClient.setQueryData(["/api/admin/email-documents/queue-stats"], { pending: 0 });
  request.mockReset().mockImplementation(async (url: string) => {
    if (url === "/api/email-documents/bulk-dismiss") return new Response(JSON.stringify({
      removed: 1, refused: 1, results: [{ id: 118, outcome: "dismissed" }, { id: 119, outcome: "refused", message: "Confirmed deposit evidence" }],
    }), { status: 200 });
    return new Response(JSON.stringify(docs), { status: 200 });
  });
  vi.stubGlobal("fetch", request);
});
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); });

describe("existing email bulk dismiss", () => {
  it("keeps the existing batch endpoint, confirms filenames, and only clears successful selections", async () => {
    render(<QueryClientProvider client={queryClient}><EmailDocuments /></QueryClientProvider>);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Menuiserie.pdf" }));
    expect(screen.getByRole("checkbox", { name: "Select all email documents shown" }).getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all email documents shown" }));
    fireEvent.click(screen.getByTestId("button-dismiss-selected"));
    expect(screen.getByRole("list", { name: "Email documents to remove" }).textContent).toContain("Façade.pdf");
    fireEvent.click(screen.getByTestId("button-confirm-dismiss"));
    await waitFor(() => expect(screen.getByText("Façade.pdf: Confirmed deposit evidence")).toBeTruthy());
    expect(request).toHaveBeenCalledWith("/api/email-documents/bulk-dismiss", expect.objectContaining({
      method: "POST", body: JSON.stringify({ ids: [118, 119] }), credentials: "include",
    }));
    expect(screen.getByRole("checkbox", { name: "Select Façade.pdf" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Select Menuiserie.pdf" }).getAttribute("aria-checked")).toBe("false");
  });
});
