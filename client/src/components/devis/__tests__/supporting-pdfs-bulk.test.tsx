// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupportingPdfsPanel } from "../SupportingPdfsPanel";
import type { SupportingPdf } from "../use-supporting-pdfs";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("../PdfPopoutViewer", () => ({ PdfPopoutViewer: () => null }));

const documents: SupportingPdf[] = [
  { id: 14, label: "Plans de fenêtres", fileName: "fenetres.pdf", pageCount: 3, byteSize: 287291, position: 0 },
  { id: 19, label: "Plan du rez-de-chaussée", fileName: "rdc.pdf", pageCount: 1, byteSize: 137531, position: 1 },
];
const request = vi.fn();
const clients: QueryClient[] = [];

function mount(props: Partial<Parameters<typeof SupportingPdfsPanel>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><SupportingPdfsPanel devisId={48} {...props} /></QueryClientProvider>);
}

beforeEach(() => {
  request.mockReset().mockResolvedValue(new Response(JSON.stringify(documents), { status: 200 }));
  // A fresh Response is needed for every refetch.
  request.mockImplementation(async () => new Response(JSON.stringify(documents), { status: 200 }));
  vi.stubGlobal("fetch", request);
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); vi.unstubAllGlobals(); });

describe("supporting PDF bulk removal integration", () => {
  it("uses scoped single-item DELETE mutations, refreshes real hook data, and retains a guarded refusal", async () => {
    let current = [...documents];
    request.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method === "DELETE") {
        if (url.endsWith("/19")) return new Response(JSON.stringify({ message: "Package became locked for signing" }), { status: 409 });
        current = current.filter((doc) => doc.id !== 14);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify(current), { status: 200 });
    });
    mount();
    await screen.findByText("Plans de fenêtres");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all eligible documents shown" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove PDFs selected" }));
    expect(screen.getByRole("list", { name: "Documents to process" }).textContent).toContain("Plans de fenêtres");
    fireEvent.click(screen.getByRole("button", { name: "Remove PDFs 2 documents" }));
    await waitFor(() => expect(screen.getByText("1 completed · 1 failed")).toBeTruthy());
    expect(request.mock.calls.filter(([, options]) => options?.method === "DELETE").map(([url]) => url))
      .toEqual(["/api/devis/48/supporting-pdfs/14", "/api/devis/48/supporting-pdfs/19"]);
    expect(request).toHaveBeenCalledWith("/api/devis/48/supporting-pdfs/14", expect.objectContaining({ method: "DELETE", credentials: "include" }));
    expect(screen.getByText("Package became locked for signing")).toBeTruthy();
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select Plan du rez-de-chaussée" }).getAttribute("aria-checked")).toBe("true");
  });

  it.each([{ isArchived: true }, { status: "signed" }, { hasSigningSnapshot: true }, { status: "void" }])("never selects or removes locked packages: %j", async (props) => {
    mount(props);
    await screen.findByText("Plans de fenêtres");
    expect((screen.getByRole("checkbox", { name: "Select all eligible documents shown" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove PDFs selected" }) as HTMLButtonElement).disabled).toBe(true);
    expect(request.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });
});
