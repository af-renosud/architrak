// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArchitectQuotationEditor } from "../ArchitectQuotationEditor";
import { createCorrectionLine } from "../architect-correction-model";
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
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><ArchitectQuotationEditor devisId={42} projectId="8" /></QueryClientProvider>);
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
beforeEach(() => {
  persisted = fixture(); saveError = null; saves = [];
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    if (url === path && options?.method === "PUT") {
      const request = JSON.parse(String(options.body)) as ArchitectCorrectionSave;
      saves.push(request);
      if (saveError) return response({ message: saveError.message, code: "STALE_VERSION" }, saveError.status);
      const { expectedVersion: _, ...draft } = request;
      persisted = { ...persisted, version: "working-v2", draft,
        history: [{ id: 1, actor: "Camille Laurent", savedAt: "2026-10-05T10:17:31Z", summary: "Human correction saved" }] };
      return response(persisted);
    }
    if (url === `${path}/source-baseline` && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      persisted = { ...persisted, version: "baseline-v2", baseline: { ...fixture().baseline!, ttc: body.ttc } };
      return response(persisted);
    }
    if (url === path) return response(persisted);
    return response([]);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("architect editor persistence and source authority", () => {
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
