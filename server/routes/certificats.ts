import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertCertificatSchema, type InsertCertificat } from "@shared/schema";
import { generateCertificatPdf, BankingDetailsMissingError, BankingMismatchError } from "../communications/certificat-generator";
import { sendCertificat } from "../communications/email-sender";
import { validateRequest } from "../middleware/validate";
import { resolveCertificatDeductions } from "../services/certificat-deductions.service";
import { getDocumentBuffer } from "../storage/object-storage";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });
const certIdParams = z.object({ certId: z.coerce.number().int().positive() });
const sendCertParams = z.object({
  projectId: z.coerce.number().int().positive(),
  certId: z.coerce.number().int().positive(),
});

// Task #243 — `retenueOverride` / `prorataOverride` let an architect force a
// cumulative deduction for edge cases. They are NOT columns: the handler pulls
// them out and feeds them to the deduction resolver, never to storage.
const deductionOverrideShape = {
  retenueOverride: z.string().optional(),
  prorataOverride: z.string().optional(),
};

// Task #243 — these are SERVER-DERIVED money fields. The server is the sole
// authority: they are recomputed by `resolveCertificatDeductions` on every
// create/update and must NEVER be accepted from the client (a malicious or
// stale PATCH could otherwise move money directly). Omitting them from the
// request schemas makes Zod strip them before they reach storage.
const serverDerivedDeductionFields = {
  retenueGarantie: true,
  cumulativeProrataDeduction: true,
  periodProrataDeduction: true,
  netToPayHt: true,
  tvaAmount: true,
  netToPayTtc: true,
} as const;

const createCertificatBodySchema = insertCertificatSchema
  .omit({ projectId: true, certificateRef: true, ...serverDerivedDeductionFields })
  .extend(deductionOverrideShape);
const updateCertificatSchema = insertCertificatSchema
  .omit(serverDerivedDeductionFields)
  .partial()
  .extend(deductionOverrideShape);

router.get("/api/projects/:projectId/certificats", async (req, res) => {
  const certs = await storage.getCertificatsByProject(Number(req.params.projectId));
  res.json(certs);
});

router.get("/api/projects/:projectId/certificats/next-ref", async (req, res) => {
  const nextRef = await storage.getNextCertificateRef(Number(req.params.projectId));
  res.json({ nextRef });
});

router.post(
  "/api/projects/:projectId/certificats",
  validateRequest({ params: projectIdParams, body: createCertificatBodySchema }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const { retenueOverride, prorataOverride, ...body } = req.body as
      Omit<InsertCertificat, "projectId" | "certificateRef"> & {
        retenueOverride?: string;
        prorataOverride?: string;
      };

    // Task #243 — the server is authoritative for deduction money math.
    // Recompute Retenue de Garantie + Compte Prorata cumulatively from the
    // contract, overriding whatever the FE sent for the derived fields.
    const deductions = await resolveCertificatDeductions({
      projectId,
      contractorId: body.contractorId,
      totalWorksHt: body.totalWorksHt,
      pvMvAdjustment: body.pvMvAdjustment,
      previousPayments: body.previousPayments,
      retenueOverride,
      prorataOverride,
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nextRef = await storage.getNextCertificateRef(projectId);
        const cert = await storage.createCertificat({ ...body, ...deductions, projectId, certificateRef: nextRef });
        return res.status(201).json(cert);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "23505" && attempt < 2) continue;
        throw err;
      }
    }
  },
);

router.get("/api/certificats/:id", async (req, res) => {
  const cert = await storage.getCertificat(Number(req.params.id));
  if (!cert) return res.status(404).json({ message: "Certificat not found" });
  res.json(cert);
});

router.patch(
  "/api/certificats/:id",
  validateRequest({ params: idParams, body: updateCertificatSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const { retenueOverride, prorataOverride, ...body } = req.body as
      Partial<InsertCertificat> & { retenueOverride?: string; prorataOverride?: string };

    const existing = await storage.getCertificat(id);
    if (!existing) return res.status(404).json({ message: "Certificat not found" });

    // Task #451 — issuance seal. Once a certificat carries a pinned PDF it is
    // an issued payment instruction: financial/source fields are locked and
    // corrections require a reissue (a new certificat). Only lifecycle fields
    // (status, notes) remain patchable. Belt-and-braces: `delete` the seal
    // columns from the body even though the Zod schema already omits them.
    delete (body as Record<string, unknown>).pdfStorageKey;
    delete (body as Record<string, unknown>).pdfFileName;
    delete (body as Record<string, unknown>).issuedAt;
    delete (body as Record<string, unknown>).issuanceSnapshot;
    if (existing.pdfStorageKey) {
      const allowedOnSealed = new Set(["status", "notes"]);
      const blocked = Object.keys(body).filter((k) => !allowedOnSealed.has(k));
      if (blocked.length > 0 || retenueOverride !== undefined || prorataOverride !== undefined) {
        return res.status(409).json({
          code: "CERTIFICAT_SEALED",
          message: `Certificat ${existing.certificateRef} has been issued and is sealed. Corrections require issuing a new certificat.`,
          blockedFields: blocked,
        });
      }
    }

    // Task #243 — recompute deductions whenever a financial input changes or an
    // explicit override is supplied. Status-only patches skip the recompute.
    const touchesFinancials =
      "totalWorksHt" in body ||
      "pvMvAdjustment" in body ||
      "previousPayments" in body ||
      "contractorId" in body ||
      retenueOverride !== undefined ||
      prorataOverride !== undefined;

    let patch: Partial<InsertCertificat> = body;
    if (touchesFinancials) {
      const deductions = await resolveCertificatDeductions({
        projectId: existing.projectId,
        contractorId: body.contractorId ?? existing.contractorId,
        totalWorksHt: body.totalWorksHt ?? existing.totalWorksHt,
        pvMvAdjustment: body.pvMvAdjustment ?? existing.pvMvAdjustment,
        previousPayments: body.previousPayments ?? existing.previousPayments,
        retenueOverride,
        prorataOverride,
        excludeCertificatId: id,
      });
      patch = { ...body, ...deductions };
    }

    // Task #451 — status/notes-only patches remain allowed on sealed rows;
    // anything touching financial/source inputs goes through the GUARDED
    // update (WHERE pdf_storage_key IS NULL) so a PATCH authorized against
    // an unsealed row can never commit after a concurrent seal.
    const onlyLifecycleFields = Object.keys(patch).every((k) => k === "status" || k === "notes");
    if (onlyLifecycleFields && retenueOverride === undefined && prorataOverride === undefined) {
      const cert = await storage.updateCertificat(id, patch);
      if (!cert) return res.status(404).json({ message: "Certificat not found" });
      return res.json(cert);
    }
    const cert = await storage.updateCertificatUnsealed(id, patch);
    if (!cert) {
      const current = await storage.getCertificat(id);
      if (!current) return res.status(404).json({ message: "Certificat not found" });
      // Row exists but the guard missed: sealed between our read and the write.
      return res.status(409).json({
        code: "CERTIFICAT_SEALED",
        message: `Certificat ${current.certificateRef} has been issued and is sealed. Corrections require issuing a new certificat.`,
        blockedFields: Object.keys(body).filter((k) => k !== "status" && k !== "notes"),
      });
    }
    res.json(cert);
  },
);

router.post(
  "/api/certificats/:certId/preview",
  validateRequest({ params: certIdParams }),
  async (req, res) => {
    try {
      const certId = Number(req.params.certId);
      const cert = await storage.getCertificat(certId);
      if (!cert) return res.status(404).json({ message: "Certificat not found" });
      // Task #451 — sealed certificats always preview the pinned issued
      // bytes; drafts render ephemerally (nothing persisted).
      if (cert.pdfStorageKey) {
        const pinned = await getDocumentBuffer(cert.pdfStorageKey);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${cert.pdfFileName || `Certificat_${cert.certificateRef}.pdf`}"`);
        return res.send(pinned);
      }
      const { pdfBuffer } = await generateCertificatPdf(certId, { mode: "preview" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="Certificat_${cert.certificateRef}.pdf"`);
      res.send(pdfBuffer);
    } catch (err: unknown) {
      // Task #225 — surface the banking-gate blocker as 422 with the
      // French user message; the certificat preview UI shows it verbatim.
      if (err instanceof BankingDetailsMissingError) {
        return res.status(422).json({
          code: err.code,
          message: err.userMessageFr,
          contractorId: err.contractorId,
          contractorName: err.contractorName,
        });
      }
      if (err instanceof BankingMismatchError) {
        return res.status(422).json({
          code: err.code,
          message: err.userMessageFr,
          contractorId: err.contractorId,
          contractorName: err.contractorName,
          archidocIban: err.archidocIban,
          mismatches: err.mismatches,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Preview generation failed: ${message}` });
    }
  },
);

// Task #451 — download the pinned (sealed) certificat PDF. 404s on drafts:
// there is deliberately no durable PDF before issuance.
router.get(
  "/api/certificats/:id/pdf",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const cert = await storage.getCertificat(Number(req.params.id));
      if (!cert) return res.status(404).json({ message: "Certificat not found" });
      if (!cert.pdfStorageKey) {
        return res.status(404).json({ code: "CERTIFICAT_NOT_SEALED", message: "Certificat has not been issued yet — no pinned PDF exists" });
      }
      const pinned = await getDocumentBuffer(cert.pdfStorageKey);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${cert.pdfFileName || `Certificat_${cert.certificateRef}.pdf`}"`);
      res.setHeader("Content-Length", String(pinned.length));
      res.send(pinned);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Certificat PDF fetch failed: ${message}` });
    }
  },
);

// Task #451 — sources this certificat certifies (junction rows).
router.get(
  "/api/certificats/:id/sources",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const cert = await storage.getCertificat(Number(req.params.id));
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    res.json(await storage.getCertificatSources(cert.id));
  },
);

router.post(
  "/api/projects/:projectId/certificats/:certId/send",
  validateRequest({ params: sendCertParams }),
  async (req, res) => {
    try {
      const certId = Number(req.params.certId);
      const projectId = Number(req.params.projectId);

      const cert = await storage.getCertificat(certId);
      if (!cert) return res.status(404).json({ message: "Certificat not found" });
      if (cert.projectId !== projectId) return res.status(400).json({ message: "Certificat does not belong to this project" });

      const devisList = await storage.getDevisByProject(projectId);
      const contractorDevis = devisList.filter((d) => d.contractorId === cert.contractorId && d.status !== "void");
      const missingFields: string[] = [];
      for (const d of contractorDevis) {
        if (!d.lotId) missingFields.push(`Devis "${d.devisCode}" is missing lot assignment`);
        if (!d.descriptionUk || d.descriptionUk.trim() === "") missingFields.push(`Devis "${d.devisCode}" is missing English works description`);
      }
      if (missingFields.length > 0) {
        return res.status(400).json({
          message: "Cannot send certificat: some devis are missing required fields",
          errors: missingFields,
        });
      }

      const commId = await sendCertificat(certId);
      const comm = await storage.getProjectCommunication(commId);
      res.json(comm);
    } catch (err: unknown) {
      // Task #225 — same banking-gate translation as /preview.
      if (err instanceof BankingDetailsMissingError) {
        return res.status(422).json({
          code: err.code,
          message: err.userMessageFr,
          contractorId: err.contractorId,
          contractorName: err.contractorName,
        });
      }
      if (err instanceof BankingMismatchError) {
        return res.status(422).json({
          code: err.code,
          message: err.userMessageFr,
          contractorId: err.contractorId,
          contractorName: err.contractorName,
          archidocIban: err.archidocIban,
          mismatches: err.mismatches,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Failed to queue certificat: ${message}` });
    }
  },
);

export default router;
