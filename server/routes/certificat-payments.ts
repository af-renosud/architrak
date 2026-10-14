import { Router } from "express";
import multer from "multer";
import { db } from "../db";
import { projects } from "@shared/schema";
import { eq } from "drizzle-orm";
import { PaymentInputError, paymentInvoiceOptions, type PaymentEvidence } from "../services/payment-allocation";
import { uploadPaymentEvidence, cleanUnusedPaymentEvidence, attachPaymentEvidence, readPaymentEvidence } from "../services/payment-evidence";
import { z } from "zod";
import { storage } from "../storage";
import { insertCertificatPaymentSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import {
  logPayment,
  correctPayment,
  removePayment,
  reconcilePayments,
  PaymentsLockedError,
  CertificatSupersededPaymentError,
  CertificatDraftPaymentError,
  PaymentNotFoundError,
} from "../services/certificat-payments.service";

/**
 * Task #465 — structured client-payment logging routes.
 *
 * Payments are recorded facts: partial payments accumulate; the certificat
 * flips to `paid` automatically when coverage reaches the TTC total (inside
 * the atomic storage transaction, roundCurrency compare). Over-payment is
 * accepted but flagged in the response so the UI can warn. The ledger locks
 * once fully paid; drafts and superseded certificats are refused.
 */
const router = Router();
const pdfUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1}});
const receivePdf=(req:any,res:any,next:any)=>pdfUpload.single("file")(req,res,(error:any)=>
  error ? res.status(400).json({message:"Upload one PDF of no more than 10 MB."}) : next());
const actor=(req:any)=>String(req.session?.userId ?? req.user?.id ?? "operator");
async function preflightEvidenceUpload(cert:{projectId:number;status:string}) {
  const [project]=await db.select().from(projects).where(eq(projects.id,cert.projectId));
  if (!project || project.archivedAt || project.status==="archived" ||
      cert.status==="draft" || cert.status==="superseded")
    throw new PaymentInputError("Evidence cannot be added to an archived, draft or superseded certificate.");
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });

function mapPaymentError(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof PaymentInputError) return {status:err.status,body:{message:err.message}};
  if (err instanceof PaymentsLockedError) {
    return { status: 409, body: { code: "PAYMENTS_LOCKED", message: err.message } };
  }
  if (err instanceof CertificatSupersededPaymentError) {
    return { status: 409, body: { code: "CERTIFICAT_SUPERSEDED", message: err.message } };
  }
  if (err instanceof CertificatDraftPaymentError) {
    return { status: 409, body: { code: "CERTIFICAT_DRAFT", message: err.message } };
  }
  if (err instanceof PaymentNotFoundError) {
    return { status: 404, body: { message: err.message } };
  }
  return null;
}

router.get("/api/certificats/:id/payment-context",validateRequest({params:idParams}),async(req,res)=>{
  const cert=await storage.getCertificat(Number(req.params.id));
  if (!cert) return res.status(404).json({message:"Certificate not found"});
  const [project]=await db.select().from(projects).where(eq(projects.id,cert.projectId));
  res.json({cert,invoices:await paymentInvoiceOptions(db,cert.id),archived:!!project?.archivedAt || project?.status==="archived"});
});

router.get("/api/certificat-payments/:id/evidence",validateRequest({params:idParams}),async(req,res)=>{
  try {
    const proof=await readPaymentEvidence(Number(req.params.id));
    res.setHeader("Content-Type","application/pdf");
    res.setHeader("Cache-Control","private, no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(proof.fileName)}`);
    res.send(proof.buffer);
  } catch(error) {const mapped=mapPaymentError(error);if(mapped)return res.status(mapped.status).json(mapped.body);throw error;}
});

router.post("/api/certificat-payments/:id/evidence",validateRequest({params:idParams}),receivePdf,async(req,res)=>{
  let evidence:PaymentEvidence|undefined;
  let committed=false;
  try {
    const payment=await storage.getCertificatPayment(Number(req.params.id));
    const cert=payment && await storage.getCertificat(payment.certificatId);
    if(!cert) throw new PaymentInputError("Payment not found.",404);
    if(!req.file) throw new PaymentInputError("Choose a PDF.",400);
    await preflightEvidenceUpload(cert);
    evidence=await uploadPaymentEvidence(cert.projectId,req.file);
    const saved=await attachPaymentEvidence(Number(req.params.id),evidence,actor(req));
    committed=true;
    res.json(saved);
  } catch(error) {const mapped=mapPaymentError(error);if(mapped)return res.status(mapped.status).json(mapped.body);throw error;}
  finally {if(evidence && committed)await cleanUnusedPaymentEvidence(evidence.evidenceStorageKey);}
});

// Ledger + reconciliation for one certificat.
router.get("/api/certificats/:id/payments", validateRequest({ params: idParams }), async (req, res) => {
  const cert = await storage.getCertificat(Number(req.params.id));
  if (!cert) return res.status(404).json({ message: "Certificat not found" });
  const payments = await storage.getCertificatPayments(cert.id);
  const audits = await storage.getCertificatPaymentAudits(cert.id);
  res.json({ payments, audits, ...reconcilePayments(cert, payments) });
});

// All payments of a project's certificats (list/summary badges).
router.get("/api/projects/:projectId/certificat-payments", validateRequest({ params: projectIdParams }), async (req, res) => {
  res.json(await storage.getCertificatPaymentsByProject(Number(req.params.projectId)));
});

router.post(
  "/api/certificats/:id/payments",
  (req,res,next)=>req.is("multipart/form-data") ? receivePdf(req,res,next) : next(),
  (req,res,next)=>{
    if(req.is("multipart/form-data")) {
      try {req.body=JSON.parse(req.body.data);} catch {return res.status(400).json({message:"Invalid payment details."});}
    }
    next();
  },
  validateRequest({ params: idParams, body: insertCertificatPaymentSchema }),
  async (req, res) => {
    const cert = await storage.getCertificat(Number(req.params.id));
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    let evidence:PaymentEvidence|undefined;
    let committed=false;
    try {
      if(req.file && !req.body.requestId) throw new PaymentInputError("A request identity is required for payment evidence.",400);
      if(req.file) {
        await preflightEvidenceUpload(cert);
        evidence=await uploadPaymentEvidence(cert.projectId,req.file);
      }
      const { payment, state } = await logPayment(cert.id, {...req.body,loggedBy:actor(req)},evidence);
      committed=true;
      return res.status(201).json({ payment, ...state });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    } finally {if(evidence && committed)await cleanUnusedPaymentEvidence(evidence.evidenceStorageKey);}
  },
);

router.patch(
  "/api/certificat-payments/:id",
  validateRequest({ params: idParams, body: insertCertificatPaymentSchema.partial() }),
  async (req, res) => {
    try {
      const { payment, state } = await correctPayment(Number(req.params.id), {...req.body,loggedBy:actor(req)}, actor(req));
      return res.json({ payment, ...state });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }
  },
);

router.delete(
  "/api/certificat-payments/:id",
  validateRequest({ params: idParams, body: z.object({ changedBy: z.string().trim().max(200).optional() }).optional() }),
  async (req, res) => {
    try {
      const { state } = await removePayment(Number(req.params.id), actor(req));
      return res.json({ deleted: true, ...state });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }
  },
);

export default router;
