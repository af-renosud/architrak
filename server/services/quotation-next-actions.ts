import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { certificatPaymentSuggestions, certificatSources, certificats, invoices, situations, projectCommunications } from "@shared/schema";
import type { ProjectNextActions } from "@shared/quotation-next-actions";
import { getProjectDevisReadiness } from "./devis-readiness";
import { deriveQuotationNextActions, type CertificateActionEvidence } from "./quotation-next-action-rules";

/** Bounded number of project-scoped queries, never a network or AI call per row. */
export async function getProjectQuotationNextActions(projectId: number): Promise<ProjectNextActions | null> {
  const project = await storage.getProject(projectId);
  if (!project) return null;
  if (project.archivedAt) return { projectId, generatedAt: new Date().toISOString(), quotations: {}, actionableCount: 0 };
  const [devis, certificates, payments, readiness, suggestions, links, communications] = await Promise.all([
    storage.getDevisByProject(projectId),
    storage.getCertificatsByProject(projectId),
    storage.getCertificatPaymentsByProject(projectId),
    getProjectDevisReadiness(projectId),
    db.select({ certificatId: certificatPaymentSuggestions.certificatId })
      .from(certificatPaymentSuggestions).where(and(eq(certificatPaymentSuggestions.projectId, projectId),
        inArray(certificatPaymentSuggestions.status, ["pending_review", "ambiguous"]))),
    db.select({ certificateId: certificatSources.certificatId,
      invoiceId: certificatSources.invoiceId, invoiceDevisId: invoices.devisId,
      situationDevisId: situations.devisId })
      .from(certificatSources).innerJoin(certificats, eq(certificats.id, certificatSources.certificatId))
      .leftJoin(invoices, eq(invoices.id, certificatSources.invoiceId))
      .leftJoin(situations, eq(situations.id, certificatSources.situationId))
      .where(eq(certificats.projectId, projectId)),
    db.select({ certificateId: projectCommunications.relatedCertificatId, status: projectCommunications.status,
      sentAt: projectCommunications.sentAt, recipientEmail: projectCommunications.recipientEmail })
      .from(projectCommunications).where(and(eq(projectCommunications.projectId, projectId),
        eq(projectCommunications.type, "certificat_sent"))),
  ]);
  const pending = new Set(suggestions.map(s => s.certificatId));
  const delivered = new Set(communications.filter(c => c.status === "sent" && c.sentAt && c.recipientEmail).map(c => c.certificateId));
  const failed = new Set(communications.filter(c => c.status === "failed").map(c => c.certificateId));
  const sending = new Set(communications.filter(c => ["queued", "sending"].includes(c.status)).map(c => c.certificateId));
  const payByCert = new Map<number, typeof payments>();
  for (const p of payments) payByCert.set(p.certificatId, [...(payByCert.get(p.certificatId) ?? []), p]);
  const linksByCert = new Map<number, typeof links>();
  for (const link of links) linksByCert.set(link.certificateId, [...(linksByCert.get(link.certificateId) ?? []), link]);
  const evidenceByDevis = new Map<number, CertificateActionEvidence[]>();
  const devisById = new Map(devis.map(d => [d.id, d]));
  for (const certificate of certificates) {
    const sources = linksByCert.get(certificate.id) ?? [];
    const relatedIds = new Set([certificate.acompteDevisId, ...sources.map(s => s.invoiceDevisId ?? s.situationDevisId)]
      .filter((id): id is number => id != null));
    for (const id of Array.from(relatedIds)) {
      const d = devisById.get(id);
      if (!d || d.contractorId !== certificate.contractorId) continue;
      const evidence: CertificateActionEvidence = {
        certificate, deposit: certificate.acompteDevisId === id || sources.some(s => !!d.acompteInvoiceId && s.invoiceId === d.acompteInvoiceId),
        payments: payByCert.get(certificate.id) ?? [], delivered: delivered.has(certificate.id),
        failedDelivery: failed.has(certificate.id), pendingDelivery: sending.has(certificate.id), pendingEvidence: pending.has(certificate.id),
      };
      evidenceByDevis.set(id, [...(evidenceByDevis.get(id) ?? []), evidence]);
    }
  }
  const quotations: ProjectNextActions["quotations"] = {};
  for (const d of devis) {
    quotations[d.id] = deriveQuotationNextActions({
      devis: d, archived: false, readiness: readiness[d.id], certificates: evidenceByDevis.get(d.id) ?? [],
      unscopedCertificate: certificates.find(c => c.contractorId === d.contractorId &&
        !["superseded", "void", "cancelled"].includes(c.status) && !c.acompteDevisId && !(linksByCert.get(c.id)?.length)),
    });
  }
  return { projectId, generatedAt: new Date().toISOString(), quotations,
    actionableCount: Object.values(quotations).filter(q => q.actionable).length };
}
