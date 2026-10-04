// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DuplicateExtractionCorrection } from "../DuplicateExtractionCorrection";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const removed = { id: 10, devisId: 42, lineNumber: 10, description: "Aluminium opening", totalHt: "1795.00" };
const retained = { id: 11, devisId: 42, lineNumber: 11, description: "Detailed aluminium opening", totalHt: "1795.00" };
const legitimate = { id: 12, devisId: 42, lineNumber: 12, description: "Separate opening, same price", totalHt: "1795.00" };
const foreign = { id: 13, devisId: 43, lineNumber: 13, description: "Other quotation", totalHt: "1795.00" };
const preview = {
  removeLine: removed, retainLine: retained,
  beforeSumHt: "5397.23", afterSumHt: "3602.23", sourceTotalHt: "3590.00",
  discrepancyBeforeHt: "1807.23", discrepancyAfterHt: "12.23",
  fingerprint: "preview-version-1", blockedReason: null,
};
const fetchMock = vi.fn();
const confirmName = "Confirm duplicate extraction removal";
const reasonLabel = "Reason for correcting this extraction (required)";
function mount(disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rendered = render(<QueryClientProvider client={client}>
    <DuplicateExtractionCorrection devisId={42} projectId="7" line={removed} lines={[removed, retained, legitimate, foreign]} disabled={disabled} />
  </QueryClientProvider>);
  return { client, ...rendered };
}
function open() { fireEvent.click(screen.getByRole("button", { name: "Remove duplicate extraction" })); }
async function selectRetained() {
  fireEvent.change(screen.getByLabelText("Retained counterpart (same quotation)"), { target: { value: "11" } });
  await screen.findByRole("region", { name: "Server financial preview" });
}
function typeReason(value = "The short heading was extracted again as the detailed row.") {
  fireEvent.change(screen.getByLabelText(reasonLabel), { target: { value } });
}
function postCalls() { return fetchMock.mock.calls.filter(([, options]) => options.method === "POST"); }
beforeEach(() => {
  fetchMock.mockReset().mockImplementation((_url, options) => Promise.resolve(new Response(
    JSON.stringify(options.method === "POST" ? { ok: true } : preview), { status: 200 },
  )));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("SpeechRecognition", undefined);
  vi.stubGlobal("webkitSpeechRecognition", undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("duplicate extraction correction", () => {
  it("requires an explicit same-quotation counterpart and a nonblank human reason", async () => {
    mount(); open();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(screen.queryByRole("option", { name: /Other quotation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /#10/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Separate opening, same price/ })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await selectRetained();
    typeReason("   ");
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(screen.getByText(/Dictation is not supported/)).toBeInTheDocument();
    typeReason();
    expect(screen.getByRole("button", { name: confirmName })).toBeEnabled();
    expect(postCalls()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/devis/42/duplicate-correction-preview?removeLineId=10&retainLineId=11",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });
  it("displays server values, never derives source totals from local equal-price rows", async () => {
    mount(); open(); await selectRetained();
    for (const amount of ["5397.23", "3602.23", "3590.00", "1807.23", "12.23"]) {
      expect(screen.getByText(`${amount} EUR`)).toBeInTheDocument();
    }
    expect(screen.getByText("Source total HT · immutable")).toBeInTheDocument();
    expect(screen.getByText(/Source totals are never adjusted/)).toBeInTheDocument();
  });
  it("posts only IDs, reviewed reason and fingerprint once; refreshes quotation and project queries", async () => {
    const { client } = mount();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    open(); await selectRetained(); typeReason("  Verified against PDF page 2: repeated heading.  ");
    const confirm = screen.getByRole("button", { name: confirmName });
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(postCalls()[0]).toEqual([
      "/api/devis/42/duplicate-corrections",
      expect.objectContaining({ credentials: "include", body: JSON.stringify({
        removeLineId: 10, retainLineId: 11, reason: "Verified against PDF page 2: repeated heading.", fingerprint: preview.fingerprint,
      }) }),
    ]);
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/devis", 42] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/projects", "7"] });
  });
  it("preserves typed text and forbids mutation when preview fails; offers retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "Preview unavailable" }), { status: 503 }));
    mount(); open(); typeReason("Keep this pending explanation.");
    fireEvent.change(screen.getByLabelText("Retained counterpart (same quotation)"), { target: { value: "11" } });
    await screen.findByText(/Financial preview failed: Preview unavailable/);
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Keep this pending explanation.");
    expect(postCalls()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry financial preview" }));
    await screen.findByRole("region", { name: "Server financial preview" });
    expect(screen.getByRole("button", { name: confirmName })).toBeEnabled();
  });
  it("requires a refreshed preview after a stale submission and preserves pending reason", async () => {
    fetchMock.mockImplementation((_url, options) => Promise.resolve(new Response(JSON.stringify(
      options.method === "POST" ? { message: "Quotation changed. Review again." } : preview,
    ), { status: options.method === "POST" ? 409 : 200 })));
    mount(); open(); await selectRetained(); typeReason("Verified duplicate heading.");
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await screen.findByText(/Quotation changed. Review again./);
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Verified duplicate heading.");
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry financial preview" }));
    await waitFor(() => expect(screen.getByRole("button", { name: confirmName })).toBeEnabled());
    expect(postCalls()).toHaveLength(1);
  });
  it("shows a protected-state refusal without offering financial workarounds", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...preview, blockedReason: "This line is linked to an issued situation." }), { status: 200 }));
    mount(); open(); await selectRetained(); typeReason();
    expect(screen.getByRole("alert")).toHaveTextContent("Correction refused: This line is linked to an issued situation.");
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(postCalls()).toHaveLength(0);
  });
  it("rejects malformed or mismatched previews instead of authorizing removal", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...preview, retainLine: { ...retained, id: 99 } }), { status: 200 }));
    mount(); open(); typeReason();
    fireEvent.change(screen.getByLabelText("Retained counterpart (same quotation)"), { target: { value: "11" } });
    await screen.findByText(/preview does not match the selected lines/);
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(postCalls()).toHaveLength(0);
  });
  it("is read-only when archived", () => {
    mount(true);
    expect(screen.getByRole("button", { name: "Remove duplicate extraction" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cannot remove a line when no same-quotation counterpart exists", () => {
    const client = new QueryClient();
    render(<QueryClientProvider client={client}>
      <DuplicateExtractionCorrection devisId={42} projectId="7" line={removed} lines={[removed, foreign]} />
    </QueryClientProvider>);
    open(); typeReason();
    expect(screen.getByText(/No other line in this quotation can be retained/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("does not reuse an old preview after the retained counterpart changes during loading", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementation((url, options) => {
      if (url.includes("retainLineId=11")) return new Promise<Response>((resolve) => { resolveOld = resolve; });
      return Promise.resolve(new Response(JSON.stringify(options.method === "POST" ? {} : {
        ...preview, retainLine: legitimate, fingerprint: "new-pair-fingerprint", afterSumHt: "3601.91",
      }), { status: 200 }));
    });
    mount(); open(); typeReason();
    fireEvent.change(screen.getByLabelText("Retained counterpart (same quotation)"), { target: { value: "11" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Retained counterpart (same quotation)"), { target: { value: "12" } });
    await screen.findByText("3601.91 EUR");
    await act(async () => { resolveOld(new Response(JSON.stringify(preview), { status: 200 })); });
    expect(screen.queryByText("3602.23 EUR")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(postCalls()[0][1].body)).toEqual(expect.objectContaining({
      retainLineId: 12, fingerprint: "new-pair-fingerprint",
    }));
  });
  it("cancellation never submits and retains pending text when reopened", async () => {
    mount(); open(); await selectRetained(); typeReason("Pending evidence.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(postCalls()).toHaveLength(0);
    open();
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Pending evidence.");
  });
});

class MockSpeech {
  static current: MockSpeech;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() { MockSpeech.current = this; }
}
describe("optional browser dictation", () => {
  it("falls back to typing when recognition cannot start", () => {
    class FailingSpeech extends MockSpeech {
      start = vi.fn(() => { throw new Error("Speech service unavailable"); });
    }
    vi.stubGlobal("SpeechRecognition", FailingSpeech);
    mount(); open(); typeReason("Pending typed explanation.");
    fireEvent.click(screen.getByRole("button", { name: "Dictate reason" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Dictation could not start");
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Pending typed explanation.");
    expect(postCalls()).toHaveLength(0);
  });
  it("renders an editable transcript, never submits on speech completion, then submits reviewed edits", async () => {
    vi.stubGlobal("SpeechRecognition", MockSpeech);
    mount(); open(); await selectRetained();
    fireEvent.click(screen.getByRole("button", { name: "Dictate reason" }));
    expect(screen.getByRole("button", { name: confirmName })).toBeDisabled();
    act(() => {
      MockSpeech.current.onresult?.({ results: [{ isFinal: true, 0: { transcript: "Repeated heading on page two." } }] });
      MockSpeech.current.onend?.();
    });
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Repeated heading on page two.");
    expect(postCalls()).toHaveLength(0);
    typeReason("Reviewed against the PDF: repeated heading on page two.");
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(JSON.parse(postCalls()[0][1].body).reason).toBe("Reviewed against the PDF: repeated heading on page two.");
  });
  it("speech failure preserves typing and never removes anything", async () => {
    vi.stubGlobal("webkitSpeechRecognition", MockSpeech);
    mount(); open(); await selectRetained(); typeReason("Typed evidence.");
    fireEvent.click(screen.getByRole("button", { name: "Dictate reason" }));
    act(() => MockSpeech.current.onerror?.({ error: "not-allowed" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Dictation failed (not-allowed)");
    expect(screen.getByLabelText(reasonLabel)).toHaveValue("Typed evidence.");
    expect(postCalls()).toHaveLength(0);
    typeReason("Further reviewed evidence.");
    expect(screen.getByRole("button", { name: confirmName })).toBeEnabled();
  });
  it("aborts speech and disconnects callbacks on close and unmount", () => {
    vi.stubGlobal("SpeechRecognition", MockSpeech);
    const { unmount } = mount(); open();
    fireEvent.click(screen.getByRole("button", { name: "Dictate reason" }));
    const first = MockSpeech.current;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(first.abort).toHaveBeenCalledOnce();
    expect(first.onresult).toBeNull();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Dictate reason" }));
    const second = MockSpeech.current;
    unmount();
    expect(second.abort).toHaveBeenCalledOnce();
    expect(second.onresult).toBeNull();
    expect(postCalls()).toHaveLength(0);
  });
});