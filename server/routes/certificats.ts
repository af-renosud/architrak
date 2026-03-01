import { Router } from "express";
import { storage } from "../storage";
import { insertCertificatSchema } from "@shared/schema";
import { generateCertificatPdf } from "../communications/certificat-generator";
import { sendCertificat } from "../communications/email-sender";

const router = Router();

router.get("/api/projects/:projectId/certificats", async (req, res) => {
  const certs = await storage.getCertificatsByProject(Number(req.params.projectId));
  res.json(certs);
});

router.get("/api/projects/:projectId/certificats/next-ref", async (req, res) => {
  const nextRef = await storage.getNextCertificateRef(Number(req.params.projectId));
  res.json({ nextRef });
});

router.post("/api/projects/:projectId/certificats", async (req, res) => {
  const projectId = Number(req.params.projectId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const nextRef = await storage.getNextCertificateRef(projectId);
      const parsed = insertCertificatSchema.safeParse({ ...req.body, projectId, certificateRef: nextRef });
      if (!parsed.success) return res.status(400).json({ message: "Invalid certificat data", errors: parsed.error.flatten() });
      const cert = await storage.createCertificat(parsed.data);
      return res.status(201).json(cert);
    } catch (err: any) {
      if (err?.code === "23505" && attempt < 2) continue;
      throw err;
    }
  }
});

router.get("/api/certificats/:id", async (req, res) => {
  const cert = await storage.getCertificat(Number(req.params.id));
  if (!cert) return res.status(404).json({ message: "Certificat not found" });
  res.json(cert);
});

router.patch("/api/certificats/:id", async (req, res) => {
  const parsed = insertCertificatSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid certificat data", errors: parsed.error.flatten() });
  const cert = await storage.updateCertificat(Number(req.params.id), parsed.data);
  if (!cert) return res.status(404).json({ message: "Certificat not found" });
  res.json(cert);
});

router.post("/api/certificats/:certId/preview", async (req, res) => {
  try {
    const certId = Number(req.params.certId);
    const cert = await storage.getCertificat(certId);
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    const { pdfBuffer } = await generateCertificatPdf(certId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Certificat_${cert.certificateRef}.pdf"`);
    res.send(pdfBuffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Preview generation failed: ${message}` });
  }
});

router.post("/api/projects/:projectId/certificats/:certId/send", async (req, res) => {
  try {
    const certId = Number(req.params.certId);
    const projectId = Number(req.params.projectId);

    const cert = await storage.getCertificat(certId);
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    if (cert.projectId !== projectId) return res.status(400).json({ message: "Certificat does not belong to this project" });

    const devisList = await storage.getDevisByProject(projectId);
    const contractorDevis = devisList.filter(d => d.contractorId === cert.contractorId && d.status !== "void");
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
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Failed to queue certificat: ${message}` });
  }
});

export default router;
