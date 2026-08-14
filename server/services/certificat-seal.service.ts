import { storage } from "../storage";
import { generateCertificatPdf } from "../communications/certificat-generator";
import { resolveCertificatDeductions } from "./certificat-deductions.service";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import type { Certificat, InsertCertificatSource } from "@shared/schema";

/**
 * Task #451 — certificat issuance seal.
 *
 * A certificat de paiement is a payment instruction: once issued it must
 * never silently re-render with different numbers. Previews are ephemeral
 * (generator `mode: "preview"` persists nothing); this service is the ONLY
 * path that materialises a certificat PDF durably.
 *
 * Sealing semantics:
 * - If the certificat already carries a pinned `pdfStorageKey`, we reuse it
 *   verbatim — no regeneration, so a re-send attaches the exact issued bytes.
 * - Otherwise: capture the row (including its optimistic-concurrency
 *   `version`), render in issue mode, then attempt the seal via a
 *   conditional UPDATE (`WHERE pdf_storage_key IS NULL AND version =
 *   <captured>`). The version guard guarantees the pinned PDF, the
 *   `issuanceSnapshot` and the persisted financial fields all reflect the
 *   SAME inputs: any PATCH interleaved with the render bumps the version,
 *   the guard misses, and we re-render from the fresh values (bounded
 *   retries). Under concurrent sends exactly one caller wins; a loser
 *   reloads the row and reuses the winner's pinned key (its own freshly
 *   uploaded object is an orphan, harmless).
 * - The seal columns and the `certificat_sources` junction rows — one per
 *   invoice actually included in the rendered annexe, plus every situation
 *   FK-linked to those invoices — commit in ONE transaction inside
 *   `storage.sealCertificat`, so a sealed certificat can never exist
 *   without its source links.
 * - The Drive mirror is enqueued ONLY by the seal winner, with the winner's
 *   pinned key. The Drive queue dedupes on (doc_kind, doc_id) and keeps the
 *   first submitted key, so enqueuing before the winner is known could pin
 *   one render while Drive mirrors another.
 */
const MAX_SEAL_ATTEMPTS = 3;

export async function sealCertificat(certificatId: number): Promise<{
  certificat: Certificat;
  pdfStorageKey: string;
  alreadySealed: boolean;
}> {
  for (let attempt = 1; attempt <= MAX_SEAL_ATTEMPTS; attempt++) {
    const existing = await storage.getCertificat(certificatId);
    if (!existing) throw new Error(`Certificat ${certificatId} not found`);
    if (existing.pdfStorageKey) {
      return { certificat: existing, pdfStorageKey: existing.pdfStorageKey, alreadySealed: true };
    }

    // Task #462 — deductions are resolved on create/PATCH, but the world can
    // move between then and issuance (a deposit becomes 'paid', a marché
    // recoupment rule changes, a prior certificat is reissued). Sealing is
    // the moment money actually leaves, so re-resolve authoritatively here;
    // if anything drifted, persist the fresh figures (bumps `version`) and
    // retry the loop so the render + snapshot use the corrected row.
    const freshDeductions = await resolveCertificatDeductions({
      projectId: existing.projectId,
      contractorId: existing.contractorId,
      totalWorksHt: existing.totalWorksHt,
      pvMvAdjustment: existing.pvMvAdjustment,
      previousPayments: existing.previousPayments,
      // The stored retenue/prorata cumulatives may embed an explicit
      // architect override recorded at create/PATCH time (the override
      // itself is not persisted); pass them back as overrides so the seal
      // recompute refreshes ONLY the acompte recoupment + net figures and
      // never silently reverts an override to the standard rate math.
      retenueOverride: existing.retenueGarantie,
      prorataOverride: existing.cumulativeProrataDeduction,
      excludeCertificatId: certificatId,
    });
    const drifted = (Object.entries(freshDeductions) as Array<[keyof typeof freshDeductions, string]>)
      .some(([key, value]) => (existing[key] ?? "0.00") !== value);
    if (drifted) {
      await storage.updateCertificat(certificatId, freshDeductions);
      continue;
    }

    // Version captured BEFORE rendering — the seal only commits if it still
    // matches, so the PDF/snapshot/row can never disagree.
    const expectedVersion = existing.version;

    const rendered = await generateCertificatPdf(certificatId, { mode: "issue" });
    if (!rendered.storageKey) {
      throw new Error(`Certificat ${certificatId} issuance render did not persist a storage key`);
    }

    const today = new Date().toISOString().split("T")[0];
    const dateIssued = existing.dateIssued ?? today;

    // Junction rows are computed BEFORE the seal write so the conditional
    // UPDATE and the certificat_sources inserts commit in one transaction —
    // a sealed certificat without its source links must be impossible.
    const sourceRows: InsertCertificatSource[] = rendered.sourceInvoiceIds.map((invoiceId) => ({
      certificatId,
      invoiceId,
      situationId: null,
    }));
    const situationIds = new Set<number>();
    const devisSeen = new Set<number>();
    for (const invoiceId of rendered.sourceInvoiceIds) {
      const invoice = await storage.getInvoice(invoiceId);
      if (!invoice || devisSeen.has(invoice.devisId)) continue;
      devisSeen.add(invoice.devisId);
      const situations = await storage.getSituationsByDevis(invoice.devisId);
      for (const s of situations) {
        if (s.invoiceId != null && rendered.sourceInvoiceIds.includes(s.invoiceId)) {
          situationIds.add(s.id);
        }
      }
    }
    for (const situationId of Array.from(situationIds)) {
      sourceRows.push({ certificatId, situationId, invoiceId: null });
    }

    // Immutable record of the financial inputs at issuance — audit evidence
    // that outlives any later (blocked) edit attempt or contract recompute.
    const issuanceSnapshot = {
      sealedAt: new Date().toISOString(),
      projectId: existing.projectId,
      contractorId: existing.contractorId,
      certificateRef: existing.certificateRef,
      dateIssued,
      totalWorksHt: existing.totalWorksHt,
      pvMvAdjustment: existing.pvMvAdjustment,
      previousPayments: existing.previousPayments,
      retenueGarantie: existing.retenueGarantie,
      cumulativeProrataDeduction: existing.cumulativeProrataDeduction,
      periodProrataDeduction: existing.periodProrataDeduction,
      cumulativeAcompteRecoupment: existing.cumulativeAcompteRecoupment,
      periodAcompteRecoupment: existing.periodAcompteRecoupment,
      netToPayHt: existing.netToPayHt,
      tvaAmount: existing.tvaAmount,
      netToPayTtc: existing.netToPayTtc,
      sourceInvoiceIds: rendered.sourceInvoiceIds,
      pdfFileName: rendered.fileName,
    };

    const sealed = await storage.sealCertificat(certificatId, {
      pdfStorageKey: rendered.storageKey,
      pdfFileName: rendered.fileName,
      issuanceSnapshot,
      dateIssued,
      sourceRows,
      expectedVersion,
    });

    if (sealed) {
      // Winner-only Drive mirror, with the pinned key. Idempotent on
      // (doc_kind, doc_id); no-ops when DRIVE_AUTO_UPLOAD_ENABLED is false.
      if (rendered.driveSeed) {
        void enqueueDriveUpload({
          docKind: "certificat",
          docId: certificatId,
          projectId: rendered.driveSeed.projectId,
          lotId: rendered.driveSeed.lotId,
          sourceStorageKey: rendered.storageKey,
          displayName: rendered.driveSeed.displayName,
          seedDevisCode: rendered.driveSeed.seedDevisCode,
        });
      }
      return { certificat: sealed, pdfStorageKey: rendered.storageKey, alreadySealed: false };
    }

    // Guard missed. Either another caller pinned first (reuse its bytes —
    // never expose two renders of the same certificat) …
    const current = await storage.getCertificat(certificatId);
    if (current?.pdfStorageKey) {
      return { certificat: current, pdfStorageKey: current.pdfStorageKey, alreadySealed: true };
    }
    // … or a PATCH bumped the version mid-render: loop and re-render from
    // the fresh financial inputs.
  }

  throw new Error(
    `Certificat ${certificatId} could not be sealed after ${MAX_SEAL_ATTEMPTS} attempts — concurrent edits kept changing the financial inputs`,
  );
}
