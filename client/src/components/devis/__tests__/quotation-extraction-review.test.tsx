// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { QuotationExtractionReview } from "../QuotationExtractionReview";
import { compareInitialQuotation } from "../../../../../server/services/quotation-source-manifest";

const fetchMock = vi.fn();
const reviewPath = "/api/devis/42/extraction-review";
const evidence = {
  quotationVerification: {
    verified: true,
    manifest: {
      segments: [{ id: "door-1", page: 2, section: "door", disposition: "item", text: "Oak door, acoustic seal" }],
      sections: [{ id: "door", quantity: 2, total: 274.5 }],
      inventoriedPages: [1, 2],
    },
    failures: ["Unreconciled source section door"],
    coverage: { issues: [{ segmentId: "door-1", page: 2, section: "door", kind: "missing" }] },
  },
};
const data = { events: [], evidence, sourcePdfUrl: "/api/devis/42/pdf?variant=original", candidateAttemptId: null };
const summary = { processed: 17, reviewed: 6, inaccurate: 3, repeatFailures: 2, effortMinutes: 43, categories: [{ category: "missing_text", count: 3 }] };
const candidateData = {
  ...data,
  candidateAttemptId: 81,
  evidence: {
    quotationVerification: {
      ...evidence.quotationVerification,
      initialComparison: [{
        initialRow: 1, initialText: "Oak door",
        page: 2, sourceText: "Oak door, acoustic seal", section: "door", status: "different",
      }],
      proposedLineItems: [{ description: "Oak door, acoustic seal — complete contractor specification.", quantity: 2, total: 274.5, page: 2 }],
    },
  },
};
it("labels the actual comparison response as OCR versus independently collected source", async () => {
  const initial = "DOOR 01, oak door.";
  const original = "DOOR 01, oak door, acoustic seal.";
  const region = { page: 2, x: 0, y: 0, w: 1, h: 0.5 };
  const comparison = compareInitialQuotation([{ description: initial, pageHint: 1 }],
    { documentType: "quotation", lineItems: [{ description: original }] }, {
      sections: [{ id: "door", reference: "DOOR 01", independentText: original, priceRegion: { ...region, page: 1 },
        specificationRegions: [region], quantity: 2, unitPrice: 137.25, total: 274.5 }],
      inventoriedPages: [1, 2], segments: [{ id: "source", section: "door", page: 2, region,
        text: original, disposition: "item" }],
    });
  fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.startsWith("/api/extraction-review/summary")
    ? summary : { ...candidateData, sourcePdfUrl: "/api/devis/42/pdf", evidence: { quotationVerification: {
      ...candidateData.evidence.quotationVerification, initialComparison: comparison,
    } } })));
  mount(); await ready();
  const ocr = screen.getByText("Initial OCR row / passage").parentElement!;
  const independent = screen.getByText("Independently collected source passage").parentElement!;
  expect(within(ocr).getByText(initial)).toBeVisible();
  expect(within(independent).getByText(original)).toBeVisible();
  expect(within(independent).queryByText(initial)).toBeNull();
  expect(screen.getByRole("link", { name: "Open original contractor PDF" }))
    .toHaveAttribute("href", "/api/devis/42/pdf?variant=original");
});

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function mount(disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><QuotationExtractionReview devisId={42} projectId="7" disabled={disabled} /></QueryClientProvider>);
  return { client, invalidate };
}
async function ready() {
  await screen.findByRole("link", { name: "Open original contractor PDF" });
}
function openForm() {
  fireEvent.click(screen.getByText("Record a review outcome"));
}
function edit(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
beforeEach(() => {
  fetchMock.mockReset().mockImplementation((url: string, options: RequestInit) => {
    if (options.method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(response(url.startsWith("/api/extraction-review/summary") ? summary : data));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("quotation extraction review", () => {
  it("shows authenticated PDF, source inventory and discrepancies without trusting an automated verified flag", async () => {
    mount();
    await ready();
    expect(screen.getByRole("link", { name: "Open original contractor PDF" })).toHaveAttribute("href", data.sourcePdfUrl);
    fireEvent.click(screen.getByText("Source inventory & discrepancy evidence · 1 segments"));
    expect(within(screen.getByRole("region", { name: "Source inventory" })).getByText("Oak door, acoustic seal")).toBeVisible();
    const discrepancies = within(screen.getByRole("region", { name: "Discrepancy details" }));
    expect(discrepancies.getByText("Unreconciled source section door")).toBeVisible();
    expect(discrepancies.getByText("missing")).toBeVisible();
    expect(screen.getByText(/Matching TTC totals do not establish/)).toBeVisible();
    expect(screen.getByText(/Unreviewed extractions are not verified/)).toBeVisible();
    fireEvent.click(screen.getByText("Review history · 0 events"));
    expect(screen.getByText(/No review events recorded/)).toBeVisible();
    expect(fetchMock.mock.calls.every(([, options]) => options.credentials === "include")).toBe(true);
  });

  it("validates typed reason and whole minutes, posts the exact contract and invalidates review plus all summary periods", async () => {
    const { invalidate } = mount();
    await ready();
    openForm();
    const submit = screen.getByRole("button", { name: "Record review" });
    expect(submit).toBeDisabled();
    edit("Review reason (required)", "   ");
    expect(submit).toBeDisabled();
    edit("Review reason (required)", " Missing acoustic seal in description. ");
    for (const value of ["-1", "1.5", ""]) {
      edit("Review effort (minutes)", value);
      expect(submit).toBeDisabled();
    }
    edit("Review effort (minutes)", "8");
    edit("Review outcome", "confirmed_inaccurate");
    edit("Review category", "missing_text");
    fireEvent.click(submit);
    await screen.findByText(/Review recorded. Quotation rows/);
    const posts = fetchMock.mock.calls.filter(([, options]) => options.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(reviewPath);
    expect(JSON.parse(posts[0][1].body)).toEqual({
      outcome: "confirmed_inaccurate", category: "missing_text",
      reason: "Missing acoustic seal in description.", effortMinutes: 8,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [reviewPath] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["/api/extraction-review/summary"] });
  });

  it("selects 7/30/90-day monitoring and shows empty monitoring", async () => {
    mount();
    await ready();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/extraction-review/summary?days=30", expect.anything()));
    edit("Period", "7");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/extraction-review/summary?days=7", expect.anything()));
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes("summary") ?
      { processed: 0, reviewed: 0, inaccurate: 0, repeatFailures: 0, effortMinutes: 0, categories: [] } : data)));
    edit("Period", "90");
    await screen.findByText("No processed quotations in this period.");
    expect(fetchMock).toHaveBeenCalledWith("/api/extraction-review/summary?days=90", expect.anything());
  });

  it("preserves entries on forbidden POST, permits retry and does not modify permission gates", async () => {
    fetchMock.mockImplementation((url: string, options: RequestInit) =>
      Promise.resolve(response(options.method === "POST" ? { message: "Permission denied" } :
        url.includes("summary") ? summary : data, options.method === "POST" ? 403 : 200)));
    mount();
    await ready();
    openForm();
    edit("Review reason (required)", "Checked page two.");
    fireEvent.click(screen.getByRole("button", { name: "Record review" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
    expect(screen.getByLabelText("Review reason (required)")).toHaveValue("Checked page two.");
    expect(screen.getByRole("button", { name: "Record review" })).toBeEnabled();
  });

  it("keeps archived review inputs disabled", async () => {
    mount(true);
    await ready();
    openForm();
    expect(screen.getByLabelText("Review reason (required)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Record review" })).toBeDisabled();
    expect(screen.getByText(/Review recording is unavailable/)).toBeVisible();
  });

  it("shows loading and request errors with retry, handles absent evidence", async () => {
    let resolveReview: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((url: string) => url === reviewPath ?
      new Promise<Response>((resolve) => { resolveReview = resolve; }) : Promise.resolve(response(summary)));
    mount();
    expect(screen.getByLabelText("Loading extraction evidence")).toBeVisible();
    resolveReview!(response({ message: "Evidence temporarily unavailable" }, 503));
    await screen.findByText("Evidence temporarily unavailable");
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url === reviewPath ? { ...data, evidence: null } : summary)));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await ready();
    fireEvent.click(screen.getByText("Source inventory & discrepancy evidence · 0 segments"));
    expect(screen.getByText(/No source segments supplied/)).toBeVisible();
    expect(screen.getByText(/No discrepancies supplied/)).toBeVisible();
  });

  it("requires both declarations and a 12-character reason before applying the immutable prepared candidate", async () => {
    fetchMock.mockImplementation((url: string, options: RequestInit) => Promise.resolve(
      options.method === "POST" ? new Response(null, { status: 204 }) :
        response(url.includes("summary") ? summary : candidateData)));
    const { invalidate } = mount();
    await ready();
    expect(screen.getByText("Prepared candidate · Pending approval (attempt 81)")).toBeVisible();
    expect(screen.getByText("Oak door, acoustic seal — complete contractor specification.")).toBeVisible();
    expect(screen.getByText("Proposed row 1 · Page 2")).toBeVisible();
    expect(screen.getByRole("region", { name: "Initial OCR differences" })).toBeVisible();
    const submit = screen.getByRole("button", { name: "Approve and apply prepared candidate" });
    const original = screen.getByRole("checkbox", { name: /I have reviewed the original source PDF/ });
    const ocr = screen.getByRole("checkbox", { name: /The differing initial OCR passages/ });
    expect(submit).toBeDisabled();
    edit("Candidate approval reason (at least 12 characters)", "Source page confirms omitted acoustic seal.");
    expect(submit).toBeDisabled();
    fireEvent.click(original);
    expect(submit).toBeDisabled();
    fireEvent.click(ocr);
    expect(submit).toBeEnabled();
    edit("Candidate approval reason (at least 12 characters)", "   Too short   ");
    expect(submit).toBeDisabled();
    edit("Candidate approval reason (at least 12 characters)", " Source page confirms omitted acoustic seal. ");
    fireEvent.click(submit);
    await screen.findByText("Prepared candidate attempt 81 applied. The original source PDF is unchanged.");
    expect(screen.getByText("Prepared candidate · Applied (attempt 81)")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve and apply prepared candidate" })).not.toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, options]) => options.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe(`${reviewPath}/apply`);
    expect(JSON.parse(posts[0][1].body)).toEqual({
      attemptId: 81, reason: "Source page confirms omitted acoustic seal.",
      reviewedOriginal: true, initialDifferencesAreOcrErrors: true,
    });
    expect(posts[0][1].credentials).toBe("include");
    for (const queryKey of [[reviewPath], ["/api/devis", 42], ["/api/devis/42"], ["/api/projects", "7"], ["/api/extraction-review/summary"]]) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey });
    }
  });

  it("preserves candidate reason and declarations when independent source revalidation rejects apply", async () => {
    fetchMock.mockImplementation((url: string, options: RequestInit) => Promise.resolve(response(
      options.method === "POST" ? { message: "Uncertain source inventory — application refused" } :
        url.includes("summary") ? summary : candidateData, options.method === "POST" ? 409 : 200)));
    const { invalidate } = mount();
    await ready();
    edit("Candidate approval reason (at least 12 characters)", "Page two confirms the complete description.");
    fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed the original source PDF/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /The differing initial OCR passages/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve and apply prepared candidate" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Uncertain source inventory");
    expect(screen.getByRole("alert")).toHaveTextContent("current rows are unchanged");
    expect(screen.getByLabelText("Candidate approval reason (at least 12 characters)")).toHaveValue("Page two confirms the complete description.");
    expect(screen.getByRole("checkbox", { name: /I have reviewed the original source PDF/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /The differing initial OCR passages/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Approve and apply prepared candidate" })).toBeEnabled();
    expect(screen.getByText("Prepared candidate · Pending approval (attempt 81)")).toBeVisible();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps candidate approval read-only for archived projects", async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(response(url.includes("summary") ? summary : candidateData)));
    mount(true);
    await ready();
    expect(screen.getByRole("checkbox", { name: /I have reviewed the original source PDF/ })).toBeDisabled();
    expect(screen.getByLabelText("Candidate approval reason (at least 12 characters)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve and apply prepared candidate" })).toBeDisabled();
    expect(screen.getByText(/Archived project: candidate review is read-only/)).toBeVisible();
  });
});