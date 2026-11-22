// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArchitectQuotationEditor } from "../ArchitectQuotationEditor";
import { createCorrectionLine } from "../architect-correction-model";
import { setQuotationWork, quotationWorkBlocked } from "../quotation-review-state";
import type { ArchitectCorrectionSave, ArchitectCorrectionSnapshot } from "../architect-correction-model";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
const fetchMock = vi.fn();
const path = "/api/devis/42/architect-correction";
let persisted: ArchitectCorrectionSnapshot;
let saveError: { status: number; message: string } | null;
let saves: ArchitectCorrectionSave[];
const fixture = (): ArchitectCorrectionSnapshot => ({
  version: "working-v1",
  draft: { headerFr: "Menuiseries sur mesure", headerEn: "Custom joinery", explanationFr: "", explanationEn: "",
    summaryEn: "", discountHt: "0.00", lines: [
      { ...createCorrectionLine("priced", "line-101"), id: 101, descriptionFr: "Porte A",
        descriptionEn: "Door A — human translation", totalHt: "1795.00", unitPriceHt: "1795.00", vatRate: "10" },
      { ...createCorrectionLine("priced", "line-102"), id: 102, descriptionFr: "Porte B",
        descriptionEn: "Door B — human translation", totalHt: "1795.00", unitPriceHt: "1795.00", vatRate: "10" },
      { ...createCorrectionLine("priced", "line-103"), id: 103, descriptionFr: "Élément terminal",
        descriptionEn: "Terminal specification", totalHt: "915.00", unitPriceHt: "915.00", vatRate: "10" },
    ] },
  baseline: { ttc: "4955.50", sourceFileName: "original-contractor.pdf", sourceDigest: "sha256-source",
    confirmedAt: "2026-10-05T10:13:24Z", confirmedBy: "Camille Laurent" },
  blockedReason: null, financialBlockedReason: null,
  advisoryMessages: ["Legacy OCR manifest disagrees with human descriptions."], history: [],
});
const response = (data: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data),
});
it("copies only explicitly paired recovered French wording and saves its provenance", async () => {
  const fallback = fetchMock.getMockImplementation()!;
  const candidate = { attemptId: 27, sourceDigest: "a".repeat(64), expectedVersion: "working-v1", headerFr: "En-tête récupéré",
    lines: [{ index: 0, descriptionFr: "Passage récupéré du PDF", quantity: "47", unit: "m²", unitPriceHt: "82.13", totalHt: "3860.11" }] };
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/recovered-content") ? response({ candidate }) : fallback(url, options));
  mount(); await open();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/recovered-content"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Compare recovered content (optional)" }));
  await screen.findByLabelText("Recovered source passage");
  const copy = screen.getByRole("button", { name: "Append French wording to selected target" });
  expect(copy).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Recovered source passage"), { target: { value: "line:0" } });
  expect(copy).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Current target"), { target: { value: "row:line-102" } });
  fireEvent.click(copy);
  expect(saves).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].recoverySource).toEqual({ attemptId: 27, sourceDigest: "a".repeat(64) });
  expect(saves[0].lines[1]).toEqual({ ...fixture().draft.lines[1], descriptionFr: "Porte B\n\nPassage récupéré du PDF" });
  expect(saves[0].lines[0]).toEqual(fixture().draft.lines[0]);
});
it("recognises its own normalised save without a false conflict or unsaved backup", async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const result = await fallback(url, options);
    if (url === path && options?.method === "PUT") {
      persisted.draft.headerFr = persisted.draft.headerFr.replace(/\s+/g, " ");
      return response(structuredClone(persisted));
    }
    return result;
  });
  mount(); await open();
  fireEvent.change(screen.getByRole("textbox", { name: "French header" }), { target: { value: "Menuiseries\n\nQualification" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await screen.findByText(/Saved. Review and approve/);
  await waitFor(() => expect(quotationWorkBlocked(42)).toBe(false));
  expect(screen.queryByText(/Conflict · your draft/)).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "French header" })).toHaveValue("Menuiseries Qualification");
  fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
  await open();
  expect(screen.queryByText("Unsaved draft restored")).not.toBeInTheDocument();
});
it("blocks recovered wording when the candidate version differs from the original version", async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/recovered-content")
    ? response({ candidate: { attemptId: 27, sourceDigest: "a".repeat(64), expectedVersion: "old-version", headerFr: "Ancien texte", lines: [] } }) : fallback(url, options));
  mount(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Compare recovered content (optional)" }));
  await screen.findByLabelText("Recovered source passage");
  fireEvent.change(screen.getByLabelText("Recovered source passage"), { target: { value: "header" } });
  fireEvent.change(screen.getByLabelText("Current target"), { target: { value: "header" } });
  expect(screen.getByRole("button", { name: "Append French wording to selected target" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "French header" })).toHaveValue(fixture().draft.headerFr);
  expect(saves).toHaveLength(0);
});
it("incorporates recovered wording as genuine context while preserving all existing financial identities", async () => {
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/recovered-content")
    ? response({ candidate: { attemptId: 28, sourceDigest: "b".repeat(64), expectedVersion: "working-v1", headerFr: "Conditions de chantier", lines: [] } }) : fallback(url, options));
  mount(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Compare recovered content (optional)" }));
  await screen.findByLabelText("Recovered source passage");
  fireEvent.change(screen.getByLabelText("Recovered source passage"), { target: { value: "header" } });
  fireEvent.change(screen.getByLabelText("Current target"), { target: { value: "new-context" } });
  fireEvent.click(screen.getByRole("button", { name: "Add French wording as context only" }));
  expect(screen.getByRole("textbox", { name: "Full French description" })).toHaveValue("Conditions de chantier");
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].lines.slice(0, 3)).toEqual(fixture().draft.lines);
  expect(saves[0].lines[3]).toMatchObject({ kind: "context", included: false, id: null, descriptionFr: "Conditions de chantier", descriptionEn: "" });
  expect(saves[0].recoverySource).toEqual({ attemptId: 28, sourceDigest: "b".repeat(64) });
});
it("offers a context-only start for an empty quotation without displaying a computed zero", async () => {
  persisted.draft.lines = [];
  persisted.baseline = null;
  mount(); await open();
  expect(screen.getByText(/No working rows yet. Extraction may be incomplete/)).toBeInTheDocument();
  expect(screen.getByText("Not yet computable")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start a context-only draft row" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Full French description" }), { target: { value: "Descriptif en attente du chiffrage" } });
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].lines).toHaveLength(1);
  expect(saves[0].lines[0]).toMatchObject({ kind: "context", included: false, descriptionFr: "Descriptif en attente du chiffrage" });
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/source-baseline"))).toBe(false);
});
function mount(compact = false, hideTrigger = false, disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><ArchitectQuotationEditor devisId={42} projectId="8" compact={compact} hideTrigger={hideTrigger} disabled={disabled} /></QueryClientProvider>), client };
}
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "Edit working quotation" }));
  await screen.findByRole("textbox", { name: "French header" });
}
async function row(index: number) {
  const name = index === 1 ? /01 · Priced item/ : index === 2 ? /02 · Priced item/ : /03 · Priced item/;
  fireEvent.click(screen.getByRole("button", { name }));
  await screen.findByRole("textbox", { name: "Full French description" });
}
it("allows leaving during unrelated context work without clearing its safeguard", async () => {
  mount(); await open();
  setQuotationWork(42, "context:inline:500", true, "Context save failed.");
  try {
    fireEvent.click(screen.getAllByRole("button", { name: /^Close$/ })[0]);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "French header" })).toBeNull());
    expect(quotationWorkBlocked(42)).toBe(true);
  } finally {
    setQuotationWork(42, "context:inline:500", false);
  }
});
it("retains an exact requested stable row through asynchronous snapshot initialization", async () => {
  const fallback = fetchMock.getMockImplementation()!;
  let release: (() => void) | undefined;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === path && (!options?.method || options.method === "GET")) await new Promise<void>(resolve => { release = resolve; });
    return fallback(url, options);
  });
  mount(false, true);
  fireEvent(window, new CustomEvent("quotation-review-open", { detail: { devisId: 42, rowId: 102, field: "totalHt" } }));
  await waitFor(() => expect(release).toBeDefined());
  expect(screen.getByLabelText("Loading quotation editor")).toBeVisible();
  release!();
  expect(await screen.findByRole("region", { name: "Edit row 2" })).toBeVisible();
  expect(screen.getByLabelText("Full French description")).toHaveValue("Porte B");
  await waitFor(() => expect(screen.getByLabelText("Line amount HT (€)")).toHaveFocus());
  expect(saves).toHaveLength(0);
  fireEvent(window, new CustomEvent("quotation-review-open", { detail: { devisId: 42, field: "sourceTtc" } }));
  expect(await screen.findByLabelText("French header")).toHaveValue("Menuiseries sur mesure");
  expect(screen.getByText(/Finding target · Original PDF total including VAT/)).toHaveAttribute("role", "status");
  expect(screen.queryByText(/Finding target · sourceTtc/)).toBeNull();
});
it("locates a second requested row without overwriting an already open unsaved draft", async () => {
  mount(); await open(); await row(1);
  fireEvent.change(screen.getByLabelText("Full French description"), { target: { value: "Retained correction" } });
  fireEvent(window, new CustomEvent("quotation-review-open", { detail: { devisId: 42, rowId: 103 } }));
  expect(await screen.findByRole("region", { name: "Edit row 3" })).toBeVisible();
  await row(1);
  expect(screen.getByLabelText("Full French description")).toHaveValue("Retained correction");
  expect(saves).toHaveLength(0);
});
it("keeps an unsaved wording draft when closing and restores it on reopening", async () => {
  mount(); await open();
  fireEvent.change(screen.getByRole("textbox", { name: "French header" }), { target: { value: "My retained draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Close editor…" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep draft and close" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "French header" })).toBeNull());
  await open();
  expect(screen.getByRole("textbox", { name: "French header" })).toHaveValue("My retained draft");
  expect(saves).toHaveLength(0);
});
it("shows missing VAT together and lets the user repair it without losing wording", async () => {
  persisted = fixture();
  persisted.draft.lines[0].vatRate = "";
  persisted.draft.lines[1].vatRate = "";
  mount(); await open();
  expect(screen.getByRole("region", { name: "Financial checks" })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Item 1 VAT (%)"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("Item 2 VAT (%)"), { target: { value: "10" } });
  expect(screen.queryByRole("region", { name: "Financial checks" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].lines[0].descriptionEn).toBe("Door A — human translation");
});
it("recovers VAT into a reviewable draft and saves only on explicit confirmation", async () => {
  persisted = fixture();
  persisted.draft.lines.forEach(line => { line.vatRate = ""; });
  const fallback = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/source-vat")
    ? response({ expectedVersion: "working-v1", rates: persisted.draft.lines.map(line => ({ clientKey: line.clientKey, vatRate: "10.00" })) })
    : fallback(url, options));
  mount(); await open();
  fireEvent.click(screen.getByRole("button", { name: "Recover missing VAT from original PDF" }));
  await screen.findByText("Recovered VAT — review before saving");
  expect(saves).toHaveLength(0);
  expect(screen.getByLabelText("Item 1 VAT (%)")).toHaveValue("10.00");
  fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].lines[0].descriptionEn).toBe("Door A — human translation");
});
beforeEach(() => {
  sessionStorage.clear();
  persisted = fixture(); saveError = null; saves = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === path && options?.method === "PUT") {
      const request = JSON.parse(String(options.body)) as ArchitectCorrectionSave;
      saves.push(request);
      if (saveError) return response({ message: saveError.message, code: "STALE_VERSION" }, saveError.status);
      const { expectedVersion: _, ...draft } = request;
      persisted = { ...persisted, version: "working-v2", draft: { ...draft, lines: draft.lines.map((line, index) => line.id === null
        ? { ...line, id: 500 + index, clientKey: `line-${500 + index}` } : line) },
        history: [{ id: 1, actor: "Camille Laurent", savedAt: "2026-10-05T10:17:31Z", summary: "Human correction saved" }] };
      return response(persisted);
    }
    if (url === `${path}/source-baseline` && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      persisted = { ...persisted, version: "baseline-v2", baseline: { ...fixture().baseline!, ttc: body.ttc } };
      return response(persisted);
    }
    if (url === path) return response(persisted);
    if (url === "/api/devis/42/translation/readiness") return response({ version: persisted.version, status: "draft", blockers: [] });
    if (url === "/api/devis/42/line-contexts") return response({ contexts: [] });
    return response([]);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("architect editor persistence and source authority", () => {
  it("suggests only the extracted original total and confirms a match deliberately without a dummy edit or save", async () => {
    persisted.baseline = null;
    Object.assign(persisted, { extractedSourceTotal: { ttc: "4971.83" } });
    mount(); await open();
    fireEvent.click(screen.getByRole("button", { name: "Confirm source total (optional)" }));
    expect(screen.getByText(/This check has not been recorded yet/)).toBeVisible();
    expect(screen.getAllByText("4971,83 €")[0]).toBeVisible();
    expect(screen.getByLabelText("Provisional total comparison")).toHaveTextContent("Computed working TTC: 4955,50 €");
    expect(screen.getByLabelText("Provisional total comparison")).toHaveTextContent("Working minus proposed original TTC: -16,33 €");
    expect(screen.getByLabelText("Provisional total comparison")).toHaveTextContent("original PDF total not yet confirmed");
    expect(screen.getByRole("button", { name: "Confirm original PDF total" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Matches the PDF" }));
    expect(persisted.baseline).toBeNull();
    fireEvent.change(screen.getByLabelText("PDF page"), { target: { value: "4" } });
    expect(screen.getByRole("button", { name: "Confirm original PDF total" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I have read the original PDF/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm original PDF total" }));
    await screen.findByText("Original PDF total including VAT · confirmed");
    expect(persisted.baseline).toMatchObject({ ttc: "4971.83" });
    const request = fetchMock.mock.calls.find(([url, options]) => url === `${path}/source-baseline` && options?.method === "POST");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ expectedVersion: "working-v1", ttc: "4971.83", page: 4, confirmedFromPdf: true });
    expect(saves).toHaveLength(0);
    expect(screen.getByLabelText("French header")).toHaveValue(fixture().draft.headerFr);
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    expect(screen.getByText(/Difference from confirmed original PDF total/)).toBeVisible();
  });
  it("lets the architect replace an extracted suggestion without changing working wording or auto-confirming", async () => {
    persisted.baseline = null;
    Object.assign(persisted, { extractedSourceTotal: { ttc: "4971.83" } });
    mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Keep my wording" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm source total (optional)" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter a different total" }));
    const input = screen.getByLabelText("Final TTC on original PDF (€)");
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "4955,50" } });
    fireEvent.change(screen.getByLabelText("PDF page"), { target: { value: "2" } });
    fireEvent.click(screen.getByLabelText(/I have read the original PDF/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm original PDF total" }));
    await screen.findByText("Original PDF total including VAT · confirmed");
    expect(persisted.baseline).toMatchObject({ ttc: "4955.50" });
    expect(screen.getByLabelText("French header")).toHaveValue("Keep my wording");
    expect(saves).toHaveLength(0);
  });
  it.each([null, { ttc: "not an amount" }])("falls back to manual entry for absent or invalid extraction %j", async extractedSourceTotal => {
    persisted.baseline = null;
    Object.assign(persisted, { extractedSourceTotal });
    mount(); await open();
    fireEvent.click(screen.getByRole("button", { name: "Confirm source total (optional)" }));
    expect(screen.getByLabelText("Final TTC on original PDF (€)")).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Matches the PDF" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm original PDF total" })).toBeDisabled();
    expect(saves).toHaveLength(0);
  });
  it("keeps missing VAT visible instead of implying that a matching source suggestion repairs it", async () => {
    persisted.baseline = null;
    persisted.draft.lines[0].vatRate = "";
    persisted.extractedSourceTotal = { ttc: "4955.50" };
    mount(); await open();
    fireEvent.click(screen.getByRole("button", { name: "Confirm source total (optional)" }));
    fireEvent.click(screen.getByRole("button", { name: "Matches the PDF" }));
    expect(screen.getByLabelText("Provisional total comparison")).toHaveTextContent("Working TTC cannot yet be calculated");
    expect(screen.getByLabelText("Provisional total comparison")).toHaveTextContent("does not resolve those gaps");
    expect(screen.getByLabelText("Item 1 VAT (%)")).toHaveValue("");
    expect(persisted.baseline).toBeNull();
    expect(saves).toHaveLength(0);
  });
  it("opens from translation even when the source-section trigger is not visible", async () => {
    mount(false, true);
    expect(screen.queryByRole("button", { name: "Edit working quotation" })).not.toBeInTheDocument();
    fireEvent(window, new CustomEvent("quotation-review-open", { detail: 42 }));
    expect(await screen.findByRole("textbox", { name: "English header" })).toHaveValue("Custom joinery");
  });
  it("does not open the wrong quotation or an archived editor through an external signal", () => {
    const view = mount(false, true);
    fireEvent(window, new CustomEvent("quotation-review-open", { detail: 99 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.unmount();
    mount(false, true, true);
    fireEvent(window, new CustomEvent("quotation-review-open", { detail: 42 }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("reuses the real editor and original PDF from the compact action-rail trigger", async () => {
    mount(true);
    expect(screen.queryByText("Architect’s working version")).not.toBeInTheDocument();
    expect(screen.getByTestId("architect-correction-entry-42")).toHaveClass("review-source-editor-trigger");
    await open();
    expect(screen.getByLabelText("French header")).toHaveValue("Menuiseries sur mesure");
    expect(screen.getByRole("link", { name: "Open original contractor PDF" })).toHaveAttribute("href", "/api/devis/42/pdf?variant=original");
    expect(saves).toHaveLength(0);
  });
  it("uses unsaved corrected French for suggestions, fills only blank English and never saves automatically", async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/translation-suggestions")
      ? response({ expectedVersion: "working-v1",suggestion: { header: { description: "Do not overwrite human header",
        descriptionExplanation: "New empty-field explanation" },lines: [] } }) : fallback(url,options));
    mount(); await open();
    fireEvent.change(screen.getByRole("textbox", { name: "French header" }), { target: { value: "Corrected unsaved French" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill empty English fields" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "English header explanation" })).toHaveValue("New empty-field explanation"));
    expect(screen.getByRole("textbox", { name: "English header" })).toHaveValue("Custom joinery");
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/translation-suggestions"));
    expect(JSON.parse(String(call?.[1]?.body)).headerFr).toBe("Corrected unsaved French");
    expect(saves).toHaveLength(0);
  });
  it("visibly opens original-only PDF access and saves French/English/header/explanations without OCR approval", async () => {
    mount(); await open();
    expect(screen.getByRole("link", { name: "Open original contractor PDF" })).toHaveAttribute("href", "/api/devis/42/pdf?variant=original");
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Interprétation corrigée" } });
    fireEvent.change(screen.getByLabelText("English header"), { target: { value: "Human-approved interpretation" } });
    fireEvent.change(screen.getByLabelText("French header explanation"), { target: { value: "Explication libre" } });
    fireEvent.change(screen.getByLabelText("English header explanation"), { target: { value: "Independent explanatory content" } });
    await row(1);
    fireEvent.change(screen.getByLabelText("Full French description"), { target: { value: "Porte A, description complète." } });
    fireEvent.change(screen.getByLabelText("English translation"), { target: { value: "Door A, full reviewed specification." } });
    fireEvent.change(screen.getByLabelText("English explanation"), { target: { value: "Not machine-verified." } });
    expect(saves).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].expectedVersion).toBe("working-v1");
    expect(persisted.draft.lines[0]).toMatchObject({ id: 101, descriptionFr: "Porte A, description complète.",
      descriptionEn: "Door A, full reviewed specification.", explanationEn: "Not machine-verified.", totalHt: "1795.00" });
    expect(persisted.draft.headerFr).toBe("Interprétation corrigée");
    expect(persisted.draft.explanationFr).toBe("Explication libre");
    expect(fetchMock.mock.calls.find(call => call[1]?.method === "PUT")?.[1].credentials).toBe("include");
    await screen.findByText(/Saved. Review and approve/);
    fireEvent.click(screen.getAllByRole("button", { name: /^Close$/ })[0]);
    await open(); await row(1);
    expect(screen.getByLabelText("Full French description")).toHaveValue("Porte A, description complète.");
    expect(screen.getByLabelText("English translation")).toHaveValue("Door A, full reviewed specification.");
  });
  it("holds a whole financial batch until TTC reconciles, never auto-saves intermediate imbalance", async () => {
    mount(); await open(); await row(1);
    fireEvent.change(screen.getByLabelText("Line amount HT (€)"), { target: { value: "1796.00" } });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    expect(screen.getByText(/Working total including VAT must match/)).toBeVisible();
    expect(saves).toHaveLength(0);
    await row(2);
    fireEvent.change(screen.getByLabelText("Line amount HT (€)"), { target: { value: "1794.00" } });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(persisted.draft.lines.map(line => line.totalHt)).toEqual(["1796.00", "1794.00", "915.00"]);
  });
  it("adds contextual and priced rows and preserves existing equal-price IDs on reorder", async () => {
    mount(); await open(); await row(1);
    fireEvent.click(screen.getByRole("button", { name: "Move row down" }));
    fireEvent.click(screen.getByRole("button", { name: "Add context-only line" }));
    fireEvent.change(screen.getByLabelText("Full French description"), { target: { value: "Contexte sans supplément." } });
    expect(screen.queryByLabelText("Line amount HT (€)")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add priced line" }));
    fireEvent.change(screen.getByLabelText("Full French description"), { target: { value: "Nouveau poste inclus" } });
    fireEvent.change(screen.getByLabelText("Actual VAT rate (%)"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(persisted.draft.lines.slice(0, 3).map(line => line.id)).toEqual([102, 101, 103]);
    expect(persisted.draft.lines[3]).toMatchObject({ kind: "context", totalHt: "0.00", included: false });
    expect(persisted.draft.lines[4].kind).toBe("priced");
  });
  it("assigns a new context row identity before assets and blocks approval during the real upload and context save", async () => {
    const fallback = fetchMock.getMockImplementation()!;
    let finishUpload!: (value: ReturnType<typeof response>) => void;
    let finishContext!: (value: ReturnType<typeof response>) => void;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.endsWith("/line-contexts/503/assets")) return new Promise(resolve => { finishUpload = resolve; });
      if (url.endsWith("/line-contexts/503") && options?.method === "PUT") return new Promise(resolve => { finishContext = resolve; });
      return fallback(url, options);
    });
    mount(); await open();
    fireEvent.click(screen.getByRole("button", { name: "Add context-only line" }));
    fireEvent.change(screen.getByLabelText("Full French description"), { target: { value: "Détail de finition" } });
    fireEvent.change(screen.getByLabelText("English translation"), { target: { value: "Finish detail" } });
    expect(screen.getByText(/Save this new line before adding rich context/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(screen.getByTestId("input-context-file-42-4")).toBeInTheDocument());
    expect(persisted.draft.lines[3].id).toBe(503);
    fireEvent.change(screen.getByTestId("input-context-file-42-4"), { target: { files: [new File(["owned image"], "finish.jpg", { type: "image/jpeg" })] } });
    await screen.findByText("Uploading image · keep this workspace open.");
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Uploading image…" }));
    expect(screen.getByRole("textbox", { name: "Full French description" })).toBeInTheDocument();
    finishUpload(response({ id: 887 }));
    await waitFor(() => expect(finishContext).toBeDefined());
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    const put = fetchMock.mock.calls.find(([url, options]) => String(url).endsWith("/line-contexts/503") && options?.method === "PUT");
    const document = JSON.parse(String(put![1].body)).document;
    expect(JSON.stringify(document)).toContain('"assetId":887');
    finishContext(response({ id: 5, devisId: 42, devisLineItemId: 503, revision: 1, document }));
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /I reviewed the original PDF/ })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
  });
  it("preserves a stale draft on 409 and background reload, disabling force-save", async () => {
    mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "My unsaved draft" } });
    persisted.draft.headerFr = "Other architect’s newer header"; persisted.version = "concurrent-v2";
    saveError = { status: 409, message: "Expected version no longer matches." };
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByText("The quotation changed. Your draft has not been overwritten.");
    expect(screen.getByLabelText("French header")).toHaveValue("My unsaved draft");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download draft backup" })).toBeVisible();
  });
  it("restores an unsaved session draft after remount without replacing newer foreign fields", async () => {
    const view = mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Recovered French draft" } });
    view.unmount();
    persisted = structuredClone(persisted);
    persisted.version = "foreign-v2"; persisted.draft.summaryEn = "Foreign summary after navigation";
    mount(); await open();
    expect(screen.getByLabelText("French header")).toHaveValue("Recovered French draft");
    expect(screen.getByLabelText("English overview")).toHaveValue("Foreign summary after navigation");
    expect(saves).toHaveLength(0);
  });
  it("compares a stale draft in place, requires conflict choices and retains foreign non-overlapping changes on rebase", async () => {
    mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "My corrected French" } });
    persisted.draft.headerFr = "Foreign corrected French";
    persisted.draft.lines[1].descriptionEn = "Foreign updated second item";
    persisted.version = "concurrent-v2";
    saveError = { status: 409, message: "Expected version no longer matches." };
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await screen.findByRole("region", { name: "Compare concurrent changes" });
    expect(screen.getByRole("button", { name: "Rebase draft onto latest" })).toBeDisabled();
    expect(screen.getByLabelText("French header")).toHaveValue("My corrected French");
    fireEvent.click(screen.getByRole("radio", { name: /My draft/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rebase draft onto latest" }));
    saveError = null;
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1].expectedVersion).toBe("concurrent-v2");
    expect(saves[1].headerFr).toBe("My corrected French");
    expect(saves[1].lines[1]).toMatchObject({ id: 102, descriptionEn: "Foreign updated second item" });
  });
  it.each(["4955.50", "4 955,50"])("preserves unsaved text while confirming the PDF total entered as %s", async (amount) => {
    persisted.baseline = null;
    mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm source total (optional)" }));
    fireEvent.change(screen.getByLabelText("Final TTC on original PDF (€)"), { target: { value: amount } });
    expect(screen.getByLabelText("Provisional total comparison")).toHaveTextContent("No difference in these figures; the original PDF still needs your confirmation.");
    fireEvent.change(screen.getByLabelText("PDF page"), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "Confirm original PDF total" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I have read the original PDF/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm original PDF total" }));
    await screen.findByText("Original PDF total including VAT · confirmed");
    expect(persisted.baseline).toMatchObject({ ttc: "4955.50" });
    expect(screen.getByLabelText("French header")).toHaveValue("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves[0]?.expectedVersion).toBe("baseline-v2"));
  });
  it("approves an unchanged clean machine-verified quotation without saving or manually confirming TTC", async () => {
    persisted.baseline = null;
    mount(); await open();
    const confirm = await screen.findByRole("checkbox", { name: /I reviewed the original PDF/ });
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.queryByRole("region", { name: "Confirm source TTC" })).toBeNull();
    expect(screen.queryByLabelText("Final TTC on original PDF (€)")).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm source total (optional)" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Approve reviewed quotation" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, options]) =>
      url === "/api/devis/42/translation/finalise" && options?.method === "POST")).toBe(true));
    expect(saves).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url, options]) => url === `${path}/source-baseline` && options?.method === "POST")).toBe(false);
  });
  it.each(["SOURCE_CONFIRMATION_REQUIRED", "DESCRIPTION_CHARGE_UNVERIFIED"])("shows required source confirmation for %s and locates its field and PDF page", async (code) => {
    persisted.baseline = null;
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/translation/readiness")
      ? response({ version: persisted.version, status: "draft", blockers: [{ code, key: "opaque-source",
        message: "Confirmer la source", severity: "blocker", resolution: "review_source",
        target: { section: "source", field: "sourceTtc", page: 3 } }] }) : fallback(url, options));
    mount(); await open();
    expect(await screen.findByRole("region", { name: "Confirm source TTC" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: code === "SOURCE_CONFIRMATION_REQUIRED" ? /Original PDF total check not recorded yet/ : "Confirmer la source" }));
    await waitFor(() => expect(screen.getByLabelText("Final TTC on original PDF (€)")).toHaveFocus());
    expect(screen.getByTitle("Original contractor PDF")).toHaveAttribute("src", "/api/devis/42/pdf?variant=original#page=3");
    expect(screen.getByRole("button", { name: "Approve reviewed quotation" })).toBeDisabled();
    expect(saves).toHaveLength(0);
  });
  it("locates an exact figure using structured fields, not English messages or opaque issue keys", async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/translation/readiness")
      ? response({ version: persisted.version, status: "draft", blockers: [{ code: "FINANCIAL_FIELD_REQUIRED", key: "not-a-row-key",
        message: "Contrôler cette donnée", severity: "blocker", resolution: "edit_figures",
        target: { section: "financial", rowId: 102, field: "vatRate", page: 5 } }] }) : fallback(url, options));
    mount(); await open();
    fireEvent.click(await screen.findByRole("button", { name: "Contrôler cette donnée" }));
    await screen.findByRole("region", { name: "Edit row 2" });
    await waitFor(() => expect(screen.getByLabelText("Actual VAT rate (%)")).toHaveFocus());
    expect(screen.getByLabelText("Full French description")).toHaveValue("Porte B");
    expect(screen.getByTitle("Original contractor PDF")).toHaveAttribute("src", "/api/devis/42/pdf?variant=original#page=5");
  });
  it("keeps a confirmed baseline visible without requesting re-entry and preserves a dirty draft while toggling stacked PDF access", async () => {
    Object.assign(persisted, { extractedSourceTotal: { ttc: "4971.83" } });
    mount(); await open();
    expect(screen.getByText("Original PDF total including VAT · confirmed")).toBeVisible();
    expect(screen.queryByLabelText("Final TTC on original PDF (€)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Matches the PDF" })).toBeNull();
    const pdf = screen.getByTitle("Original contractor PDF");
    const pane = pdf.closest("aside")!;
    expect(pane).toHaveAttribute("data-source-open", "false");
    const toggle = screen.getByRole("button", { name: "Show source PDF alongside review" });
    expect(toggle).toHaveAttribute("aria-controls", pane.id);
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Kept while checking PDF" } });
    fireEvent.click(toggle);
    expect(pane).toHaveAttribute("data-source-open", "true");
    expect(screen.getByRole("link", { name: "Open PDF in new tab" })).toHaveAttribute("href", "/api/devis/42/pdf?variant=original");
    fireEvent.click(screen.getByRole("button", { name: "Hide source PDF" }));
    expect(pane).toHaveAttribute("data-source-open", "false");
    expect(screen.getByTitle("Original contractor PDF")).toBe(pdf);
    expect(screen.getByLabelText("French header")).toHaveValue("Kept while checking PDF");
    expect(saves).toHaveLength(0);
  });
  it("saves wording without a source baseline while requiring confirmation for actual financial edits", async () => {
    persisted.baseline = null;
    mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Wording only correction" } });
    expect(screen.queryByLabelText("Final TTC on original PDF (€)")).toBeNull();
    expect(screen.getByText(/Unsaved wording · can be saved/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].headerFr).toBe("Wording only correction");
    expect(saves[0].lines).toEqual(fixture().draft.lines);
    await row(1);
    fireEvent.change(screen.getByLabelText("Line amount HT (€)"), { target: { value: "1800.00" } });
    expect(await screen.findByRole("region", { name: "Confirm source TTC" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Save correction" })).toBeDisabled();
    expect(saves).toHaveLength(1);
  });
  it("keeps unsaved wording through a non-overlapping background snapshot refresh", async () => {
    const { client } = mount(); await open();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /I reviewed the original PDF/ })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Do not reset my draft" } });
    const fresh = fixture();
    fresh.version = "context-refresh-v2";
    fresh.draft.lines[1].descriptionEn = "New saved wording on another row";
    persisted = fresh;
    act(() => { client.setQueryData<ArchitectCorrectionSnapshot>(["/api/devis", 42, "architect-correction"], fresh); });
    await row(2);
    await waitFor(() => expect(screen.getByLabelText("English translation")).toHaveValue("New saved wording on another row"));
    fireEvent.click(screen.getByRole("button", { name: /Header & overview/ }));
    expect(screen.getByLabelText("French header")).toHaveValue("Do not reset my draft");
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0].expectedVersion).toBe("context-refresh-v2");
    expect(saves[0].headerFr).toBe("Do not reset my draft");
    expect(saves[0].lines[1].descriptionEn).toBe("New saved wording on another row");
  });
  it("keeps ordinary wording edits and save available after optional English suggestions fail", async () => {
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith("/translation-suggestions")
      ? response({ message: "AI service busy" }, 503) : fallback(url, options));
    mount(); await open();
    fireEvent.click(screen.getByRole("button", { name: "Fill empty English fields" }));
    await screen.findByText(/Optional English suggestions unavailable/);
    fireEvent.change(screen.getByLabelText("English header"), { target: { value: "My manual wording" } });
    expect(screen.getByRole("button", { name: "Save correction" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves[0]?.headerEn).toBe("My manual wording"));
  });
  it("protects committed finances while retaining text control, and exposes load retry", async () => {
    persisted.financialBlockedReason = "Progress claims already reference these prices.";
    mount(); await open(); await row(1);
    expect(screen.getByLabelText("Line amount HT (€)")).toBeDisabled();
    expect(screen.getByLabelText("Full French description")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add priced line" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add context-only line" })).toBeEnabled();
  });
});
