import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Opt-in, private source never committed. All writes use a disposable schema,
// with private sequences; providers, translation, Drive and production are untouched.
const state = vi.hoisted(() => ({ db: null as any, pool: null as any, bytes: null as any }));
vi.mock("../gmail/document-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gmail/document-parser")>();
  return { ...actual, parseDocument: (bytes: Buffer, name: string, deps: any) => actual.parseDocument(bytes, name, {
    ...deps,
    getActiveModel: async () => { throw new Error("AI forbidden in isolated native recovery verification"); },
    pdfToImagesWithCoverage: async () => { throw new Error("Rendering forbidden in isolated native recovery verification"); },
  }) };
});
vi.mock("../db", () => ({ get db() { return state.db; }, get pool() { return state.pool; } }));
vi.mock("../storage/object-storage", () => ({ getDocumentBuffer: async () => state.bytes }));
vi.mock("../services/devis-translation", () => ({ triggerDevisTranslation: vi.fn() }));
vi.mock("../services/drive/upload-queue.service", () => ({ enqueueDriveUpload: vi.fn() }));
vi.mock("../services/advisory-reconciler", () => ({ reconcileAdvisories: vi.fn() }));
vi.mock("../services/lot-reference-validator", () => ({ checkLotReferencesAgainstCatalog: async () => [] }));
vi.mock("../services/planning-totals-recovery.service", () => ({
  recoverPlanningTotalsBoxLines: async (input: any) => input,
}));
vi.mock("../services/devis-upload.service", () => ({ coerceBbox: () => null }));
vi.mock("../services/devis-line-context", () => ({ deleteContextAssetObjects: vi.fn() }));
vi.mock("../storage", () => ({
  storage: {
    getCertificat: async () => ({ id: 7, projectId: 1, contractorId: 1, certificateRef: "TEST" }),
    getProject: async () => ({ id: 1, name: "Isolated project" }),
    getContractor: async () => ({ id: 1, name: "Isolated contractor", iban: "FR7630006000011234567890189" }),
    getDevisByProjectAndContractor: async () => {
      const { devis } = await import("../../shared/schema");
      return state.db.select().from(devis);
    },
    getCertificatSources: async () => [],
    getInvoicesByDevis: async () => [],
    findBankingMismatchOverride: async () => null,
    getDevis: async (id: number) => {
      const { devis } = await import("../../shared/schema");
      const { eq } = await import("drizzle-orm");
      return (await state.db.select().from(devis).where(eq(devis.id, id)))[0];
    },
    getDevisLineItems: async (id: number) => {
      const { devisLineItems } = await import("../../shared/schema");
      const { eq } = await import("drizzle-orm");
      return state.db.select().from(devisLineItems).where(eq(devisLineItems.devisId, id)).orderBy(devisLineItems.lineNumber);
    },
    getDevisTranslation: async (id: number) => {
      const { devisTranslations } = await import("../../shared/schema");
      const { eq } = await import("drizzle-orm");
      return (await state.db.select().from(devisTranslations).where(eq(devisTranslations.devisId, id)))[0];
    },
    getDevisLineContextAssetsByDevis: async () => [],
  },
}));

const enabled = !!process.env.RECOVERY_SOURCE_PDF && !!process.env.DATABASE_URL;
(enabled ? describe : describe.skip)("private native source prepare/review/apply with real isolated transactions", () => {
  const schema = `recovery_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  beforeAll(async () => {
    state.bytes = readFileSync(process.env.RECOVERY_SOURCE_PDF!);
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    state.pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
    state.db = drizzle(state.pool);
    for (const table of ["users", "quotation_architect_audit", "projects", "devis", "devis_line_items", "devis_translations",
      "quotation_source_baselines", "quotation_architect_state", "quotation_extraction_events",
      "duplicate_extraction_audit", "extraction_row_corrections", "acompte_no_invoice_payments",
      "certificats", "certificat_sources", "invoices", "situations", "situation_lines",
      "devis_line_contexts", "devis_line_context_assets", "devis_checks", "client_checks"]) {
      await state.pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING DEFAULTS INCLUDING INDEXES)`);
      const columns = await state.pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 AND column_default LIKE 'nextval(%'`, [schema, table]);
      for (const { column_name: column } of columns.rows) {
        await state.pool.query(`CREATE SEQUENCE "${table}_${column}_private";
          ALTER TABLE "${table}" ALTER COLUMN "${column}" SET DEFAULT nextval('"${table}_${column}_private"')`);
      }
    }
    await state.pool.query(`INSERT INTO projects(id,name,code,client_name) VALUES(1,'Test','TEST','Test');
      INSERT INTO devis(id,project_id,contractor_id,devis_code,description_fr,amount_ht,amount_ttc,status,pdf_storage_key)
        VALUES(56,1,1,'TEST','Source',0,0,'draft','source.pdf');
      INSERT INTO invoices(id,project_id,contractor_id,devis_id,invoice_number,amount_ht,tva_amount,amount_ttc)
        VALUES(6,1,1,34,'OTHER',100,10,110);
      INSERT INTO certificats(id,project_id,contractor_id,certificate_ref,status,total_works_ht,net_to_pay_ht,tva_amount,net_to_pay_ttc,issuance_snapshot)
        VALUES(5,1,1,'C1','paid',100,100,10,110,'{"sourceInvoiceIds":[6],"tvaEvidenceDevisId":34}');
      INSERT INTO certificat_sources(certificat_id,invoice_id) VALUES(5,6);`);
  });
  afterAll(async () => {
    await state.pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  beforeEach(async () => {
    await state.pool.query(`DELETE FROM devis_line_items; DELETE FROM quotation_extraction_events;
      DELETE FROM quotation_architect_audit; DELETE FROM quotation_architect_state; DELETE FROM devis_translations;
      DELETE FROM devis_line_contexts; DELETE FROM quotation_source_baselines;
      UPDATE devis SET amount_ht=0,amount_ttc=0,ai_extracted_data=NULL,
        extracted_iban='DE89370400440532013000',extracted_bic='COBADEFFXXX' WHERE id=56;
      UPDATE invoices SET devis_id=34 WHERE id=6;
      DELETE FROM certificat_sources;
      INSERT INTO certificat_sources(certificat_id,invoice_id) VALUES(5,6);`);
  });
  it("prepares without mutation and applies explicitly despite an unrelated certificate", async () => {
    const { rescrapeDevis } = await import("../services/devis-rescrape.service");
    const prepared = await rescrapeDevis(56);
    expect(prepared.data.prepared).toBe(true);
    expect((await state.pool.query("SELECT count(*)::int n FROM devis_line_items")).rows[0].n).toBe(0);
    const attempt = (await state.pool.query("SELECT id FROM quotation_extraction_events WHERE outcome='prepared'")).rows[0].id;
    const result = await rescrapeDevis(56, { attemptId: attempt, actorId: 1, reason: "Isolated source review" });
    expect(result.success).toBe(true);
    const extraction = prepared.data.extraction as any;
    expect(extraction.lineItems).toHaveLength(167);
    expect(extraction.amountHt).toBe(412465.90);
    expect(extraction.amountTtc).toBe(453712.49);
    expect(extraction.nativeTableRecovery.parser).toBe("numbered-table-v3");
    expect(extraction.extractionCoverage.chunkCount).toBe(0);
    expect(extraction.extractionCoverage.renderedPageCount).toBe(0);
    expect((await state.pool.query("SELECT count(*)::int n FROM devis_line_items")).rows[0].n).toBe(extraction.lineItems.length);
    const quote = (await state.pool.query("SELECT * FROM devis WHERE id=56")).rows[0];
    expect(Number(quote.amount_ht)).toBe(extraction.amountHt);
    expect(Number(quote.amount_ttc)).toBe(extraction.amountTtc);
    expect(quote.pdf_storage_key).toBe("source.pdf");
    expect(quote.status).toBe("draft");
    expect(quote.extracted_iban).toBe("DE89370400440532013000");
    expect(quote.extracted_bic).toBe("COBADEFFXXX");
    const { generateCertificatPdf, BankingMismatchError } = await import("../communications/certificat-generator");
    const error = await generateCertificatPdf(7).catch(e => e);
    expect(error).toBeInstanceOf(BankingMismatchError);
    expect(error.mismatches).toContainEqual(expect.objectContaining({
      docKind: "devis", docId: 56, docIban: "DE89370400440532013000",
    }));
    expect((await state.pool.query("SELECT status FROM certificats WHERE id=5")).rows[0].status).toBe("paid");
    // Continue the actual source through the working editor's service, not just
    // parser output. No live model, email, signing or production mutation.
    const { createArchitectCorrectionService } = await import("../services/architect-quotation-correction");
    const editor = createArchitectCorrectionService({ pool: state.pool, readPdf: async () => state.bytes });
    const before = await editor.get(56);
    const draft = structuredClone(before.draft);
    draft.headerEn = "Renovation works";
    draft.summaryEn = "Draft context for the client's review; original specifications remain authoritative.";
    draft.lines[0].descriptionEn = "Preliminary site works — draft translation for review.";
    const saved = await editor.save(56, { ...draft, expectedVersion: before.version }, 1);
    const reopened = await editor.get(56);
    expect(reopened.draft.summaryEn).toBe(draft.summaryEn);
    expect(reopened.draft.lines[0].descriptionEn).toBe(draft.lines[0].descriptionEn);
    expect(reopened.draft.lines.map(l => [l.id, l.descriptionFr, l.totalHt])).toEqual(
      before.draft.lines.map(l => [l.id, l.descriptionFr, l.totalHt]));
    expect(saved.version).not.toBe(before.version);
    await expect(editor.save(56, { ...draft, expectedVersion: before.version }, 1)).rejects.toThrow("changed");
    const { storage: realStorage } = await vi.importActual<typeof import("../storage")>("../storage");
    const context = { type: "doc", content: [{ type: "paragraph", content: [
      { type: "text", text: "Context saved independently of extraction." },
    ] }] };
    const lineId = reopened.draft.lines[0].id!;
    expect(await realStorage.saveDevisLineContextGuarded(56, lineId, context, 0)).toMatchObject({ outcome: "saved" });
    expect(await realStorage.getDevisLineContexts(56)).toEqual(expect.arrayContaining([
      expect.objectContaining({ devisLineItemId: lineId, document: context }),
    ]));
    expect(await realStorage.saveDevisLineContextGuarded(56, lineId, context, 0)).toEqual({ outcome: "stale_create" });
    const { loadQuotationDecisionSnapshot } = await import("../services/quotation-decision-snapshot");
    const { evaluateQuotationDecision } = await import("../services/quotation-decision");
    const decision = (await loadQuotationDecisionSnapshot(56))!;
    expect((await evaluateQuotationDecision(decision, "prepare_translation")).allowed).toBe(true);
    expect((await evaluateQuotationDecision(decision, "approve")).allowed).toBe(false);
    expect((await state.pool.query("SELECT amount_ht,amount_ttc FROM devis WHERE id=56")).rows[0]).toEqual({
      amount_ht: quote.amount_ht, amount_ttc: quote.amount_ttc,
    });
  }, 60000);
  it.each(["related invoice", "legacy scope", "stale quotation", "new baseline"])(
    "preserves the draft when blocked by %s", async (scenario) => {
      const { rescrapeDevis } = await import("../services/devis-rescrape.service");
      expect((await rescrapeDevis(56)).data.prepared).toBe(true);
      const attempt = (await state.pool.query("SELECT id FROM quotation_extraction_events WHERE outcome='prepared'")).rows[0].id;
      if (scenario === "related invoice") await state.pool.query("UPDATE invoices SET devis_id=56 WHERE id=6");
      if (scenario === "legacy scope") await state.pool.query("DELETE FROM certificat_sources");
      if (scenario === "stale quotation") await state.pool.query("UPDATE devis SET amount_ht=1 WHERE id=56");
      if (scenario === "new baseline") {
        // Minimal fixture marker: this clone has no audit triggers, but retains
        // all required source-baseline columns from the real schema.
        await state.pool.query(`INSERT INTO quotation_source_baselines
          (devis_id,source_storage_key,source_file_name,source_digest,ttc,pdf_page,actor_id)
          VALUES(56,'source.pdf','source.pdf','fixture',1,1,1)`);
      }
      const result = await rescrapeDevis(56, { attemptId: attempt, actorId: 1, reason: "Source checked" });
      expect(result.status).toBe(409);
      expect((await state.pool.query("SELECT count(*)::int n FROM devis_line_items")).rows[0].n).toBe(0);
      expect((await state.pool.query("SELECT count(*)::int n FROM quotation_extraction_events WHERE outcome='applied'")).rows[0].n).toBe(0);
    }, 60000);
});
