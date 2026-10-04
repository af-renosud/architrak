// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DuplicateExtractionHistoryEntry } from "@shared/schema";
import { DuplicateExtractionHistory } from "../DuplicateExtractionHistory";
import { duplicateExtractionHistoryKey } from "../use-duplicate-extraction-history";

const fetchMock = vi.fn();
const entry: DuplicateExtractionHistoryEntry = {
  id: 8,
  createdAt: "2026-02-18T14:37:00.000Z",
  actor: { id: 3, name: "Camille Laurent" },
  reason: "Verified against page 2.\nRepeated heading, not another opening.",
  removedLine: { id: 10, lineNumber: 4, description: "Aluminium opening heading", totalHt: "1795.00" },
  retainedLine: { id: 11, lineNumber: 5, description: "Detailed aluminium opening", totalHt: "1795.00" },
  reconciliation: {
    sourceTotalHt: "3590.00", beforeSumHt: "5397.23", afterSumHt: "3602.23",
    discrepancyBeforeHt: "1807.23", discrepancyAfterHt: "12.23",
  },
};

function mount(devisId = 42) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}>
    <DuplicateExtractionHistory devisId={devisId} />
  </QueryClientProvider>);
  return { client, ...rendered };
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Duplicate extraction correction history" }));
}
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("duplicate extraction correction history", () => {
  it("loads only on opening and displays a composed empty state", async () => {
    mount();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    open();
    expect(await screen.findByText("No duplicate extraction corrections recorded.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/devis/42/duplicate-corrections",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    open();
    expect(screen.queryByText("No duplicate extraction corrections recorded.")).not.toBeInTheDocument();
    open();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows loading evidence while the request is pending", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    mount(); open();
    expect(screen.getByRole("status", { name: "Loading correction history" })).toBeInTheDocument();
    await act(async () => { resolve(new Response(JSON.stringify([]), { status: 200 })); });
    expect(await screen.findByText("No duplicate extraction corrections recorded.")).toBeInTheDocument();
  });

  it("renders actor, time, reason, both line references and every server amount as plain text", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([entry]), { status: 200 }));
    const { container } = mount(); open();
    expect(await screen.findByText(entry.actor.name)).toBeInTheDocument();
    expect(container.querySelector("time")).toHaveAttribute("datetime", entry.createdAt);
    expect(container.querySelector("time")).toHaveTextContent(/18 Feb 2026/);
    expect(screen.getByText(/Verified against page 2/)).toHaveTextContent(/Repeated heading/);
    expect(screen.getByText("Removed extracted line #4")).toBeInTheDocument();
    expect(screen.getByText("Retained extracted line #5")).toBeInTheDocument();
    for (const line of [entry.removedLine, entry.retainedLine]) {
      expect(screen.getByText(line.description)).toBeInTheDocument();
      expect(screen.getByText(`Line ID ${line.id}`)).toBeInTheDocument();
    }
    expect(screen.getAllByText("1795.00 EUR HT")).toHaveLength(2);
    for (const value of Object.values(entry.reconciliation)) {
      expect(screen.getByText(`${value} EUR HT`)).toBeInTheDocument();
    }
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.querySelector("img, iframe")).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows request errors and allows a successful retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "History unavailable" }), { status: 503 }));
    mount(); open();
    expect(await screen.findByRole("alert")).toHaveTextContent("History unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry correction history" }));
    expect(await screen.findByText("No duplicate extraction corrections recorded.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses quotation-scoped cache keys and refreshes on reopening after correction invalidation", async () => {
    const { client } = mount(); open();
    await screen.findByText("No duplicate extraction corrections recorded.");
    open();
    // The correction mutation invalidates this quotation prefix on success.
    await act(async () => { await client.invalidateQueries({ queryKey: ["/api/devis", 42] }); });
    expect(client.getQueryState(duplicateExtractionHistoryKey(42))?.isInvalidated).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockResolvedValue(new Response(JSON.stringify([entry]), { status: 200 }));
    open();
    expect(await screen.findByText(entry.actor.name)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});