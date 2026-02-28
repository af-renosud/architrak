import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import {
  insertProjectSchema,
  insertContractorSchema,
  insertLotSchema,
  insertMarcheSchema,
  insertDevisSchema,
  insertDevisLineItemSchema,
  insertAvenantSchema,
  insertInvoiceSchema,
  insertSituationSchema,
  insertSituationLineSchema,
  insertCertificatSchema,
  insertFeeSchema,
  insertFeeEntrySchema,
} from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── Projects ──

  app.get("/api/projects", async (_req, res) => {
    const projects = await storage.getProjects();
    res.json(projects);
  });

  app.post("/api/projects", async (req, res) => {
    const parsed = insertProjectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid project data", errors: parsed.error.flatten() });
    const project = await storage.createProject(parsed.data);
    res.status(201).json(project);
  });

  app.get("/api/projects/:id", async (req, res) => {
    const project = await storage.getProject(Number(req.params.id));
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  });

  app.patch("/api/projects/:id", async (req, res) => {
    const parsed = insertProjectSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid project data", errors: parsed.error.flatten() });
    const project = await storage.updateProject(Number(req.params.id), parsed.data);
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  });

  app.delete("/api/projects/:id", async (req, res) => {
    await storage.deleteProject(Number(req.params.id));
    res.status(204).send();
  });

  // ── Contractors ──

  app.get("/api/contractors", async (_req, res) => {
    const contractors = await storage.getContractors();
    res.json(contractors);
  });

  app.post("/api/contractors", async (req, res) => {
    const parsed = insertContractorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid contractor data", errors: parsed.error.flatten() });
    const contractor = await storage.createContractor(parsed.data);
    res.status(201).json(contractor);
  });

  app.get("/api/contractors/:id", async (req, res) => {
    const contractor = await storage.getContractor(Number(req.params.id));
    if (!contractor) return res.status(404).json({ message: "Contractor not found" });
    res.json(contractor);
  });

  app.patch("/api/contractors/:id", async (req, res) => {
    const parsed = insertContractorSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid contractor data", errors: parsed.error.flatten() });
    const contractor = await storage.updateContractor(Number(req.params.id), parsed.data);
    if (!contractor) return res.status(404).json({ message: "Contractor not found" });
    res.json(contractor);
  });

  app.get("/api/contractors/:id/devis", async (req, res) => {
    const devisList = await storage.getDevisByContractor(Number(req.params.id));
    res.json(devisList);
  });

  app.get("/api/contractors/:id/invoices", async (req, res) => {
    const invs = await storage.getInvoicesByContractor(Number(req.params.id));
    res.json(invs);
  });

  // ── Marches ──

  app.get("/api/projects/:projectId/marches", async (req, res) => {
    const marches = await storage.getMarchesByProject(Number(req.params.projectId));
    res.json(marches);
  });

  app.post("/api/projects/:projectId/marches", async (req, res) => {
    const parsed = insertMarcheSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid marche data", errors: parsed.error.flatten() });
    const marche = await storage.createMarche(parsed.data);
    res.status(201).json(marche);
  });

  app.get("/api/marches/:id", async (req, res) => {
    const marche = await storage.getMarche(Number(req.params.id));
    if (!marche) return res.status(404).json({ message: "Marche not found" });
    res.json(marche);
  });

  app.patch("/api/marches/:id", async (req, res) => {
    const parsed = insertMarcheSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid marche data", errors: parsed.error.flatten() });
    const marche = await storage.updateMarche(Number(req.params.id), parsed.data);
    if (!marche) return res.status(404).json({ message: "Marche not found" });
    res.json(marche);
  });

  // ── Lots ──

  app.get("/api/projects/:projectId/lots", async (req, res) => {
    const lotsList = await storage.getLotsByProject(Number(req.params.projectId));
    res.json(lotsList);
  });

  app.post("/api/projects/:projectId/lots", async (req, res) => {
    const parsed = insertLotSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid lot data", errors: parsed.error.flatten() });
    const lot = await storage.createLot(parsed.data);
    res.status(201).json(lot);
  });

  app.patch("/api/lots/:id", async (req, res) => {
    const parsed = insertLotSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid lot data", errors: parsed.error.flatten() });
    const lot = await storage.updateLot(Number(req.params.id), parsed.data);
    if (!lot) return res.status(404).json({ message: "Lot not found" });
    res.json(lot);
  });

  app.delete("/api/lots/:id", async (req, res) => {
    await storage.deleteLot(Number(req.params.id));
    res.status(204).send();
  });

  // ── Devis ──

  app.get("/api/projects/:projectId/devis", async (req, res) => {
    const devisList = await storage.getDevisByProject(Number(req.params.projectId));
    res.json(devisList);
  });

  app.post("/api/projects/:projectId/devis", async (req, res) => {
    const parsed = insertDevisSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid devis data", errors: parsed.error.flatten() });
    const d = await storage.createDevis(parsed.data);
    res.status(201).json(d);
  });

  app.get("/api/devis/:id", async (req, res) => {
    const d = await storage.getDevis(Number(req.params.id));
    if (!d) return res.status(404).json({ message: "Devis not found" });
    res.json(d);
  });

  app.patch("/api/devis/:id", async (req, res) => {
    const parsed = insertDevisSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid devis data", errors: parsed.error.flatten() });
    const d = await storage.updateDevis(Number(req.params.id), parsed.data);
    if (!d) return res.status(404).json({ message: "Devis not found" });
    res.json(d);
  });

  // ── Devis Line Items ──

  app.get("/api/devis/:devisId/line-items", async (req, res) => {
    const items = await storage.getDevisLineItems(Number(req.params.devisId));
    res.json(items);
  });

  app.post("/api/devis/:devisId/line-items", async (req, res) => {
    const parsed = insertDevisLineItemSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid line item data", errors: parsed.error.flatten() });
    const item = await storage.createDevisLineItem(parsed.data);
    res.status(201).json(item);
  });

  app.patch("/api/line-items/:id", async (req, res) => {
    const parsed = insertDevisLineItemSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid line item data", errors: parsed.error.flatten() });
    const item = await storage.updateDevisLineItem(Number(req.params.id), parsed.data);
    if (!item) return res.status(404).json({ message: "Line item not found" });
    res.json(item);
  });

  app.delete("/api/line-items/:id", async (req, res) => {
    await storage.deleteDevisLineItem(Number(req.params.id));
    res.status(204).send();
  });

  // ── Avenants ──

  app.get("/api/devis/:devisId/avenants", async (req, res) => {
    const avs = await storage.getAvenantsByDevis(Number(req.params.devisId));
    res.json(avs);
  });

  app.post("/api/devis/:devisId/avenants", async (req, res) => {
    const parsed = insertAvenantSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid avenant data", errors: parsed.error.flatten() });
    const avenant = await storage.createAvenant(parsed.data);
    res.status(201).json(avenant);
  });

  app.patch("/api/avenants/:id", async (req, res) => {
    const parsed = insertAvenantSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid avenant data", errors: parsed.error.flatten() });
    const avenant = await storage.updateAvenant(Number(req.params.id), parsed.data);
    if (!avenant) return res.status(404).json({ message: "Avenant not found" });
    res.json(avenant);
  });

  // ── Invoices ──

  app.get("/api/devis/:devisId/invoices", async (req, res) => {
    const invs = await storage.getInvoicesByDevis(Number(req.params.devisId));
    res.json(invs);
  });

  app.post("/api/devis/:devisId/invoices", async (req, res) => {
    const parsed = insertInvoiceSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid invoice data", errors: parsed.error.flatten() });
    const invoice = await storage.createInvoice(parsed.data);
    res.status(201).json(invoice);
  });

  app.patch("/api/invoices/:id", async (req, res) => {
    const parsed = insertInvoiceSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid invoice data", errors: parsed.error.flatten() });
    const invoice = await storage.updateInvoice(Number(req.params.id), parsed.data);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    res.json(invoice);
  });

  // ── Situations ──

  app.get("/api/devis/:devisId/situations", async (req, res) => {
    const sits = await storage.getSituationsByDevis(Number(req.params.devisId));
    res.json(sits);
  });

  app.post("/api/devis/:devisId/situations", async (req, res) => {
    const parsed = insertSituationSchema.safeParse({ ...req.body, devisId: Number(req.params.devisId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid situation data", errors: parsed.error.flatten() });
    const situation = await storage.createSituation(parsed.data);
    res.status(201).json(situation);
  });

  app.get("/api/situations/:id", async (req, res) => {
    const situation = await storage.getSituation(Number(req.params.id));
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    res.json(situation);
  });

  app.patch("/api/situations/:id", async (req, res) => {
    const parsed = insertSituationSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid situation data", errors: parsed.error.flatten() });
    const situation = await storage.updateSituation(Number(req.params.id), parsed.data);
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    res.json(situation);
  });

  // ── Situation Lines ──

  app.get("/api/situations/:situationId/lines", async (req, res) => {
    const lines = await storage.getSituationLines(Number(req.params.situationId));
    res.json(lines);
  });

  app.post("/api/situations/:situationId/lines", async (req, res) => {
    const parsed = insertSituationLineSchema.safeParse({ ...req.body, situationId: Number(req.params.situationId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid situation line data", errors: parsed.error.flatten() });
    const line = await storage.createSituationLine(parsed.data);
    res.status(201).json(line);
  });

  // ── Certificats ──

  app.get("/api/projects/:projectId/certificats", async (req, res) => {
    const certs = await storage.getCertificatsByProject(Number(req.params.projectId));
    res.json(certs);
  });

  app.post("/api/projects/:projectId/certificats", async (req, res) => {
    const parsed = insertCertificatSchema.safeParse({ ...req.body, projectId: Number(req.params.projectId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid certificat data", errors: parsed.error.flatten() });
    const cert = await storage.createCertificat(parsed.data);
    res.status(201).json(cert);
  });

  app.get("/api/certificats/:id", async (req, res) => {
    const cert = await storage.getCertificat(Number(req.params.id));
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    res.json(cert);
  });

  app.patch("/api/certificats/:id", async (req, res) => {
    const parsed = insertCertificatSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid certificat data", errors: parsed.error.flatten() });
    const cert = await storage.updateCertificat(Number(req.params.id), parsed.data);
    if (!cert) return res.status(404).json({ message: "Certificat not found" });
    res.json(cert);
  });

  // ── Fees ──

  app.get("/api/projects/:projectId/fees", async (req, res) => {
    const feesList = await storage.getFeesByProject(Number(req.params.projectId));
    res.json(feesList);
  });

  app.post("/api/fees", async (req, res) => {
    const parsed = insertFeeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid fee data", errors: parsed.error.flatten() });
    const fee = await storage.createFee(parsed.data);
    res.status(201).json(fee);
  });

  app.patch("/api/fees/:id", async (req, res) => {
    const parsed = insertFeeSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid fee data", errors: parsed.error.flatten() });
    const fee = await storage.updateFee(Number(req.params.id), parsed.data);
    if (!fee) return res.status(404).json({ message: "Fee not found" });
    res.json(fee);
  });

  // ── Fee Entries ──

  app.get("/api/projects/:projectId/fee-entries", async (req, res) => {
    const entries = await storage.getFeeEntriesByProject(Number(req.params.projectId));
    res.json(entries);
  });

  app.get("/api/fees/:feeId/entries", async (req, res) => {
    const entries = await storage.getFeeEntries(Number(req.params.feeId));
    res.json(entries);
  });

  app.post("/api/fees/:feeId/entries", async (req, res) => {
    const parsed = insertFeeEntrySchema.safeParse({ ...req.body, feeId: Number(req.params.feeId) });
    if (!parsed.success) return res.status(400).json({ message: "Invalid fee entry data", errors: parsed.error.flatten() });
    const entry = await storage.createFeeEntry(parsed.data);
    res.status(201).json(entry);
  });

  app.patch("/api/fee-entries/:id", async (req, res) => {
    const parsed = insertFeeEntrySchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid fee entry data", errors: parsed.error.flatten() });
    const entry = await storage.updateFeeEntry(Number(req.params.id), parsed.data);
    if (!entry) return res.status(404).json({ message: "Fee entry not found" });
    res.json(entry);
  });

  // ── Financial Summary ──

  app.get("/api/projects/:projectId/financial-summary", async (req, res) => {
    const projectId = Number(req.params.projectId);
    const project = await storage.getProject(projectId);
    if (!project) return res.status(404).json({ message: "Project not found" });

    const devisList = await storage.getDevisByProject(projectId);
    const projectInvoices = await storage.getInvoicesByProject(projectId);

    const devisSummaries = await Promise.all(
      devisList.map(async (d) => {
        const avs = await storage.getAvenantsByDevis(d.id);
        const devisInvoices = projectInvoices.filter((inv) => inv.devisId === d.id);

        const originalHt = parseFloat(d.amountHt);
        const approvedAvenants = avs.filter((a) => a.status === "approved");
        const pvTotal = approvedAvenants
          .filter((a) => a.type === "pv")
          .reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
        const mvTotal = approvedAvenants
          .filter((a) => a.type === "mv")
          .reduce((sum, a) => sum + parseFloat(a.amountHt), 0);
        const adjustedHt = originalHt + pvTotal - mvTotal;

        const certifiedHt = devisInvoices.reduce(
          (sum, inv) => sum + parseFloat(inv.amountHt),
          0
        );

        const resteARealiser = adjustedHt - certifiedHt;

        return {
          devisId: d.id,
          devisCode: d.devisCode,
          descriptionFr: d.descriptionFr,
          descriptionUk: d.descriptionUk,
          status: d.status,
          contractorId: d.contractorId,
          invoicingMode: d.invoicingMode,
          originalHt,
          pvTotal,
          mvTotal,
          adjustedHt,
          certifiedHt,
          resteARealiser,
          invoiceCount: devisInvoices.length,
          avenantCount: avs.length,
        };
      })
    );

    const totals = devisSummaries.reduce(
      (acc, ds) => ({
        totalContractedHt: acc.totalContractedHt + ds.adjustedHt,
        totalCertifiedHt: acc.totalCertifiedHt + ds.certifiedHt,
        totalResteARealiser: acc.totalResteARealiser + ds.resteARealiser,
        totalOriginalHt: acc.totalOriginalHt + ds.originalHt,
        totalPv: acc.totalPv + ds.pvTotal,
        totalMv: acc.totalMv + ds.mvTotal,
      }),
      {
        totalContractedHt: 0,
        totalCertifiedHt: 0,
        totalResteARealiser: 0,
        totalOriginalHt: 0,
        totalPv: 0,
        totalMv: 0,
      }
    );

    res.json({
      projectId,
      projectName: project.name,
      projectCode: project.code,
      devis: devisSummaries,
      ...totals,
    });
  });

  // ── Project Invoices (convenience) ──

  app.get("/api/projects/:projectId/invoices", async (req, res) => {
    const invs = await storage.getInvoicesByProject(Number(req.params.projectId));
    res.json(invs);
  });

  // ── Dashboard Summary ──

  app.get("/api/dashboard/summary", async (_req, res) => {
    const allProjects = await storage.getProjects();
    const recentInvoices = await storage.getRecentInvoices(10);
    const recentCertificats = await storage.getRecentCertificats(10);
    const allInvoices = await storage.getAllInvoices();
    const allCertificatsData = await storage.getAllCertificats();
    const contractors = await storage.getContractors();

    const contractorMap = new Map(contractors.map(c => [c.id, c.name]));

    let totalContractedHt = 0;
    let totalCertifiedHt = 0;
    let totalResteARealiser = 0;

    const projectSummaries = await Promise.all(
      allProjects.map(async (project) => {
        const projectDevis = await storage.getDevisByProject(project.id);
        const projectInvoices = allInvoices.filter(inv => inv.projectId === project.id);

        let projContracted = 0;
        let projCertified = 0;
        let projReste = 0;
        let anomalyCount = 0;

        for (const d of projectDevis) {
          const avs = await storage.getAvenantsByDevis(d.id);
          const originalHt = parseFloat(d.amountHt);
          const approvedAvenants = avs.filter(a => a.status === "approved");
          const pvTotal = approvedAvenants.filter(a => a.type === "pv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
          const mvTotal = approvedAvenants.filter(a => a.type === "mv").reduce((s, a) => s + parseFloat(a.amountHt), 0);
          const adjustedHt = originalHt + pvTotal - mvTotal;
          const certifiedHt = projectInvoices.filter(inv => inv.devisId === d.id).reduce((s, inv) => s + parseFloat(inv.amountHt), 0);
          const resteARealiser = adjustedHt - certifiedHt;

          projContracted += adjustedHt;
          projCertified += certifiedHt;
          projReste += resteARealiser;

          if (resteARealiser < 0 || certifiedHt > adjustedHt) anomalyCount++;
        }

        totalContractedHt += projContracted;
        totalCertifiedHt += projCertified;
        totalResteARealiser += projReste;

        return {
          id: project.id,
          name: project.name,
          code: project.code,
          clientName: project.clientName,
          status: project.status,
          devisCount: projectDevis.length,
          contractedHt: projContracted,
          certifiedHt: projCertified,
          resteARealiser: projReste,
          progress: projContracted > 0 ? Math.min((projCertified / projContracted) * 100, 100) : 0,
          anomalyCount,
        };
      })
    );

    const overdueInvoices = allInvoices.filter(inv => inv.status === "overdue");
    const pendingCertificats = allCertificatsData.filter(c => c.status === "draft" || c.status === "ready");

    const urgentItems: Array<{ type: string; label: string; projectId: number; id: number; amount: string }> = [];
    for (const inv of overdueInvoices) {
      urgentItems.push({
        type: "overdue_invoice",
        label: `Facture F${inv.invoiceNumber} en retard`,
        projectId: inv.projectId,
        id: inv.id,
        amount: inv.amountTtc,
      });
    }
    for (const cert of pendingCertificats) {
      urgentItems.push({
        type: cert.status === "draft" ? "cert_draft" : "cert_review",
        label: `Certificat ${cert.certificateRef} — ${cert.status === "draft" ? "brouillon" : "en attente de revue"}`,
        projectId: cert.projectId,
        id: cert.id,
        amount: cert.netToPayTtc,
      });
    }

    for (const ps of projectSummaries) {
      if (ps.anomalyCount > 0) {
        urgentItems.push({
          type: "anomaly",
          label: `${ps.code} — ${ps.anomalyCount} anomalie${ps.anomalyCount > 1 ? "s" : ""} détectée${ps.anomalyCount > 1 ? "s" : ""}`,
          projectId: ps.id,
          id: ps.id,
          amount: "0",
        });
      }
    }

    const recentActivity: Array<{ type: string; label: string; date: string | null; amount: string; projectId: number; contractor: string }> = [];
    for (const inv of recentInvoices) {
      recentActivity.push({
        type: "invoice",
        label: `Facture F${inv.invoiceNumber}${inv.certificateNumber ? ` (${inv.certificateNumber})` : ""}`,
        date: inv.dateIssued ?? inv.createdAt?.toISOString().split("T")[0] ?? null,
        amount: inv.amountTtc,
        projectId: inv.projectId,
        contractor: contractorMap.get(inv.contractorId) ?? `#${inv.contractorId}`,
      });
    }
    for (const cert of recentCertificats) {
      recentActivity.push({
        type: "certificat",
        label: `Certificat ${cert.certificateRef}`,
        date: cert.dateIssued ?? cert.createdAt?.toISOString().split("T")[0] ?? null,
        amount: cert.netToPayTtc,
        projectId: cert.projectId,
        contractor: contractorMap.get(cert.contractorId) ?? `#${cert.contractorId}`,
      });
    }

    recentActivity.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    });

    res.json({
      overview: {
        activeProjects: allProjects.filter(p => p.status === "active").length,
        totalProjects: allProjects.length,
        totalContractedHt,
        totalCertifiedHt,
        totalResteARealiser,
      },
      projectSummaries,
      recentActivity: recentActivity.slice(0, 15),
      urgentItems,
    });
  });

  return httpServer;
}
