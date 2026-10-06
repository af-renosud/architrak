import { it, expect, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../db";
vi.mock("../../storage/object-storage", () => ({
  uploadDocument: vi.fn().mockImplementation(async (_p, name) => `/test/${name}`),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
}));
import { architectInvoiceStatus, replaceArchitectInvoice, requireArchitectInvoiceConfirmation, reserveArchitectInvoiceDelivery, assertArchitectInvoiceAttached } from "../certificat-architect-invoice.service";

it("keeps original PDF metadata, supports remove/replace, requires confirmation, freezes delivery and reports sent evidence", async () => {
  const rollback = new Error("rollback test");
  const originalTransaction = db.transaction.bind(db);
  await expect(originalTransaction(async tx => {
    await tx.execute(sql.raw(`
      CREATE TEMP TABLE projects(id int PRIMARY KEY,archived_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE certificats(id int PRIMARY KEY,project_id int,status text) ON COMMIT DROP;
      CREATE TEMP TABLE project_communications(id int,type text,related_certificat_id int,status text) ON COMMIT DROP;
      CREATE TEMP TABLE certificat_architect_invoices (LIKE public.certificat_architect_invoices INCLUDING ALL) ON COMMIT DROP;
      CREATE TRIGGER test_invoice_frozen BEFORE UPDATE OR DELETE ON certificat_architect_invoices
        FOR EACH ROW EXECUTE FUNCTION guard_certificat_architect_invoice();
      INSERT INTO projects VALUES (1,NULL);
      INSERT INTO certificats VALUES (1,1,'ready'),(2,1,'draft'),(3,1,'ready');
    `));
    vi.spyOn(db, "execute").mockImplementation((query: any) => tx.execute(query) as any);
    vi.spyOn(db, "transaction").mockImplementation((fn: any) => fn(tx));
    try {
      expect(await architectInvoiceStatus(1)).toMatchObject({attached:false,locked:false,sentWithInvoice:null});
      await expect(requireArchitectInvoiceConfirmation(1,false)).rejects.toMatchObject({code:"ARCHITECT_INVOICE_CONFIRMATION_REQUIRED"});
      const file = { originalname:"Invoice.pdf",buffer:Buffer.from("%PDF test") };
      await replaceArchitectInvoice(1,file,7);
      expect(await architectInvoiceStatus(1)).toMatchObject({attached:true,fileName:"Invoice.pdf",locked:false});
      await replaceArchitectInvoice(1,null,7);
      expect(await architectInvoiceStatus(1)).toMatchObject({attached:false});
      await replaceArchitectInvoice(1,file,7);
      await requireArchitectInvoiceConfirmation(1,false);
      const frozen = await reserveArchitectInvoiceDelivery(1,false,7);
      expect(frozen?.storage_key).toContain("Invoice.pdf");
      expect(frozen?.frozen_at).toBeTruthy();
      expect(await reserveArchitectInvoiceDelivery(1,false,8)).toEqual(frozen);
      await expect(replaceArchitectInvoice(1,null,7)).rejects.toMatchObject({code:"DELIVERY_LOCKED"});
      expect(() => assertArchitectInvoiceAttached(frozen,[])).toThrow(/missing/);
      expect(() => assertArchitectInvoiceAttached(frozen,[frozen!.storage_key!])).not.toThrow();
      await tx.execute(sql`INSERT INTO project_communications VALUES (1,'certificat_sent',1,'sent')`);
      expect(await architectInvoiceStatus(1)).toMatchObject({attached:true,locked:true,sentWithInvoice:true});
      await reserveArchitectInvoiceDelivery(2,true,7);
      await tx.execute(sql`INSERT INTO project_communications VALUES (2,'certificat_sent',2,'sent')`);
      expect(await architectInvoiceStatus(2)).toMatchObject({attached:false,locked:true,sentWithInvoice:false});
      await tx.execute(sql`INSERT INTO project_communications VALUES (3,'certificat_sent',3,'sent')`);
      expect(await architectInvoiceStatus(3)).toMatchObject({historicalDeliveryUnknown:true,sentWithInvoice:null,locked:true});
      // A savepoint proves the DB protection as well as the application guard.
      await expect(tx.transaction(async savepoint => {
        await savepoint.execute(sql`UPDATE certificat_architect_invoices SET file_name='tampered.pdf' WHERE certificat_id=1`);
      })).rejects.toThrow();
      await tx.execute(sql`UPDATE projects SET archived_at=NOW() WHERE id=1`);
      await expect(replaceArchitectInvoice(3,file,7)).rejects.toMatchObject({code:"CERTIFICATE_READ_ONLY"});
    } finally { vi.restoreAllMocks(); }
    throw rollback;
  })).rejects.toBe(rollback);
});
