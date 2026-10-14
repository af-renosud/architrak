import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { certificatPayments, certificatPaymentAudits, certificats, projects } from "@shared/schema";
import { uploadDocument, deleteDocument, getDocumentBuffer } from "../storage/object-storage";
import { PaymentInputError, type PaymentEvidence } from "./payment-allocation";

export async function uploadPaymentEvidence(projectId:number,file:Express.Multer.File):Promise<PaymentEvidence> {
  if (file.size>10*1024*1024 || file.mimetype!=="application/pdf" ||
      file.buffer.subarray(0,5).toString()!=="%PDF-")
    throw new PaymentInputError("Upload a PDF of no more than 10 MB.",400);
  const evidenceFileName=file.originalname.replace(/[/\\\x00-\x1f\x7f]/g,"_").slice(0,200);
  const evidenceStorageKey=await uploadDocument(projectId,`payment-${randomUUID()}.pdf`,file.buffer,"application/pdf");
  return {evidenceStorageKey,evidenceFileName,evidenceHash:createHash("sha256").update(file.buffer).digest("hex")};
}

// A commit acknowledgement can be lost. Never delete bytes unless a fresh DB
// read proves neither a live payment nor its retained audit references them.
export async function cleanUnusedPaymentEvidence(key:string) {
  try {
    if ((await db.select({id:certificatPayments.id}).from(certificatPayments)
      .where(eq(certificatPayments.evidenceStorageKey,key)).limit(1)).length) return;
    if ((await db.select({id:certificatPaymentAudits.id}).from(certificatPaymentAudits)
      .where(sql`${certificatPaymentAudits.snapshot}->>'evidenceStorageKey' = ${key}`).limit(1)).length) return;
    await deleteDocument(key);
  } catch { console.warn("[Payment evidence] Uncertain cleanup deferred; file retained."); }
}

export async function attachPaymentEvidence(paymentId:number,evidence:PaymentEvidence,actor:string) {
  return db.transaction(async tx=>{
    const [identity]=await tx.select({certificatId:certificatPayments.certificatId,projectId:certificats.projectId})
      .from(certificatPayments).innerJoin(certificats,eq(certificats.id,certificatPayments.certificatId))
      .where(eq(certificatPayments.id,paymentId));
    if (!identity) throw new PaymentInputError("Payment not found.",404);
    const [project]=await tx.select().from(projects).where(eq(projects.id,identity.projectId)).for("share");
    const [cert]=await tx.select().from(certificats).where(eq(certificats.id,identity.certificatId)).for("update");
    if (!project || project.archivedAt || project.status==="archived" || !cert ||
        cert.status==="superseded" || cert.status==="draft")
      throw new PaymentInputError("Evidence cannot be added to an archived, draft or superseded certificate.");
    const [payment]=await tx.select().from(certificatPayments).where(eq(certificatPayments.id,paymentId)).for("update");
    if (!payment) throw new PaymentInputError("Payment not found.",404);
    if (payment.evidenceStorageKey) {
      if (payment.evidenceHash===evidence.evidenceHash) return payment;
      throw new PaymentInputError("This payment already has evidence. The original must be retained.");
    }
    const [updated]=await tx.update(certificatPayments).set({...evidence,updatedAt:new Date()})
      .where(eq(certificatPayments.id,paymentId)).returning();
    await tx.insert(certificatPaymentAudits).values({certificatId:cert.id,paymentId,
      action:"updated",snapshot:payment,changedBy:actor});
    return updated;
  });
}

export async function readPaymentEvidence(paymentId:number) {
  const [payment]=await db.select().from(certificatPayments).where(eq(certificatPayments.id,paymentId));
  let proof: {evidenceStorageKey?:string|null;evidenceFileName?:string|null}|undefined=payment;
  if (!payment) {
    const audits=await db.select().from(certificatPaymentAudits).where(eq(certificatPaymentAudits.paymentId,paymentId))
      .orderBy(desc(certificatPaymentAudits.id));
    proof=audits.map(x=>x.snapshot as typeof proof).find(x=>x?.evidenceStorageKey);
  }
  if (!proof?.evidenceStorageKey) throw new PaymentInputError("No payment evidence is attached.",404);
  return {buffer:await getDocumentBuffer(proof.evidenceStorageKey),fileName:proof.evidenceFileName??"payment-evidence.pdf"};
}
