// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupportingPdfsPanel, supportingPdfsLockReason } from "../SupportingPdfsPanel";
import { moveSupportingPdf, validateSupportingPdf, type SupportingPdf } from "../use-supporting-pdfs";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../PdfPopoutViewer", () => ({
  PdfPopoutViewer: ({ pdfUrl }: { pdfUrl: string }) => <div data-testid="pdf-preview">{pdfUrl}</div>,
}));

const documents: SupportingPdf[] = [
  { id: 12, label: "Window elevations", fileName: "windows.pdf", pageCount: 3, byteSize: 284922, position: 0 },
  { id: 18, label: "Ground floor plan", fileName: "ground.pdf", pageCount: 1, byteSize: 151811, position: 1 },
];
const fetchMock = vi.fn();
function mount(props: Partial<Parameters<typeof SupportingPdfsPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><SupportingPdfsPanel devisId={42} {...props} /></QueryClientProvider>);
  return client;
}
beforeEach(() => {
  cleanup();
  fetchMock.mockReset().mockImplementation(() => Promise.resolve(new Response(JSON.stringify(documents), { status: 200 })));
  vi.stubGlobal("fetch", fetchMock);
});

describe("supporting PDF panel", () => {
  it("shows document order and opens only a scoped authenticated PDF URL", async () => {
    mount();
    await screen.findByText("Window elevations");
    expect(screen.getByRole("button", { name: "Move Window elevations earlier" })).toBeDisabled();
    fireEvent.click(screen.getByText("Window elevations"));
    expect(screen.getByTestId("pdf-preview")).toHaveTextContent("/api/devis/42/supporting-pdfs/12/pdf");
  });
  it("posts the exact reordered ID set and refreshes the list", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Move Ground floor plan earlier" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/devis/42/supporting-pdfs/reorder",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ids: [18, 12] }), credentials: "include" })));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/devis/42/supporting-pdfs").length).toBe(2));
  });
  it("renames through a prefilled form", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Window elevations" }));
    const input = screen.getByLabelText("Document label");
    expect(input).toHaveValue("Window elevations");
    fireEvent.change(input, { target: { value: "East elevation" } });
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/devis/42/supporting-pdfs/12",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ label: "East elevation" }) })));
  });
  it("requires confirmation before removal", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Ground floor plan" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove PDF" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/devis/42/supporting-pdfs/18", expect.objectContaining({ method: "DELETE" })));
  });
  it("uploads as multipart with credentials", async () => {
    mount();
    await screen.findByText("Window elevations");
    fireEvent.change(screen.getByLabelText("Upload supporting PDF"), {
      target: { files: [new File(["%PDF-1.7"], "windows.pdf", { type: "application/pdf" })] },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/devis/42/supporting-pdfs/upload",
      expect.objectContaining({ method: "POST", body: expect.any(FormData), credentials: "include" })));
  });
  it.each([
    { isArchived: true },
    { status: "void" },
    { signOffStage: "client_signed_off" },
    { hasSigningSnapshot: true },
    { signOffStage: "sent_to_client" },
  ])("locks mutations but keeps viewing available: %j", async (props) => {
    mount(props);
    await screen.findByText("Window elevations");
    expect(screen.getByRole("button", { name: "Add PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename Window elevations" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Window elevations" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Window elevations" })).toBeEnabled();
    expect(supportingPdfsLockReason(props)).toBeTruthy();
  });
  it("shows a composed empty state", async () => {
    fetchMock.mockResolvedValue(new Response("[]"));
    mount();
    expect(await screen.findByText("Keep the plans with the quotation.")).toBeVisible();
  });
  it("surfaces a loading error and retries", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Connection interrupted"));
    mount();
    await screen.findByText("Supporting documents could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Window elevations")).toBeVisible();
  });
  it("keeps the rename dialog open when the server refuses a write", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Rename Window elevations" }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Package is locked for signing" }), { status: 409 }));
    fireEvent.click(screen.getByRole("button", { name: "Save label" }));
    expect(await screen.findByText("Package is locked for signing")).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});

describe("document input and order helpers", () => {
  it("rejects non-PDF and empty files before sending", () => {
    expect(validateSupportingPdf(new File(["abc"], "plan.png"))).toBeTruthy();
    expect(validateSupportingPdf(new File([], "plan.pdf"))).toBeTruthy();
    expect(validateSupportingPdf(new File(["%PDF"], "plan.PDF"))).toBeNull();
  });
  it("preserves the exact set and never mutates source documents", () => {
    expect(moveSupportingPdf(documents, 12, 1)).toEqual([18, 12]);
    expect(moveSupportingPdf(documents, 12, -1)).toEqual([12, 18]);
    expect(moveSupportingPdf(documents, 99, 1)).toEqual([12, 18]);
    expect(documents.map((document) => document.id)).toEqual([12, 18]);
  });
});