// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
function mount(compact = false, hideTrigger = false, disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ArchitectQuotationEditor devisId={42} projectId="8" compact={compact} hideTrigger={hideTrigger} disabled={disabled} /></QueryClientProvider>);
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
    expect(screen.getByText(/The batch TTC must equal/)).toBeVisible();
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
  it("preserves unsaved text while establishing a PDF-backed missing source baseline", async () => {
    persisted.baseline = null;
    mount(); await open();
    fireEvent.change(screen.getByLabelText("French header"), { target: { value: "Keep this draft" } });
    fireEvent.change(screen.getByLabelText("Final TTC on original PDF (€)"), { target: { value: "4955.50" } });
    fireEvent.change(screen.getByLabelText("PDF page"), { target: { value: "3" } });
    expect(screen.getByRole("button", { name: "Lock source TTC" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I have read the original PDF/));
    fireEvent.click(screen.getByRole("button", { name: "Lock source TTC" }));
    await screen.findByText("Source TTC · locked independently");
    expect(screen.getByLabelText("French header")).toHaveValue("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saves[0]?.expectedVersion).toBe("baseline-v2"));
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
