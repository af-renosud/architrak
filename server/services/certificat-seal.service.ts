import {
  storage,
  SupplierDirectPaymentSealConflictError,
  type ContractorTvaAuthoritySealGuard,
} from "../storage";
import { generateCertificatPdf } from "../communications/certificat-generator";
import {
  resolveCertificatDeductions,
  resolveCertificatTvaDecision,
  type TvaRateSource,
} from "./certificat-deductions.service";
import { enqueueDriveUpload } from "./drive/upload-queue.service";
import type { Certificat, InsertCertificatSource } from "@shared/schema";
import {
  deriveCertificatFromInvoices,
  SupplierCertificateSourceError,
} from "./certificat-from-invoices.service";
import {
  assertSupplierPaymentReadiness,
} from "./supplier-payment-readiness.service";
import type { SupplierPaymentReadinessSnapshot } from "@shared/supplier-payment-readiness";
import {
  isSupplierDirectPaymentAllowedForProject,
  SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED,
} from "./supplier-certificate-rollout.service";

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
    // Legacy rows are backfilled by migration 0115. The nullish fallback also
    // keeps pre-migration fixtures and restored snapshots on the historical
    // contractor track rather than accidentally entering supplier logic.
    const certificateTrack =
      existing.certificateTrack ?? "contractor_works";

    // Task #462 — deductions are resolved on create/PATCH, but the world can
    // move between then and issuance (a deposit becomes 'paid', a marché
    // recoupment rule changes, a prior certificat is reissued). Sealing is
    // the moment money actually leaves, so re-resolve authoritatively here;
    // if anything drifted, persist the fresh figures (bumps `version`) and
    // retry the loop so the render + snapshot use the corrected row.
    // Task #491 — ACOMPTE certificats sit outside the progress waterfall:
    // their money is fixed at creation from the devis's own acompte spec
    // (no retenue, no prorata, no recoupment, no previous payments) and
    // must never be re-resolved through the cumulative deduction engine —
    // the resolver's prior-cumulative math is meaningless for a deposit.
    const today = new Date().toISOString().split("T")[0];
    const dateIssued = existing.dateIssued ?? today;
    let supplierReadinessSnapshot: SupplierPaymentReadinessSnapshot | null =
      null;
    let supplierSourceSnapshot:
      | {
          invoices: Array<{
            invoiceId: number;
            invoiceNumber: string;
            invoiceDate: string | null;
            amountHt: string;
            tvaAmount: string;
            amountTtc: string;
            devisId: number;
            invoiceExtractedIban: string | null;
            devisStatus: string;
            devisAcompteInvoiceId: number | null;
            devisExtractedIban: string | null;
          }>;
        }
      | null = null;

    let freshDeductions;
    let contractorExactInvoiceIds: number[] = [];
    if (certificateTrack === "supplier_direct_payment") {
      const project = await storage.getProject(existing.projectId);
      if (
        !project?.archidocId ||
        !isSupplierDirectPaymentAllowedForProject(project.archidocId)
      ) {
        throw new SupplierCertificateSourceError(
          `${SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED}: le paiement direct fournisseur n'est pas activé pour ce projet.`,
        );
      }
      // One final, issue-date-bound handoff authorizes every subsequent seal
      // check. It is also the exact snapshot rendered and persisted.
      supplierReadinessSnapshot = await assertSupplierPaymentReadiness({
        contractorId: existing.contractorId,
        projectId: existing.projectId,
        issueDate: dateIssued,
        verifyProtectedRib: true,
      });
      const existingSources = await storage.getCertificatSources(certificatId);
      const sourceInvoiceIds = Array.from(
        new Set(
          existingSources
            .map((source) => source.invoiceId)
            .filter((invoiceId): invoiceId is number => invoiceId != null),
        ),
      );
      if (
        sourceInvoiceIds.length === 0 ||
        existingSources.some(
          (source) => source.situationId != null || source.invoiceId == null,
        )
      ) {
        throw new SupplierCertificateSourceError(
          "Le paiement direct fournisseur ne possède pas un ensemble de sources facture-only valide.",
        );
      }
      const derivation = await deriveCertificatFromInvoices(sourceInvoiceIds, {
        allowCertificatId: certificatId,
        issueDate: dateIssued,
        supplierReadinessSnapshot,
      });
      if (
        !derivation.ok ||
        derivation.derivation.certificateTrack !==
          "supplier_direct_payment"
      ) {
        throw new SupplierCertificateSourceError(
          derivation.ok
            ? "L'intervenant n'est plus classé comme fournisseur."
            : derivation.refusal.body.message,
        );
      }
      const supplier = derivation.derivation;
      const guardedInvoices = await Promise.all(
        supplier.invoices.map(async (source) => {
          const [invoice, parentDevis] = await Promise.all([
            storage.getInvoice(source.invoiceId),
            storage.getDevis(source.devisId),
          ]);
          if (
            !invoice ||
            !parentDevis ||
            invoice.devisId !== parentDevis.id
          ) {
            throw new SupplierCertificateSourceError(
              "Une facture ou son devis de rattachement a disparu avant l'émission.",
            );
          }
          return {
            invoiceId: source.invoiceId,
            devisId: source.devisId,
            invoiceNumber: source.invoiceNumber,
            invoiceDate: invoice.dateIssued,
            amountHt: source.amountHt,
            tvaAmount: source.tvaAmount,
            amountTtc: source.amountTtc,
            invoiceExtractedIban: invoice.extractedIban,
            devisStatus: parentDevis.status,
            devisAcompteInvoiceId: parentDevis.acompteInvoiceId,
            devisExtractedIban: parentDevis.extractedIban,
          };
        }),
      );
      supplierSourceSnapshot = {
        invoices: guardedInvoices,
      };
      freshDeductions = {
        totalWorksHt: supplier.totalWorksHt,
        pvMvAdjustment: "0.00",
        previousPayments: "0.00",
        retenueGarantie: "0.00",
        cumulativeProrataDeduction: "0.00",
        periodProrataDeduction: "0.00",
        cumulativeAcompteRecoupment: "0.00",
        periodAcompteRecoupment: "0.00",
        tvaRatePercent: supplier.supplierDirectPayment.tvaRatePercent,
        tvaAutoliquidation: false,
        tvaRateSource: "documentary",
        netToPayHt: supplier.supplierDirectPayment.netToPayHt,
        tvaAmount: supplier.supplierDirectPayment.tvaAmount,
        netToPayTtc: supplier.supplierDirectPayment.netToPayTtc,
        isSolde: false,
        retenueReleased: false,
        retenueReleaseAmount: "0.00",
        retenueReleaseReason: null,
        retenueReleaseDate: null,
        pvOverrideReason: null,
        pvOverrideByUserId: null,
        pvOverrideAt: null,
      };
    } else {
      const existingSources = await storage.getCertificatSources(certificatId);
      const exactInvoiceIds = Array.from(
        new Set(
          existingSources
            .map((source) => source.invoiceId)
            .filter((invoiceId): invoiceId is number => invoiceId != null),
        ),
      );
      contractorExactInvoiceIds = exactInvoiceIds;
      const exactInvoices = await Promise.all(
        exactInvoiceIds.map(async (invoiceId) => {
          const invoice = await storage.getInvoice(invoiceId);
          if (!invoice) {
            throw new Error(
              `Certificat ${certificatId} TVA source invoice ${invoiceId} not found`,
            );
          }
          return {
            amountHt: invoice.amountHt,
            amountTtc: invoice.amountTtc,
          };
        }),
      );
      const hasExactInvoiceAuthority =
        existing.tvaEvidenceKind === "exact_invoices";
      const preservesHistoricalDecision =
        existing.tvaEvidenceKind === "signed_quotation" ||
        existing.tvaEvidenceKind === "legacy";
      freshDeductions = existing.acompteDevisId != null ? null : await resolveCertificatDeductions({
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
      // Exact invoice-backed certificats must stay bound to their persisted
      // source set; unrelated contractor invoices may never dilute that rate.
      // Source-less documentary rows are manual quotation drafts, so preserve
      // the already server-resolved decision through issuance.
      documentaryBasisInvoices:
        hasExactInvoiceAuthority
          ? exactInvoices
          : preservesHistoricalDecision &&
              existing.tvaRateSource !== "autoliquidation"
            ? undefined
            : [],
      legacyTvaDecision:
        preservesHistoricalDecision &&
        existing.tvaRateSource !== "autoliquidation"
          ? {
              ratePercent: existing.tvaRatePercent,
              source: existing.tvaRateSource as Exclude<
                TvaRateSource,
                "autoliquidation"
              >,
            }
          : undefined,
      // Keep the persisted server decision stable while refreshing the other
      // deductions. After rendering, the exact rendered source set and current
      // configuration are re-resolved and transactionally validated at seal.
      resolvedTvaDecision: {
        ratePercent: Number(existing.tvaRatePercent),
        autoliquidation: existing.tvaAutoliquidation,
        source: existing.tvaRateSource as TvaRateSource,
      },
      // Task #464 — the seal FREEZES the solde designation and the retenue
      // release state as recorded on the draft; changing either after
      // issuance requires the reissue flow.
      isSolde: existing.isSolde,
      releaseRetenue: existing.retenueReleased,
      // Task #566 — a recorded override on the row keeps satisfying the PV
      // de réception gate through the seal recompute.
      pvOverride: existing.pvOverrideReason != null,
      excludeCertificatId: certificatId,
      });
    }
    if (freshDeductions) {
      const drifted = (
        Object.entries(freshDeductions) as Array<
          [keyof Certificat, unknown]
        >
      ).some(([key, value]) => existing[key] !== value);
      if (drifted) {
        await storage.updateCertificatUnsealed(
          certificatId,
          freshDeductions,
          existing.version,
        );
        continue;
      }
    }

    // Version captured BEFORE rendering — the seal only commits if it still
    // matches, so the PDF/snapshot/row can never disagree.
    const expectedVersion = existing.version;

    const rendered = await generateCertificatPdf(certificatId, {
      mode: "issue",
      ...(supplierReadinessSnapshot
        ? { supplierReadinessSnapshot }
        : {}),
    });
    if (!rendered.storageKey) {
      throw new Error(`Certificat ${certificatId} issuance render did not persist a storage key`);
    }
    if (
      certificateTrack === "supplier_direct_payment" &&
      !rendered.supplierPresentation
    ) {
      throw new Error(
        `Certificat ${certificatId} issuance render did not produce a frozen supplier presentation`,
      );
    }
    if (certificateTrack === "supplier_direct_payment") {
      const expectedSourceIds = (supplierSourceSnapshot?.invoices ?? [])
        .map((invoice) => invoice.invoiceId)
        .sort((a, b) => a - b);
      const renderedSourceIds = Array.from(
        new Set(rendered.sourceInvoiceIds),
      ).sort((a, b) => a - b);
      if (
        expectedSourceIds.length !== renderedSourceIds.length ||
        expectedSourceIds.some(
          (invoiceId, index) => invoiceId !== renderedSourceIds[index],
        )
      ) {
        throw new SupplierCertificateSourceError(
          "Le PDF fournisseur rendu ne contient pas exactement l'ensemble de factures verrouillé par le certificat.",
        );
      }
    }

    let contractorTvaAuthorityGuard:
      | ContractorTvaAuthoritySealGuard
      | undefined;
    if (
      certificateTrack === "contractor_works" &&
      existing.acompteDevisId == null
    ) {
      const renderedInvoiceIds = Array.from(
        new Set(rendered.sourceInvoiceIds),
      ).sort((a, b) => a - b);
      const renderedInvoices = [...rendered.sourceInvoiceSnapshot].sort(
        (a, b) => a.invoiceId - b.invoiceId,
      );
      if (
        renderedInvoices.length !== renderedInvoiceIds.length ||
        renderedInvoices.some(
          (invoice, index) =>
            invoice.invoiceId !== renderedInvoiceIds[index] ||
            invoice.projectId !== existing.projectId ||
            invoice.contractorId !== existing.contractorId,
        )
      ) {
        throw new Error(
          `Certificat ${certificatId} render did not return its exact invoice authority snapshot`,
        );
      }
      const contractor = await storage.getContractor(existing.contractorId);
      if (!contractor) {
        throw new Error(
          `Certificat ${certificatId} contractor ${existing.contractorId} not found`,
        );
      }
      const marche =
        (await storage.getMarchesByProject(existing.projectId))
          .filter((row) => row.contractorId === existing.contractorId)
          .sort((a, b) => a.id - b.id)[0] ?? null;
      const hasExactPersistedSources =
        existing.tvaEvidenceKind === "exact_invoices";
      if (
        hasExactPersistedSources &&
        (contractorExactInvoiceIds.length === 0 ||
          contractorExactInvoiceIds.length !== renderedInvoiceIds.length ||
          [...contractorExactInvoiceIds]
            .sort((a, b) => a - b)
            .some(
              (invoiceId, index) => invoiceId !== renderedInvoiceIds[index],
            ))
      ) {
        throw new Error(
          `Certificat ${certificatId} rendered sources differ from its persisted source set`,
        );
      }
      const documentaryBasisInvoices = hasExactPersistedSources
        ? renderedInvoices.map((invoice) => ({
            amountHt: invoice.amountHt,
            amountTtc: invoice.amountTtc,
          }))
        : undefined;
      const legacySource =
        (existing.tvaEvidenceKind === "signed_quotation" ||
          existing.tvaEvidenceKind === "legacy") &&
        existing.tvaRateSource !== "autoliquidation"
          ? (existing.tvaRateSource as Exclude<
              TvaRateSource,
              "autoliquidation"
            >)
          : null;
      const explicitDocumentaryBasisInvoices = hasExactPersistedSources
        ? documentaryBasisInvoices
        : legacySource
          ? undefined
          : [];
      const renderedTvaDecision = await resolveCertificatTvaDecision({
        projectId: existing.projectId,
        contractorId: existing.contractorId,
        documentaryBasisInvoices: explicitDocumentaryBasisInvoices,
        legacyTvaDecision: legacySource
          ? {
              ratePercent: existing.tvaRatePercent,
              source: legacySource,
            }
          : undefined,
        lockedTvaContext: {
          contractor,
          marche,
        },
      });
      const renderedTvaDrifted =
        existing.tvaRatePercent !==
          renderedTvaDecision.ratePercent.toFixed(2) ||
        existing.tvaAutoliquidation !==
          renderedTvaDecision.autoliquidation ||
        existing.tvaRateSource !== renderedTvaDecision.source;
      if (renderedTvaDrifted) {
        const renderedDeductions = await resolveCertificatDeductions({
          projectId: existing.projectId,
          contractorId: existing.contractorId,
          totalWorksHt: existing.totalWorksHt,
          pvMvAdjustment: existing.pvMvAdjustment,
          previousPayments: existing.previousPayments,
          retenueOverride: existing.retenueGarantie,
          prorataOverride: existing.cumulativeProrataDeduction,
          documentaryBasisInvoices: explicitDocumentaryBasisInvoices,
          legacyTvaDecision: legacySource
            ? {
                ratePercent: existing.tvaRatePercent,
                source: legacySource,
              }
            : undefined,
          resolvedTvaDecision: renderedTvaDecision,
          isSolde: existing.isSolde,
          releaseRetenue: existing.retenueReleased,
          pvOverride: existing.pvOverrideReason != null,
          excludeCertificatId: certificatId,
        });
        await storage.updateCertificatUnsealed(
          certificatId,
          renderedDeductions,
          existing.version,
        );
        continue;
      }
      contractorTvaAuthorityGuard = {
        decision: {
          ratePercent: renderedTvaDecision.ratePercent.toFixed(2),
          autoliquidation: renderedTvaDecision.autoliquidation,
          source: renderedTvaDecision.source,
        },
        contractor: {
          id: contractor.id,
          defaultTvaRatePercent: contractor.defaultTvaRatePercent,
          defaultTvaAutoliquidation:
            contractor.defaultTvaAutoliquidation,
        },
        marche: marche
          ? {
              id: marche.id,
              tvaRatePercent: marche.tvaRatePercent,
              tvaAutoliquidation: marche.tvaAutoliquidation,
            }
          : null,
        invoices: renderedInvoices.map((invoice) => ({
          invoiceId: invoice.invoiceId,
          projectId: invoice.projectId,
          contractorId: invoice.contractorId,
          amountHt: invoice.amountHt,
          tvaAmount: invoice.tvaAmount,
          amountTtc: invoice.amountTtc,
          status: invoice.status,
          datePaid: invoice.datePaid,
        })),
      };
    }

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
    if (certificateTrack === "contractor_works") {
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
      certificateTrack,
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
      tvaRatePercent: existing.tvaRatePercent,
      tvaAutoliquidation: existing.tvaAutoliquidation,
      tvaRateSource: existing.tvaRateSource,
      tvaEvidenceKind: existing.tvaEvidenceKind,
      isSolde: existing.isSolde,
      retenueReleased: existing.retenueReleased,
      retenueReleaseAmount: existing.retenueReleaseAmount,
      retenueReleaseReason: existing.retenueReleaseReason,
      retenueReleaseDate: existing.retenueReleaseDate,
      netToPayHt: existing.netToPayHt,
      tvaAmount: existing.tvaAmount,
      netToPayTtc: existing.netToPayTtc,
      sourceInvoiceIds: rendered.sourceInvoiceIds,
      supplierDirectPayment:
        certificateTrack === "supplier_direct_payment"
          ? {
              projectArchidocId:
                supplierReadinessSnapshot?.assignment.projectId ?? null,
              supplierArchidocId:
                supplierReadinessSnapshot?.supplier.id ?? null,
              readiness: supplierReadinessSnapshot,
              sources: supplierSourceSnapshot,
              presentation: rendered.supplierPresentation,
              paymentTransferRef: rendered.transferRef,
            }
          : null,
      pdfFileName: rendered.fileName,
      pdfStorageKey: rendered.storageKey,
    };

    let sealed: Certificat | null;
    try {
      sealed = await storage.sealCertificat(certificatId, {
        pdfStorageKey: rendered.storageKey,
        pdfFileName: rendered.fileName,
        issuanceSnapshot,
        dateIssued,
        sourceRows,
        expectedVersion,
        // Task #605 — the seal's source-linking pass runs under the same
        // per-(project, contractor) advisory lock as grouped certificat
        // creation, and REFUSES the whole seal (CertificatSourceConflictError,
        // full rollback — the freshly rendered PDF is an orphan) if any
        // rendered source is already certified by another live certificat: a
        // manual certificat can never issue a document authorizing payment of
        // a facture a grouped certificat already certifies.
        projectId: existing.projectId,
        contractorId: existing.contractorId,
        contractorTvaAuthorityGuard,
        supplierDirectPaymentGuard:
          certificateTrack === "supplier_direct_payment" &&
          supplierReadinessSnapshot &&
          supplierSourceSnapshot
            ? {
                readiness: supplierReadinessSnapshot,
                invoices: supplierSourceSnapshot.invoices,
              }
            : undefined,
        // Task #627 — freeze the bank-transfer reference at seal time so every
        // subsequent PDF view, reissue and payment ledger show the same string.
        paymentTransferRef: rendered.transferRef,
      });
    } catch (error) {
      if (error instanceof SupplierDirectPaymentSealConflictError) {
        throw new SupplierCertificateSourceError(error.message);
      }
      throw error;
    }

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
