import { it,expect,vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { projects,contractors,devis,invoices,certificats,certificatSources,certificatPayments,
  insertCertificatPaymentSchema } from "@shared/schema";
import { attachPaymentEvidence,readPaymentEvidence,uploadPaymentEvidence } from "../services/payment-evidence";
vi.mock("../storage/object-storage",()=>({
  getDocumentBuffer:vi.fn(async()=>Buffer.from("%PDF-test")),
  uploadDocument:vi.fn(async()=>"/private/payment-test.pdf"),
  deleteDocument:vi.fn(),
}));

it("rejects non-PDF uploads and excludes client-supplied storage keys",async()=>{
  await expect(uploadPaymentEvidence(1,{size:3,mimetype:"application/pdf",buffer:Buffer.from("bad")} as any)).rejects.toThrow("PDF");
  const parsed=insertCertificatPaymentSchema.parse({datePaid:"2026-10-14",amount:"30.00",
    method:"virement",evidenceStorageKey:"/another/user/file"});
  expect(parsed).not.toHaveProperty("evidenceStorageKey");
});

it("shares one audited ledger, validates allocations, retries once, and retains PDF evidence",async()=>{
  const rollback=new Error("rollback fixtures"),original=db.transaction.bind(db);
  await expect(original(async tx=>{
    const [project]=await tx.insert(projects).values({code:randomUUID(),name:"Payment proof fixture",
      clientName:"Test",status:"active"}).returning();
    const [contractor]=await tx.insert(contractors).values({name:"Payment proof fixture"}).returning();
    const [quote]=await tx.insert(devis).values({projectId:project.id,contractorId:contractor.id,
      devisCode:"PAY.TEST",descriptionFr:"Payment evidence fixture",amountHt:"100.00",amountTtc:"100.00"}).returning();
    const rows=await tx.insert(invoices).values(["A","B"].map(invoiceNumber=>({
      projectId:project.id,contractorId:contractor.id,devisId:quote.id,invoiceNumber,
      amountHt:"50.00",amountTtc:"50.00",tvaAmount:"0.00",status:"approved",
    }))).returning();
    const [cert]=await tx.insert(certificats).values({projectId:project.id,contractorId:contractor.id,
      certificateRef:"TEST",status:"sent",totalWorksHt:"100.00",netToPayHt:"100.00",netToPayTtc:"100.00",tvaAmount:"0.00"}).returning();
    await tx.insert(certificatSources).values(rows.map(i=>({certificatId:cert.id,invoiceId:i.id})));
    vi.spyOn(db,"transaction").mockImplementation(cb=>tx.transaction(cb) as any);
    vi.spyOn(db,"select").mockImplementation((...args:any[])=>(tx.select as any)(...args));
    const proof={evidenceStorageKey:"/private/test.pdf",evidenceFileName:"transfer.pdf",evidenceHash:"test-hash"};
    const entry={datePaid:"2026-10-14",amount:"30.00",method:"virement" as const,requestId:randomUUID(),
      invoiceAllocations:[{invoiceId:rows[0].id,amount:"20.00"},{invoiceId:rows[1].id,amount:"10.00"}]};
    try {
      await expect(storage.createCertificatPaymentAtomic(cert.id,{...entry,invoiceAllocations:[]})).rejects.toThrow("Allocate");
      const first=await storage.createCertificatPaymentAtomic(cert.id,entry,proof);
      expect(first.outcome).toBe("ok");
      const repeated=await storage.createCertificatPaymentAtomic(cert.id,entry,proof);
      expect(repeated.payment?.id).toBe(first.payment?.id);
      expect(await tx.select().from(certificatPayments).where(eq(certificatPayments.certificatId,cert.id))).toHaveLength(1);
      await expect(storage.createCertificatPaymentAtomic(cert.id,{...entry,amount:"31.00"})).rejects.toThrow();
      await storage.deleteCertificatPaymentAtomic(first.payment!.id,"operator");
      expect((await readPaymentEvidence(first.payment!.id)).buffer.toString()).toBe("%PDF-test");
      await expect(storage.createCertificatPaymentAtomic(cert.id,entry,proof)).rejects.toThrow("removed");
      const full={...entry,requestId:randomUUID(),amount:"100.00",
        invoiceAllocations:rows.map(i=>({invoiceId:i.id,amount:"50.00"}))};
      const final=await storage.createCertificatPaymentAtomic(cert.id,full);
      expect(final.outcome).toBe("ok");
      expect((await tx.select().from(certificats).where(eq(certificats.id,cert.id)))[0].status).toBe("paid");
      const attached=await attachPaymentEvidence(final.payment!.id,proof,"operator");
      expect(attached.amount).toBe("100.00");
      expect((await storage.createCertificatPaymentAtomic(cert.id,full)).payment?.id).toBe(final.payment?.id);
      await expect(attachPaymentEvidence(final.payment!.id,{...proof,evidenceHash:"different"},"operator")).rejects.toThrow("already");
      await tx.update(projects).set({archivedAt:new Date()}).where(eq(projects.id,project.id));
      await expect(attachPaymentEvidence(final.payment!.id,proof,"operator")).rejects.toThrow("archived");
    } finally {vi.restoreAllMocks();}
    throw rollback;
  })).rejects.toBe(rollback);
},30000);
