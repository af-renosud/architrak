import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });

/**
 * Task #451 — read-only per-devis Document Chain.
 *
 * Devis → (Commande / Marché) → ordered Situations → Factures →
 * Certificat(s). Pure aggregate: no writes, no side effects. Every node
 * reports presence booleans for its source / pinned PDFs so the UI can flag
 * missing evidence conspicuously; the path adapts to `invoicingMode`
 * (Mode B routes progress through Situations, Mode A goes straight from
 * devis line tick-off to Factures).
 *
 * Certificat linkage is FK-grounded via `certificat_sources` (Task #451
 * seal) — a certificat appears in the chain of every devis whose invoices
 * or situations it certifies.
 */
router.get(
  "/api/devis/:id/document-chain",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const d = await storage.getDevis(devisId);
    if (!d) return res.status(404).json({ message: "Devis not found" });

    const [marche, situations, invoices] = await Promise.all([
      d.marcheId ? storage.getMarche(d.marcheId) : Promise.resolve(undefined),
      storage.getSituationsByDevis(devisId),
      storage.getInvoicesByDevis(devisId),
    ]);

    const orderedSituations = [...situations].sort((a, b) => a.situationNumber - b.situationNumber);

    // Certificats certifying any of this devis's invoices/situations.
    const links = await storage.getCertificatSourcesForDocuments({
      invoiceIds: invoices.map((i) => i.id),
      situationIds: orderedSituations.map((s) => s.id),
    });
    const certificatIds = Array.from(new Set(links.map((l) => l.certificatId)));
    const certificats = (
      await Promise.all(certificatIds.map((id) => storage.getCertificat(id)))
    ).filter(<T,>(c: T | undefined): c is T => c !== undefined);

    // Task #457 — reissue drafts have no certificat_sources rows until they
    // are sealed, but the chain must show BOTH the superseded original and
    // its replacement. Walk the reissue lineage transitively (a reissue can
    // itself be reissued after sealing).
    let frontier = certificats.map((c) => c.id);
    while (frontier.length > 0) {
      const reissues = (await storage.getCertificatReissues(frontier))
        .filter((r) => !certificats.some((c) => c.id === r.id));
      certificats.push(...reissues);
      frontier = reissues.map((r) => r.id);
    }

    res.json({
      devis: {
        id: d.id,
        devisCode: d.devisCode,
        status: d.status,
        signOffStage: d.signOffStage,
        invoicingMode: d.invoicingMode,
        amountHt: d.amountHt,
        amountTtc: d.amountTtc,
        dateSent: d.dateSent,
        dateSigned: d.dateSigned,
        hasSourcePdf: !!d.pdfStorageKey,
        hasSignedPdf: !!d.signedPdfStorageKey,
        projectId: d.projectId,
        contractorId: d.contractorId,
      },
      marche: marche
        ? {
            id: marche.id,
            marcheNumber: marche.marcheNumber,
            status: marche.status,
            signedDate: marche.signedDate,
            totalHt: marche.totalHt,
            totalTtc: marche.totalTtc,
          }
        : null,
      situations: orderedSituations.map((s) => ({
        id: s.id,
        situationNumber: s.situationNumber,
        status: s.status,
        dateIssued: s.dateIssued,
        cumulativeHt: s.cumulativeHt,
        netHt: s.netHt,
        netToPayTtc: s.netToPayTtc,
        invoiceId: s.invoiceId,
      })),
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        dateIssued: inv.dateIssued,
        dateSent: inv.dateSent,
        datePaid: inv.datePaid,
        amountHt: inv.amountHt,
        amountTtc: inv.amountTtc,
        hasSourcePdf: !!inv.pdfPath,
        certificatIds: links.filter((l) => l.invoiceId === inv.id).map((l) => l.certificatId),
      })),
      certificats: certificats.map((c) => ({
        id: c.id,
        certificateRef: c.certificateRef,
        status: c.status,
        dateIssued: c.dateIssued,
        issuedAt: c.issuedAt,
        netToPayHt: c.netToPayHt,
        netToPayTtc: c.netToPayTtc,
        sealed: !!c.pdfStorageKey,
        reissuedFromCertificatId: c.reissuedFromCertificatId,
        sourceInvoiceIds: links.filter((l) => l.certificatId === c.id && l.invoiceId != null).map((l) => l.invoiceId),
        sourceSituationIds: links.filter((l) => l.certificatId === c.id && l.situationId != null).map((l) => l.situationId),
      })),
    });
  },
);

export default router;
