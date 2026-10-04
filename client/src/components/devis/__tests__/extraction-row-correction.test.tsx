// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { projectScopedKey } from "@/lib/queryClient";
import { ExtractionRowCorrection } from "../ExtractionRowCorrection";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const row = { lineNumber: 3, description: "Oak door", quantity: "2.00", unit: "u", unitPriceHt: "137.25", totalHt: "274.50" };
const line = { ...row, id: 18, devisId: 42 };
const foreign = { ...line, id: 19, devisId: 43, description: "Foreign quotation row" };
const preview = {
  fingerprint: "checked-original-v1", blockedReason: null, before: null, after: row,
  beforeSumHt: "623.17", afterSumHt: "897.67", sourceTotalHt: "897.67", sourceTotalTtc: "1077.20",
  discrepancyBeforeHt: "-274.50", discrepancyAfterHt: "0.00",
};
const fetchMock = vi.fn();
const confirmName = "Confirm extraction correction";
const reasonLabel = "Typed reason for correcting this extraction (required)";
function mount(lines = [line, foreign], disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const rendered = render(<QueryClientProvider client={client}>
    <ExtractionRowCorrection devisId={42} projectId="7" lines={lines} disabled={disabled} />
  </QueryClientProvider>);
  return { client, invalidate, ...rendered };
}
function open() { fireEvent.click(screen.getByRole("button", { name: "Correct missing / misread extraction" })); }
function edit(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function fillEvidence() {
  edit("Original PDF page (required)", "2");
  edit("Verbatim excerpt from the original PDF (required)", "Oak door   2 u   137.25   274.50");
  edit(reasonLabel, "Row printed on page two was omitted from extraction.");
}
function fillMissing() {
  edit("Line number (required)", "3");
  edit("Description (required)", "Oak door");
  edit("Total HT (required)", "274.50");
  fillEvidence();
}
async function getPreview() {
  fireEvent.click(screen.getByRole("button", { name: "Preview extraction correction" }));
  return screen.findByRole("region", { name: "Server financial preview" });
}
function attest() { fireEvent.click(screen.getByRole("checkbox")); }
function correctionCalls() { return fetchMock.mock.calls.filter(([url]) => url.endsWith("/extraction-corrections")); }
function respond(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }

beforeEach(() => {
  fetchMock.mockReset().mockImplementation((url) => Promise.resolve(respond(url.endsWith("/extraction-corrections") ? {} : preview)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("audited extraction row correction", () => {
  it("works with zero rows, requires typed evidence, financial preview and original-review attestation", async () => {
    const { invalidate } = mount([]);
    open();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview extraction correction" })).toBeDisabled();
    fillMissing();
    edit(reasonLabel, "   ");
    expect(screen.getByRole("button", { name: "Preview extraction correction" })).toBeDisabled();
    edit(reasonLabel, "Row printed on page two was omitted from extraction.");
    expect(screen.getByRole("link", { name: /Review original PDF/ })).toHaveAttribute("href", "/api/devis/42/pdf?variant=original#page=2");
    const financial = await getPreview();
    expect(within(financial).getByText("1077.20 EUR")).toBeInTheDocument();
    expect(within(financial).getByText("-274.50 EUR")).toBeInTheDocument();
    expect(within(financial).getByText("No extracted row (missing from extraction).")).toBeInTheDocument();
    const after = within(financial).getByRole("region", { name: "After correction" });
    for (const label of ["Line number", "Description", "Quantity", "Unit", "Unit price HT", "Total HT"]) {
      expect(within(after).getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    attest();
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await waitFor(() => expect(correctionCalls()).toHaveLength(1));
    expect(JSON.parse(correctionCalls()[0][1].body)).toEqual({
      kind: "missing",
      row: { ...row, quantity: null, unit: null, unitPriceHt: null },
      evidence: { page: 2, excerpt: "Oak door   2 u   137.25   274.50" },
      reason: "Row printed on page two was omitted from extraction.",
      fingerprint: preview.fingerprint, confirmed: true,
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectScopedKey("7") });
  });

  it("prefills an explicitly selected same-quotation misread row and shows every before field", async () => {
    fetchMock.mockImplementation((url) => Promise.resolve(respond(url.endsWith("/extraction-corrections") ? {} : { ...preview, before: row })));
    mount(); open();
    edit("Correction type", "misread");
    expect(screen.queryByRole("option", { name: /Foreign quotation row/ })).not.toBeInTheDocument();
    edit("Extracted row to correct (same quotation)", "18");
    expect(screen.getByLabelText("Quantity (optional)")).toHaveValue("2.00");
    expect(screen.getByLabelText("Unit price HT (optional)")).toHaveValue("137.25");
    fillEvidence();
    edit("Description (required)", "Oak door, corrected transcription");
    const financial = await getPreview();
    expect(within(financial).getByRole("region", { name: "Before correction" })).toHaveTextContent("137.25");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expect.objectContaining({
      kind: "misread", lineId: 18, row: expect.objectContaining({ description: "Oak door, corrected transcription" }),
    }));
    attest();
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await waitFor(() => expect(correctionCalls()).toHaveLength(1));
    expect(JSON.parse(correctionCalls()[0][1].body).lineId).toBe(18);
  });

  it.each([
    ["Description (required)", "Oak door revised"],
    ["Original PDF page (required)", "3"],
    ["Verbatim excerpt from the original PDF (required)", "New exact excerpt"],
    [reasonLabel, "More precise human explanation"],
    ["Quantity (optional)", "3.00"],
    ["Correction type", "misread"],
  ])("invalidates the preview when %s changes", async (label, value) => {
    mount(); open(); fillMissing(); await getPreview(); attest();
    edit(label, value);
    expect(screen.queryByRole("region", { name: "Server financial preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(correctionCalls()).toHaveLength(0);
  });

  it("rejects invalid page, line number and decimals before preview", () => {
    mount([]); open(); fillMissing();
    for (const [label, value, restore] of [
      ["Original PDF page (required)", "0", "2"],
      ["Line number (required)", "1.2", "3"],
      ["Total HT (required)", "NaN", "274.50"],
      ["Quantity (optional)", "not a number", ""],
    ]) {
      edit(label, value);
      expect(screen.getByRole("button", { name: "Preview extraction correction" })).toBeDisabled();
      edit(label, restore);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a server refusal and never enables confirmation", async () => {
    fetchMock.mockResolvedValue(respond({ ...preview, blockedReason: "Quotation is locked." }));
    mount(); open(); fillMissing(); await getPreview();
    expect(screen.getByRole("alert")).toHaveTextContent("Quotation is locked.");
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
  });

  it("preserves entries after submission failure and requires a fresh preview and attestation", async () => {
    fetchMock.mockImplementation((url) => Promise.resolve(respond(url.endsWith("/extraction-corrections") ? { message: "Stale fingerprint" } : preview, url.endsWith("/extraction-corrections") ? 409 : 200)));
    mount(); open(); fillMissing(); await getPreview(); attest();
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Generate a new financial preview");
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Row printed on page two was omitted from extraction.");
    expect(screen.getByLabelText("Verbatim excerpt from the original PDF (required)")).toHaveValue("Oak door   2 u   137.25   274.50");
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    await getPreview();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
  });

  it("requires retry after preview failure without discarding input", async () => {
    fetchMock.mockResolvedValueOnce(respond({ message: "Preview unavailable" }, 503));
    mount(); open(); fillMissing();
    fireEvent.click(screen.getByRole("button", { name: "Preview extraction correction" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Description (required)")).toHaveValue("Oak door");
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    await getPreview();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a stale preview response after an edit", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    mount(); open(); fillMissing();
    fireEvent.click(screen.getByRole("button", { name: "Preview extraction correction" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    edit(reasonLabel, "Edited while the preview was running.");
    await act(async () => { resolve(respond(preview)); });
    expect(screen.queryByRole("region", { name: "Server financial preview" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    await getPreview();
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).reason).toBe("Edited while the preview was running.");
  });

  it("prevents double submission, editing and closing while recording", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementation((url) => url.endsWith("/extraction-corrections") ?
      new Promise<Response>((done) => { resolve = done; }) : Promise.resolve(respond(preview)));
    mount(); open(); fillMissing(); await getPreview(); attest();
    const button = screen.getByRole("button", { name: confirmName });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(correctionCalls()).toHaveLength(1));
    expect(screen.getByLabelText(reasonLabel)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => { resolve(respond({})); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("retains entries but discards review when cancelled and reopened; respects disabled", async () => {
    mount(); open(); fillMissing(); await getPreview(); attest();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    open();
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Row printed on page two was omitted from extraction.");
    expect(screen.queryByRole("region", { name: "Server financial preview" })).not.toBeInTheDocument();
    expect(correctionCalls()).toHaveLength(0);
    cleanup();
    mount([], true);
    expect(screen.getByRole("button", { name: "Correct missing / misread extraction" })).toBeDisabled();
  });
});