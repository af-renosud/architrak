import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import { eq } from "drizzle-orm";
const isolated = vi.hoisted(() => ({ name: `deleted_invoice_test_${Date.now()}` }));
vi.mock("../db", async () => {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@shared/schema");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${isolated.name},public` });
  return { pool, db: drizzle(pool, { schema }) };
});
import { db, pool } from "../db";
import { storage } from "../storage";
import { invoices, projectIntakeDocuments } from "@shared/schema";
import { releaseDeletedInvoiceSource } from "../services/intake/release-deleted-invoice";
const repair = fs.readFileSync("migrations/0143_recover_deleted_invoice_intake.sql", "utf8");
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${isolated.name}`);
  for (const name of ["projects", "invoices", "project_intake_documents", "intake_jobs", "acompte_no_invoice_payments", "intake_manual_promotions"]) {
    await pool.query(`CREATE TABLE ${isolated.name}.${name} (LIKE public.${name} INCLUDING ALL)`);
  }
  // Give the clone its own sequence; never advance a production/dev sequence.
  await pool.query(`CREATE SEQUENCE ${isolated.name}.job_id; ALTER TABLE intake_jobs ALTER COLUMN id SET DEFAULT nextval('${isolated.name}.job_id')`);
  await pool.query("INSERT INTO projects (id,name,code,client_name) VALUES (12,'MASSEY (RUSSAN) 1339','TEST','Test')");
}, 30000);
afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${isolated.name} CASCADE`); await pool.end(); });

it("releases a deleted source atomically, retains its bytes, and ignores released sources and duplicate followers", async () => {
  await pool.query(`INSERT INTO invoices (id,project_id,devis_id,contractor_id,invoice_number,amount_ht,amount_ttc,tva_amount,status) VALUES (40,12,1,1,'TEST',100,120,20,'draft')`);
  await pool.query(`INSERT INTO project_intake_documents (id,project_id,file_name,storage_key,content_fingerprint,analysis_state,routing_state,promoted_kind,promoted_id,extracted_data)
    VALUES (110,12,'test.pdf','retained.pdf','same','analyzed','routed','invoice',40,'{"contentHash":"same-text"}'),
    (111,12,'test.pdf','duplicate.pdf','same','analyzed','duplicate',NULL,NULL,'{"contentHash":"same-text"}')`);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, 40));
  await expect(db.transaction(async tx => {
    await tx.delete(invoices).where(eq(invoices.id, 40));
    await releaseDeletedInvoiceSource(tx, invoice);
    throw new Error("rollback");
  })).rejects.toThrow("rollback");
  expect((await storage.getProjectIntakeDocument(110))?.promotedId).toBe(40);
  expect(await storage.deleteInvoice(40)).toBe(true);
  expect(await storage.getProjectIntakeDocument(110)).toMatchObject({
    promotedId: null, routingState: "parked", storageKey: "retained.pdf", extractedData: { releasedInvoiceId: 40 },
  });
  expect(await storage.findProcessedIntakeDuplicateByFingerprint(12, "same", 999)).toBeUndefined();
  expect(await storage.findProcessedIntakeDuplicateByTextHash(12, "same-text", 999)).toBeUndefined();
  await db.update(projectIntakeDocuments).set({ promotedKind: "invoice", promotedId: 41, routingState: "routed" })
    .where(eq(projectIntakeDocuments.id, 110));
  expect((await storage.findProcessedIntakeDuplicateByFingerprint(12, "same", 999))?.id).toBe(110);
});

it("recovers only the known orphan, queues the replacement once, and does nothing if an invoice still exists", async () => {
  await pool.query(`INSERT INTO invoices (id,project_id,devis_id,contractor_id,invoice_number,amount_ht,amount_ttc,tva_amount,status) VALUES (4,12,1,1,'LIVE',100,120,20,'validated')`);
  await pool.query(`INSERT INTO project_intake_documents (id,project_id,file_name,storage_key,content_fingerprint,analysis_state,routing_state,promoted_kind,promoted_id,notes)
    VALUES (113,12,'Facture d''acompte Mme et M. Massey.pdf','original','massey','analyzed','routed','invoice',4,'old'),
    (114,12,'Facture d''acompte Mme et M. Massey.pdf','replacement','massey','analyzed','duplicate',NULL,NULL,'Duplicate of intake document #113.')`);
  expect(await storage.deleteInvoice(4)).toBe(false);
  await pool.query(repair);
  expect((await storage.getProjectIntakeDocument(114))?.routingState).toBe("duplicate");
  await pool.query("DELETE FROM invoices WHERE id=4");
  await pool.query(repair);
  expect(await storage.getProjectIntakeDocument(113)).toMatchObject({ promotedId: null, routingState: "parked" });
  expect(await storage.getProjectIntakeDocument(114)).toMatchObject({ analysisState: "pending", routingState: "unrouted" });
  await pool.query("UPDATE intake_jobs SET state='done',attempts=1 WHERE intake_document_id=114");
  await pool.query(repair);
  expect((await pool.query("SELECT state,attempts FROM intake_jobs WHERE intake_document_id=114")).rows).toEqual([{ state: "done", attempts: 1 }]);
});
