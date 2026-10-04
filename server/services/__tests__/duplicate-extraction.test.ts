import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ pool: { connect: async () => ({ query, release }) } }));
import { duplicateCorrection } from "../duplicate-extraction";

let archived = false;
let protectedRecord = false;
let evidence = false;
let prior: any = null;
let draft: any;
let rows: any[];
let translationStatus: string;
beforeEach(() => {
  archived = protectedRecord = evidence = false;
  prior = null;
  translationStatus = "draft";
  draft = { id: 1, project_id: 2, contractor_id: 3, status: "received", sign_off_stage: "received",
    amount_ht: "1795.00", amount_ttc: "2154.00", pdf_storage_key: "original.pdf", ai_extracted_data: {} };
  rows = [
    { id: 10, line_number: 10, description: "Composed of", total_ht: "1795.00" },
    { id: 11, line_number: 11, description: "Complete detailed item", total_ht: "1795.00" },
  ];
  query.mockReset(); release.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM duplicate_extraction_audit")) return { rows: prior ? [prior] : [] };
    if (sql.startsWith("SELECT * FROM devis WHERE")) return { rows: [draft] };
    if (sql.includes("SELECT archived_at")) return { rows: [{ archived_at: archived ? new Date() : null }] };
    if (sql.startsWith("SELECT * FROM devis_line_items")) return { rows };
    if (sql.startsWith("SELECT * FROM devis_translations")) return { rows: [{ status: translationStatus, line_translations: [] }] };
    if (sql.includes("AS protected")) return { rows: [{ protected: protectedRecord }] };
    if (sql.includes("AS present")) return { rows: [{ present: evidence }] };
    return { rows: [] };
  });
});
describe("audited duplicate correction", () => {
  it.each(["manual_signoff_at", "signed_pdf_storage_key", "signed_pdf_fetch_url_snapshot", "signed_off_via", "closed_at"])(
    "blocks durable %s evidence even after stage rollback", async field => {
      draft[field] = "persisted evidence";
      const preview: any = await duplicateCorrection(1, 10, 11);
      expect(preview.blockedReason).toContain("immutable");
      await expect(duplicateCorrection(1, 10, 11, { fingerprint: preview.fingerprint, actorId: 8, reason: "Duplicate" }))
        .rejects.toThrow("immutable");
    });
  it.each(["pending", "failed"])("does not promote %s translations to readiness", async status => {
    translationStatus = status;
    const preview: any = await duplicateCorrection(1, 10, 11);
    await duplicateCorrection(1, 10, 11, { fingerprint: preview.fingerprint, actorId: 8, reason: "Duplicate" });
    const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE devis_translations"))?.[0];
    expect(update).toBeTruthy();
    expect(update).not.toMatch(/\bstatus\s*=/);
  });
  it("previews but never automatically removes equal-price lines", async () => {
    const preview: any = await duplicateCorrection(1, 10, 11);
    expect(preview).toMatchObject({ beforeSumHt: "3590.00", afterSumHt: "1795.00",
      sourceTotalHt: "1795.00", discrepancyAfterHt: "0.00", blockedReason: null });
    expect(query.mock.calls.some(([sql]) => /DELETE|INSERT|UPDATE devis SET/.test(sql))).toBe(false);
  });
  it("audits before deleting, clears translation caches, preserves source figures and raw extraction", async () => {
    const preview: any = await duplicateCorrection(1, 10, 11);
    query.mockClear();
    await duplicateCorrection(1, 10, 11, { fingerprint: preview.fingerprint, actorId: 8, reason: "Duplicated heading verified against page 2" });
    const sql = query.mock.calls.map(c => c[0]);
    expect(sql.findIndex(s => s.startsWith("INSERT INTO duplicate_extraction_audit")))
      .toBeLessThan(sql.findIndex(s => s.startsWith("DELETE FROM devis_line_items")));
    expect(sql).toContain("COMMIT");
    expect(sql.some(s => s.includes("contexts_version=contexts_version+1"))).toBe(true);
    expect(sql.some(s => /UPDATE devis SET.*(?:amount_ht|amount_ttc|ai_extracted_data|pdf_storage_key)=/.test(s))).toBe(false);
    expect(release).toHaveBeenCalled();
  });
  it.each(["archived", "linked", "evidence", "signed"])("refuses protected %s state with rollback", async kind => {
    if (kind === "archived") archived = true;
    if (kind === "linked") protectedRecord = true;
    if (kind === "evidence") evidence = true;
    if (kind === "signed") draft.sign_off_stage = "client_signed_off";
    const preview: any = await duplicateCorrection(1, 10, 11);
    await expect(duplicateCorrection(1, 10, 11, { fingerprint: preview.fingerprint, actorId: 8, reason: "Duplicate" })).rejects.toThrow();
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([s]) => s.startsWith("DELETE"))).toBe(false);
  });
  it("refuses stale previews and foreign or identical retained lines", async () => {
    await expect(duplicateCorrection(1, 10, 11, { fingerprint: "stale", actorId: 8, reason: "Duplicate" })).rejects.toThrow("Quotation changed");
    await expect(duplicateCorrection(1, 10, 10)).rejects.toThrow("different lines");
    await expect(duplicateCorrection(1, 10, 99)).rejects.toThrow("different lines");
  });
  it("keeps discounts negative and includes remaining legitimate equal-price items", async () => {
    rows.push({ id: 12, line_number: 12, total_ht: "-95.00" }, { id: 13, line_number: 13, total_ht: "1795.00" });
    const preview: any = await duplicateCorrection(1, 10, 11);
    expect(preview.afterSumHt).toBe("3495.00");
    expect(preview.sourceTotalHt).toBe("1795.00");
  });
  it("replays an identical request without deleting or auditing twice", async () => {
    prior = { devis_id: 1, retained_line_id: 11, actor_id: 8, reason: "Duplicate", snapshot: { preview: { fingerprint: "original" } } };
    await expect(duplicateCorrection(1, 10, 11, { fingerprint: "original", actorId: 8, reason: "Duplicate" }))
      .resolves.toEqual({ corrected: true });
    expect(query.mock.calls.some(([s]) => s.startsWith("DELETE") || s.startsWith("INSERT"))).toBe(false);
    await expect(duplicateCorrection(1, 10, 11, { fingerprint: "different", actorId: 8, reason: "Duplicate" }))
      .rejects.toThrow("already been corrected");
  });
  it("rolls the audit and translation changes back if deletion fails", async () => {
    const preview: any = await duplicateCorrection(1, 10, 11);
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith("DELETE FROM devis_line_items")) throw new Error("dependent record");
      return original(sql, values);
    });
    await expect(duplicateCorrection(1, 10, 11, { fingerprint: preview.fingerprint, actorId: 8, reason: "Duplicate" }))
      .rejects.toThrow("dependent record");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});