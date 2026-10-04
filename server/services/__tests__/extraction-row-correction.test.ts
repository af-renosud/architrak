import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { PDFDocument } from "pdf-lib";
const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
const documentStream = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ pool: { connect: async () => ({ query, release }) } }));
vi.mock("../../storage/object-storage", () => ({ getDocumentStream: documentStream }));
import { extractionRowCorrection } from "../extraction-row-correction";
import { extractionCorrectionSchema, type ExtractionCorrection } from "../../../shared/extraction-row-correction";

let devis: any, lines: any[], translation: any, archived: boolean, protectedRecord: boolean, evidence: boolean, prior: any;
let input: ExtractionCorrection;
beforeEach(async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  documentStream.mockReset().mockImplementation(async () => ({ stream: Readable.from([bytes]) }));
  archived = protectedRecord = evidence = false; prior = null;
  devis = { id: 1, project_id: 2, contractor_id: 3, status: "received", sign_off_stage: "received",
    amount_ht: "200.00", amount_ttc: "240.00", pdf_storage_key: "original.pdf", ai_extracted_data: { immutable: true } };
  lines = [{ id: 10, line_number: 1, description: "Work", total_ht: "100.00", quantity: "1.000",
    unit: "u", unit_price_ht: "100.00", percent_complete: "0.00", check_status: "unchecked" }];
  translation = { status: "draft", line_translations: [] };
  input = { kind: "missing", row: { lineNumber: 2, description: "Missing work", quantity: "1",
    unit: "u", unitPriceHt: "100.00", totalHt: "100.00" },
    evidence: { page: 1, excerpt: "Missing work 1 u 100.00 100.00" }, reason: "Row on page one was omitted during extraction." };
  query.mockReset(); release.mockReset();
  query.mockImplementation(async (sql: string, values: any[]) => {
    if (sql.includes("FROM extraction_row_corrections")) return { rows: prior ? [prior] : [] };
    if (sql.startsWith("SELECT * FROM devis WHERE")) return { rows: [devis] };
    if (sql.includes("SELECT archived_at")) return { rows: [{ archived_at: archived ? new Date() : null }] };
    if (sql.startsWith("SELECT * FROM devis_line_items")) return { rows: lines };
    if (sql.startsWith("SELECT * FROM devis_translations")) return { rows: [translation] };
    if (sql.includes("AS protected")) return { rows: [{ protected: protectedRecord }] };
    if (sql.includes("AS present")) return { rows: [{ present: evidence }] };
    if (/^(INSERT INTO|UPDATE) devis_line_items/.test(sql)) return { rows: [{
      id: 20, line_number: values[0], description: values[1], quantity: values[2], unit: values[3],
      unit_price_ht: values[4], total_ht: values[5], pdf_page_hint: values[6],
    }] };
    return { rows: [] };
  });
});
async function confirm() {
  const preview: any = await extractionRowCorrection(1, input);
  return extractionRowCorrection(1, input, { fingerprint: preview.fingerprint, actorId: 8, confirmed: true });
}
describe("source-backed row correction", () => {
  it("previews a missing row without writing and exposes unchanged source totals", async () => {
    const preview = await extractionRowCorrection(1, input);
    expect(preview).toMatchObject({ before: null, after: input.row, beforeSumHt: "100.00",
      afterSumHt: "200.00", sourceTotalHt: "200.00", sourceTotalTtc: "240.00", discrepancyAfterHt: "0.00" });
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });
  it.each(["missing", "misread"] as const)("audits %s and preserves PDF, raw extraction and document totals", async kind => {
    if (kind === "misread") input = { ...input, kind, lineId: 10, row: { ...input.row, lineNumber: 1 } };
    await confirm();
    const calls = query.mock.calls;
    const audit = calls.find(([sql]) => sql.startsWith("INSERT INTO extraction_row_corrections"))!;
    const snapshot = JSON.parse(audit[1][5]);
    expect(snapshot.source).toMatchObject({ storageKey: "original.pdf", rawExtraction: { immutable: true }, pages: 1 });
    expect(snapshot.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.request).toEqual(input);
    expect(snapshot.originalRow).toEqual(kind === "misread" ? lines[0] : null);
    expect(snapshot.confirmed).toBe(true);
    expect(calls.some(([sql]) => /UPDATE devis SET.*(?:amount_ht|amount_ttc|ai_extracted_data|pdf_storage_key)=/.test(sql))).toBe(false);
    expect(calls.some(([sql]) => sql.includes("contexts_version=contexts_version+1"))).toBe(true);
    expect(calls.map(c => c[0])).toContain("COMMIT");
  });
  it.each(["signed_pdf_storage_key", "manual_signoff_at", "closed_at", "archisign_envelope_id"])("blocks durable %s", async key => {
    devis[key] = "evidence";
    await expect(confirm()).rejects.toThrow("cannot be corrected");
  });
  it.each(["archived", "financial", "processing", "finalised", "row-evidence"])("blocks %s", async state => {
    if (state === "archived") archived = true;
    if (state === "financial") protectedRecord = true;
    if (state === "processing" || state === "finalised") translation.status = state;
    if (state === "row-evidence") {
      evidence = true; input = { ...input, kind: "misread", lineId: 10, row: { ...input.row, lineNumber: 1 } };
    }
    await expect(confirm()).rejects.toThrow();
    expect(query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)/.test(sql))).toBe(false);
  });
  it("rejects changed proposal, reason, source bytes and stale working rows", async () => {
    const preview: any = await extractionRowCorrection(1, input);
    for (const changed of [{ ...input, reason: "A different reason" },
      { ...input, row: { ...input.row, quantity: null } }]) {
      await expect(extractionRowCorrection(1, changed, { fingerprint: preview.fingerprint, actorId: 8, confirmed: true }))
        .rejects.toThrow("changed");
    }
    lines[0].total_ht = "90.00";
    await expect(extractionRowCorrection(1, input, { fingerprint: preview.fingerprint, actorId: 8, confirmed: true })).rejects.toThrow("changed");
    lines[0].total_ht = "100.00";
    const pdf = await PDFDocument.create(); pdf.addPage([200, 200]);
    const bytes = Buffer.from(await pdf.save());
    documentStream.mockImplementation(async () => ({ stream: Readable.from([bytes]) }));
    await expect(extractionRowCorrection(1, input, { fingerprint: preview.fingerprint, actorId: 8, confirmed: true })).rejects.toThrow("changed");
  });
  it("rejects foreign rows, duplicate numbering and out-of-range PDF evidence", async () => {
    await expect(extractionRowCorrection(1, { ...input, kind: "misread", lineId: 99 })).rejects.toThrow("does not belong");
    input.row.lineNumber = 1;
    await expect(confirm()).rejects.toThrow("Line number");
    input.evidence.page = 2;
    await expect(extractionRowCorrection(1, input)).rejects.toThrow("outside");
  });
  it("rolls back working mutation if audit persistence fails", async () => {
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql, values) => {
      if (sql.startsWith("INSERT INTO extraction_row_corrections")) throw new Error("audit unavailable");
      return base(sql, values);
    });
    await expect(confirm()).rejects.toThrow("audit unavailable");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });
  it("makes exact retries idempotent but refuses different actors or payloads", async () => {
    prior = { devis_id: 1, actor_id: 8, snapshot: { request: input } };
    await expect(extractionRowCorrection(1, input, { fingerprint: "used", actorId: 8, confirmed: true })).resolves.toEqual({ corrected: true });
    await expect(extractionRowCorrection(1, input, { fingerprint: "used", actorId: 9, confirmed: true })).rejects.toThrow("differently");
  });
  it("rejects source-total edits, missing reasons, ambiguous operations and excess precision", () => {
    for (const invalid of [{ ...input, amountHt: "999" }, { ...input, reason: "  " },
      { ...input, lineId: 10 }, { ...input, kind: "misread" },
      { ...input, row: { ...input.row, totalHt: "1.234" } }])
      expect(extractionCorrectionSchema.safeParse(invalid).success).toBe(false);
  });
});