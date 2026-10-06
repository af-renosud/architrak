// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PennylaneInvoiceDescription } from "../PennylaneInvoiceDescription";
import { invoiceDescriptionKey } from "../use-invoice-description";

vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));

const description = "Opening Deposit - No accompanying contractor invoice.\nProject: Maison Delorme — Certificate #37.";
const clients: QueryClient[] = [];

function setup(client = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: false } },
})) {
  if (!clients.includes(client)) clients.push(client);
  return {
    client,
    ...render(<QueryClientProvider client={client}><PennylaneInvoiceDescription certId={37} /></QueryClientProvider>),
  };
}

function respond(text = description) {
  vi.mocked(apiRequest).mockResolvedValue({ json: async () => ({ description: text }) } as Response);
}

function clipboard(writeText: ReturnType<typeof vi.fn> | undefined) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: writeText ? { writeText } : undefined });
}

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.resetAllMocks();
  clipboard(undefined);
  window.getSelection()?.removeAllRanges();
});

describe("PennylaneInvoiceDescription", () => {
  it("loads with accessible skeletons and performs only the description GET", () => {
    vi.mocked(apiRequest).mockReturnValue(new Promise(() => {}));
    setup();
    expect(screen.getByRole("status", { name: "Chargement de la description" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copier la description" })).not.toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledExactlyOnceWith("GET", "/api/certificats/37/invoice-description");
  });

  it("copies the exact backend paragraph and announces success", async () => {
    respond();
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    setup();
    const button = await screen.findByRole("button", { name: "Copier la description" });
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description de la facture en anglais").textContent).toBe(description);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Description copiée."));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(description);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "unavailable"])("offers manual selection when the clipboard is %s", async (mode) => {
    respond();
    clipboard(mode === "rejected" ? vi.fn().mockRejectedValue(new Error("Permission denied")) : undefined);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Copier la description" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("La copie automatique a échoué"));
    fireEvent.click(screen.getByRole("button", { name: "Sélectionner le texte" }));
    expect(window.getSelection()?.toString()).toBe(description);
    expect(screen.getByLabelText("Description de la facture en anglais")).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Texte sélectionné");
  });

  it("shows an accessible error and retries without any mutations", async () => {
    vi.mocked(apiRequest).mockRejectedValueOnce(new Error("Service indisponible"));
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Service indisponible");
    expect(screen.queryByRole("button", { name: "Copier la description" })).not.toBeInTheDocument();
    respond();
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await screen.findByRole("button", { name: "Copier la description" });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiRequest).mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("refetches on every mount despite infinitely fresh cached data", async () => {
    respond();
    const first = setup();
    await screen.findByRole("button", { name: "Copier la description" });
    first.unmount();
    respond("Updated certificate description");
    setup(first.client);
    await waitFor(() => expect(screen.getByLabelText("Description de la facture en anglais")).toHaveTextContent("Updated certificate description"));
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(first.client.getQueryData(invoiceDescriptionKey(37))).toEqual({ description: "Updated certificate description" });
  });
});
