// ─── Multi-facture certificats — shared derivation & creation ───────────────
//
// Generalizes the Task #496 one-click "certificat from a facture" to a SET of
// factures from the same project + contractor: the certificat is the payment
// authorization for the whole batch. Every figure is server-derived — period
// claims summed across the selected factures onto the latest prior progress
// certificat's cumulative — and the invoice→certificat links are recorded in
// `certificat_sources` at creation (one row per facture). The single-invoice
// endpoint is a thin wrapper around this service.

import { storage } from "../storage";
import { db } from "../db";
import {
  certificats as certificatsTable,
  certificatSources,
  invoices as invoicesTable,
  devis as devisTable,
  contractors as contractorsTable,
  type Certificat,
  type Invoice,
} from "@shared/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { resolveCertificatDeductions } from "./certificat-deductions.service";
import {
  checkInvoiceSetTvaCompatibility,
  computeSupplierDirectPaymentTotals,
} from "@shared/financial-utils";
import {
  assertSupplierPaymentReadiness,
  SupplierPaymentReadinessError,
} from "./supplier-payment-readiness.service";
import type {
  CertificateTrack,
  SupplierPaymentReadinessSnapshot,
} from "@shared/supplier-payment-readiness";
import { ibansMatch, normaliseIban } from "@shared/iban";

interface MultiInvoiceCertDerivationBase {
  contractorId: number;
  projectId: number;
  invoices: Array<{
    invoiceId: number;
    invoiceNumber: string;
    devisId: number;
    mode: "situation" | "invoice";
    periodClaimHt: number;
    amountHt: string;
    tvaAmount: string;
    amountTtc: string;
  }>;
  periodClaimHt: number;
  totalWorksHt: string;
  previousPayments: string;
  priorCertificateRef: string | null;
}

export type MultiInvoiceCertDerivation =
  | (MultiInvoiceCertDerivationBase & {
      certificateTrack: "contractor_works";
      supplierDirectPayment: null;
    })
  | (MultiInvoiceCertDerivationBase & {
      certificateTrack: "supplier_direct_payment";
      supplierDirectPayment: {
        readiness: SupplierPaymentReadinessSnapshot;
        tvaRatePercent: string;
        tvaAmount: string;
        netToPayHt: string;
        netToPayTtc: string;
      };
    });

export type InvoiceCertRefusal =
  | { status: 404; body: { code: string; message: string } }
  | { status: 409; body: { code: string; message: string; certificateRef?: string; certificatId?: number; invoiceId?: number } };

export type DeriveResult =
  | { ok: true; derivation: MultiInvoiceCertDerivation }
  | { ok: false; refusal: InvoiceCertRefusal };

/** Latest non-superseded, non-acompte certificat — same ordering as the resolver. */
export async function latestPriorProgressCert(projectId: number, contractorId: number) {
  const priors = (await storage.getCertificatsByProjectAndContractor(projectId, contractorId)).filter(
    (c) =>
      c.status !== "superseded" &&
      c.acompteDevisId == null &&
      c.certificateTrack === "contractor_works",
  );
  return (
    priors
      .slice()
      .sort((a, b) => {
        const da = a.dateIssued ?? "";
        const dbb = b.dateIssued ?? "";
        if (da !== dbb) return da < dbb ? -1 : 1;
        return a.id - b.id;
      })
      .at(-1) ?? null
  );
}

/** Live (non-superseded) certificat already certifying this invoice, if any. */
export async function liveCertForInvoice(
  invoiceId: number,
  allowCertificatId?: number,
): Promise<Certificat | null> {
  const sources = await storage.getCertificatSourcesForDocuments({ invoiceIds: [invoiceId], situationIds: [] });
  for (const src of sources) {
    if (src.certificatId === allowCertificatId) continue;
    const cert = await storage.getCertificat(src.certificatId);
    if (cert && cert.status !== "superseded") return cert;
  }
  return null;
}

function refuse(status: 404 | 409, body: InvoiceCertRefusal["body"]): DeriveResult {
  return { ok: false, refusal: { status, body } as InvoiceCertRefusal };
}

/**
 * Derive a certificat from one or more factures (all same project+contractor).
 * Read-only: powers both the preview endpoints and the under-lock
 * re-derivation inside `createCertificatFromInvoices`.
 */
export async function deriveCertificatFromInvoices(
  invoiceIds: number[],
  options: { allowCertificatId?: number } = {},
): Promise<DeriveResult> {
  const uniqueIds = Array.from(new Set(invoiceIds));
  if (uniqueIds.length === 0) {
    return refuse(409, { code: "NO_INVOICES", message: "Aucune facture sélectionnée." });
  }

  const loaded: Invoice[] = [];
  for (const id of uniqueIds) {
    const invoice = await storage.getInvoice(id);
    if (!invoice) {
      return refuse(404, { code: "INVOICE_NOT_FOUND", message: "Facture introuvable.", invoiceId: id } as InvoiceCertRefusal["body"]);
    }
    loaded.push(invoice);
  }

  const first = loaded[0];
  for (const invoice of loaded) {
    if (invoice.projectId !== first.projectId) {
      return refuse(409, { code: "MIXED_PROJECTS", message: "Les factures sélectionnées appartiennent à des projets différents." });
    }
    if (invoice.contractorId !== first.contractorId) {
      return refuse(409, {
        code: "MIXED_CONTRACTORS",
        message: "Un certificat regroupe les factures d'une seule entreprise — sélectionnez des factures du même intervenant.",
      });
    }
  }

  const partner = await storage.getContractor(first.contractorId);
  if (!partner) {
    return refuse(404, {
      code: "CONTRACTOR_NOT_FOUND",
      message: "Intervenant introuvable.",
    });
  }

  if (partner.archidocPartnerType === "supplier") {
    let readiness: SupplierPaymentReadinessSnapshot;
    try {
      readiness = await assertSupplierPaymentReadiness({
        contractorId: first.contractorId,
        projectId: first.projectId,
      });
    } catch (error) {
      if (error instanceof SupplierPaymentReadinessError) {
        return refuse(409, {
          code: error.code,
          message:
            error.blockers.includes("readiness_not_synchronised")
              ? "Les données de préparation au paiement de ce fournisseur ne sont pas encore synchronisées depuis ArchiDoc."
              : "Ce fournisseur n'est pas prêt pour un paiement direct. Vérifiez son identité, son contact, ses coordonnées bancaires et son affectation au projet dans ArchiDoc.",
        });
      }
      throw error;
    }

    const supplierRows: MultiInvoiceCertDerivationBase["invoices"] = [];
    for (const invoice of loaded) {
      if (invoice.status !== "approved" || invoice.datePaid != null) {
        return refuse(409, {
          code: invoice.datePaid != null ? "SUPPLIER_INVOICE_PAID" : "SUPPLIER_INVOICE_NOT_APPROVED",
          message:
            invoice.datePaid != null
              ? `La facture #${invoice.invoiceNumber} est déjà payée.`
              : `La facture #${invoice.invoiceNumber} doit être approuvée avant de pouvoir être certifiée pour paiement direct.`,
          invoiceId: invoice.id,
        });
      }
      const devis = await storage.getDevis(invoice.devisId);
      if (!devis) {
        return refuse(404, { code: "DEVIS_NOT_FOUND", message: "Devis parent introuvable." });
      }
      if (devis.status === "void" || devis.signOffStage === "void") {
        return refuse(409, {
          code: "DEVIS_VOID",
          message: `Le devis parent de la facture #${invoice.invoiceNumber} est annulé.`,
          invoiceId: invoice.id,
        });
      }
      if (devis.acompteInvoiceId === invoice.id) {
        return refuse(409, {
          code: "INVOICE_IS_ACOMPTE",
          message: `La facture #${invoice.invoiceNumber} est une facture d'acompte et ne peut pas être utilisée pour un paiement direct fournisseur.`,
          invoiceId: invoice.id,
        });
      }
      const canonicalIban = normaliseIban(partner.iban);
      if (
        devis.extractedIban &&
        !ibansMatch(devis.extractedIban, partner.iban)
      ) {
        const override = await storage.findBankingMismatchOverride({
          docKind: "devis",
          docId: devis.id,
          docIban: devis.extractedIban,
          archidocIban: canonicalIban,
        });
        if (!override) {
          return refuse(409, {
            code: "BANKING_MISMATCH",
            message: `L'IBAN du devis ${devis.devisCode} ne correspond pas à l'IBAN fournisseur vérifié dans ArchiDoc. Un override audité et limité à ce document est requis.`,
            invoiceId: invoice.id,
          });
        }
      }
      if (
        invoice.extractedIban &&
        !ibansMatch(invoice.extractedIban, partner.iban)
      ) {
        const override = await storage.findBankingMismatchOverride({
          docKind: "invoice",
          docId: invoice.id,
          docIban: invoice.extractedIban,
          archidocIban: canonicalIban,
        });
        if (!override) {
          return refuse(409, {
            code: "BANKING_MISMATCH",
            message: `L'IBAN de la facture #${invoice.invoiceNumber} ne correspond pas à l'IBAN fournisseur vérifié dans ArchiDoc. Un override audité et limité à ce document est requis.`,
            invoiceId: invoice.id,
          });
        }
      }
      const situations = await storage.getSituationsByDevis(invoice.devisId);
      if (situations.some((s) => s.invoiceId === invoice.id)) {
        return refuse(409, {
          code: "SUPPLIER_SITUATION_NOT_ALLOWED",
          message: `La facture #${invoice.invoiceNumber} est liée à une situation de travaux — le paiement direct fournisseur accepte uniquement des factures simples.`,
          invoiceId: invoice.id,
        });
      }
      const existingCert = await liveCertForInvoice(
        invoice.id,
        options.allowCertificatId,
      );
      if (existingCert) {
        return refuse(409, {
          code: "INVOICE_ALREADY_CERTIFIED",
          message: `La facture #${invoice.invoiceNumber} est déjà certifiée par ${existingCert.certificateRef}.`,
          certificateRef: existingCert.certificateRef,
          certificatId: existingCert.id,
          invoiceId: invoice.id,
        });
      }
      supplierRows.push({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        devisId: invoice.devisId,
        mode: "invoice",
        periodClaimHt: Number(invoice.amountHt),
        amountHt: invoice.amountHt,
        tvaAmount: invoice.tvaAmount,
        amountTtc: invoice.amountTtc,
      });
    }

    if (supplierRows.length > 1) {
      const compatibility = checkInvoiceSetTvaCompatibility(supplierRows);
      if (!compatibility.ok) {
        const offender =
          compatibility.offendingIndex != null
            ? supplierRows[compatibility.offendingIndex]
            : null;
        return refuse(409, {
          code: "TVA_MIXED",
          message: offender
            ? `Les factures sélectionnées portent des taux de TVA incompatibles (facture #${offender.invoiceNumber}) — créez des certificats séparés.`
            : "Les factures sélectionnées portent des taux de TVA incompatibles — créez des certificats séparés.",
          invoiceId: offender?.invoiceId,
        });
      }
    }
    const totals = computeSupplierDirectPaymentTotals(supplierRows);
    if (!totals.ok) {
      const offender =
        totals.offendingIndex != null
          ? supplierRows[totals.offendingIndex]
          : null;
      return refuse(409, {
        code:
          totals.reason === "inconsistent_tva"
            ? "SUPPLIER_INVOICE_TVA_INCONSISTENT"
            : "SUPPLIER_INVOICE_AMOUNT_INVALID",
        message: offender
          ? `Les montants HT, TVA et TTC de la facture #${offender.invoiceNumber} sont invalides ou incohérents.`
          : "Les montants HT, TVA et TTC des factures sélectionnées sont invalides ou incohérents.",
        invoiceId: offender?.invoiceId,
      });
    }
    return {
      ok: true,
      derivation: {
        certificateTrack: "supplier_direct_payment",
        contractorId: first.contractorId,
        projectId: first.projectId,
        invoices: supplierRows,
        periodClaimHt: totals.totalWorksHt,
        totalWorksHt: totals.totalWorksHt.toFixed(2),
        previousPayments: "0.00",
        priorCertificateRef: null,
        supplierDirectPayment: {
          readiness,
          tvaRatePercent: totals.effectiveTvaRatePercent.toFixed(2),
          tvaAmount: totals.tvaAmount.toFixed(2),
          netToPayHt: totals.netToPayHt.toFixed(2),
          netToPayTtc: totals.netToPayTtc.toFixed(2),
        },
      },
    };
  }

  const rows: MultiInvoiceCertDerivation["invoices"] = [];
  for (const invoice of loaded) {
    if (invoice.status === "void") {
      return refuse(409, {
        code: "INVOICE_VOID",
        message: `La facture #${invoice.invoiceNumber} est annulée — aucun certificat ne peut être créé.`,
        invoiceId: invoice.id,
      });
    }
    const devis = await storage.getDevis(invoice.devisId);
    if (!devis) {
      return refuse(404, { code: "DEVIS_NOT_FOUND", message: "Devis parent introuvable." });
    }
    if (devis.status === "void" || devis.signOffStage === "void") {
      return refuse(409, {
        code: "DEVIS_VOID",
        message: `Le devis parent de la facture #${invoice.invoiceNumber} est annulé — aucun certificat ne peut être créé depuis cette facture.`,
        invoiceId: invoice.id,
      });
    }
    // The facture d'acompte is paid through the acompte lifecycle (or the
    // no-invoice acompte certificat) — never through a progress certificat.
    if (devis.acompteInvoiceId === invoice.id) {
      return refuse(409, {
        code: "INVOICE_IS_ACOMPTE",
        message: `La facture #${invoice.invoiceNumber} est la facture d'acompte — l'acompte se règle via le cycle acompte du devis, pas par un certificat d'avancement.`,
        invoiceId: invoice.id,
      });
    }
    const existingCert = await liveCertForInvoice(
      invoice.id,
      options.allowCertificatId,
    );
    if (existingCert) {
      return refuse(409, {
        code: "INVOICE_ALREADY_CERTIFIED",
        message: `La facture #${invoice.invoiceNumber} est déjà certifiée par ${existingCert.certificateRef}.`,
        certificateRef: existingCert.certificateRef,
        certificatId: existingCert.id,
        invoiceId: invoice.id,
      });
    }

    // Period claim: Mode B invoices carry a situation whose cumulative/previous
    // figures encode the claim for THAT devis; Mode A invoices claim their own HT.
    const situations = await storage.getSituationsByDevis(invoice.devisId);
    const situation = situations.find((s) => s.invoiceId === invoice.id) ?? null;
    const periodClaimHt = situation
      ? Math.round((parseFloat(situation.cumulativeHt) - parseFloat(situation.previousHt ?? "0")) * 100) / 100
      : Math.round(parseFloat(invoice.amountHt) * 100) / 100;
    if (!Number.isFinite(periodClaimHt) || periodClaimHt <= 0) {
      return refuse(409, {
        code: "INVOICE_NO_CLAIM",
        message: `Le montant réclamé par la facture #${invoice.invoiceNumber} est nul ou invalide.`,
        invoiceId: invoice.id,
      });
    }
    rows.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      devisId: invoice.devisId,
      mode: situation ? "situation" : "invoice",
      periodClaimHt,
      amountHt: invoice.amountHt,
      tvaAmount: invoice.tvaAmount,
      amountTtc: invoice.amountTtc,
    });
  }

  // One certificat carries ONE TVA rate: a mixed-rate selection would misstate
  // the tax of at least one facture. Refused — issue separate certificats.
  if (rows.length > 1) {
    const tva = checkInvoiceSetTvaCompatibility(rows.map((r) => ({ amountHt: r.amountHt, amountTtc: r.amountTtc })));
    if (!tva.ok) {
      const offender = tva.offendingIndex != null ? rows[tva.offendingIndex] : null;
      return refuse(409, {
        code: "TVA_MIXED",
        message: offender
          ? `Les factures sélectionnées portent des taux de TVA incompatibles (facture #${offender.invoiceNumber}) — créez des certificats séparés.`
          : "Les factures sélectionnées portent des taux de TVA incompatibles — créez des certificats séparés.",
        invoiceId: offender?.invoiceId,
      });
    }
  }

  const periodClaimHt = Math.round(rows.reduce((s, r) => s + r.periodClaimHt, 0) * 100) / 100;
  const prior = await latestPriorProgressCert(first.projectId, first.contractorId);
  const totalWorksHt = (prior ? parseFloat(prior.totalWorksHt) : 0) + periodClaimHt;
  // Cumulative prior net = the prior certificat's own previousPayments + its
  // period net (previousPayments is cumulative net certified BEFORE it).
  const previousPayments = prior
    ? parseFloat(prior.previousPayments ?? "0") + parseFloat(prior.netToPayHt ?? "0")
    : 0;

  return {
    ok: true,
    derivation: {
      contractorId: first.contractorId,
      projectId: first.projectId,
      certificateTrack: "contractor_works",
      invoices: rows,
      periodClaimHt,
      totalWorksHt: totalWorksHt.toFixed(2),
      previousPayments: previousPayments.toFixed(2),
      priorCertificateRef: prior?.certificateRef ?? null,
      supplierDirectPayment: null,
    },
  };
}

export class InvoiceStateChangedError extends Error {
  constructor() {
    super("invoice_state_changed");
  }
}
export class DerivationRefusedError extends Error {
  constructor(public refusal: InvoiceCertRefusal) {
    super("derivation_refused");
  }
}

export class SupplierCertificateSourceError extends Error {
  readonly code = "SUPPLIER_CERTIFICATE_SOURCE_SET_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SupplierCertificateSourceError";
  }
}

/**
 * Create ONE draft certificat certifying the given factures.
 *
 * ONE transaction holding the per-(project, contractor) progress-chain
 * advisory lock: two concurrent creations for the SAME contractor serialise
 * here, so the second one re-derives its cumulative/previousPayments AFTER
 * the first has committed — a stale prior chain can never be persisted. The
 * invoice row locks pin each facture's state, and the source-link re-check
 * inside the transaction makes double-certification of one facture
 * impossible.
 *
 * Throws InvoiceStateChangedError / DerivationRefusedError / resolver errors /
 * pg errors — the caller (route) maps them; 23505 ref collisions should be
 * retried by the caller.
 */
export async function createCertificatFromInvoices(
  invoiceIds: number[],
  identity: {
    projectId: number;
    contractorId: number;
    /** Legacy trusted callers omit the track and remain contractor-only. */
    certificateTrack?: CertificateTrack;
  },
): Promise<Certificat> {
  const uniqueIds = Array.from(new Set(invoiceIds)).sort((a, b) => a - b);
  const expectedTrack = identity.certificateTrack ?? "contractor_works";
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${identity.projectId}, ${identity.contractorId})`);
    const [lockedPartner] = await tx
      .select({ archidocPartnerType: contractorsTable.archidocPartnerType })
      .from(contractorsTable)
      .where(eq(contractorsTable.id, identity.contractorId))
      .for("update");
    if (!lockedPartner) throw new InvoiceStateChangedError();
    const currentTrack: CertificateTrack =
      lockedPartner.archidocPartnerType === "supplier"
        ? "supplier_direct_payment"
        : "contractor_works";
    if (currentTrack !== expectedTrack) {
      throw new InvoiceStateChangedError();
    }
    // Ordered FOR UPDATE locks on every facture (deterministic order avoids
    // deadlocks between concurrent overlapping selections).
    const lockedInvoices = await tx
      .select()
      .from(invoicesTable)
      .where(inArray(invoicesTable.id, uniqueIds))
      .orderBy(invoicesTable.id)
      .for("update");
    if (lockedInvoices.length !== uniqueIds.length) throw new InvoiceStateChangedError();
    for (const inv of lockedInvoices) {
      if (
        inv.status === "void" ||
        (expectedTrack === "supplier_direct_payment" &&
          (inv.status !== "approved" || inv.datePaid != null))
      ) {
        throw new InvoiceStateChangedError();
      }
      // The advisory lock was taken for the pre-lock identity — a concurrent
      // reassignment would let the derivation run outside the lock's protection.
      if (inv.projectId !== identity.projectId || inv.contractorId !== identity.contractorId) {
        throw new InvoiceStateChangedError();
      }
    }
    // Pin the parent devis too: a concurrent void / acompte-link commit now
    // blocks until we finish (or is already visible to the re-derivation below).
    const devisIds = Array.from(new Set(lockedInvoices.map((i) => i.devisId))).sort((a, b) => a - b);
    await tx.select({ id: devisTable.id }).from(devisTable).where(inArray(devisTable.id, devisIds)).orderBy(devisTable.id).for("update");

    // TX-SCOPED already-certified re-check: the derivation below reads via
    // the global pool (committed state — sufficient for competitors holding
    // the same advisory lock), but a seal or manual path could have linked a
    // source row without that lock. Read the junction through THIS
    // transaction so the final state we commit against is the one we checked.
    const dupRows = await tx
      .select({ invoiceId: certificatSources.invoiceId, status: certificatsTable.status })
      .from(certificatSources)
      .innerJoin(certificatsTable, eq(certificatSources.certificatId, certificatsTable.id))
      .where(inArray(certificatSources.invoiceId, uniqueIds));
    const dup = dupRows.find((r) => r.status !== "superseded");
    if (dup) {
      throw new DerivationRefusedError({
        status: 409,
        body: {
          code: "INVOICE_ALREADY_CERTIFIED",
          message: "Une des factures sélectionnées est déjà certifiée par un certificat actif.",
          invoiceId: dup.invoiceId ?? undefined,
        },
      });
    }

    // Full re-derivation UNDER the lock (guards + situations + prior chain
    // read committed state; concurrent progress-cert creators hold the same
    // advisory lock, so what we read is final).
    const result = await deriveCertificatFromInvoices(uniqueIds);
    if (!result.ok) throw new DerivationRefusedError(result.refusal);
    const d = result.derivation;
    if (d.certificateTrack !== expectedTrack) {
      throw new InvoiceStateChangedError();
    }
    const deductions =
      d.certificateTrack === "supplier_direct_payment"
        ? {
            retenueGarantie: "0.00",
            cumulativeProrataDeduction: "0.00",
            periodProrataDeduction: "0.00",
            cumulativeAcompteRecoupment: "0.00",
            periodAcompteRecoupment: "0.00",
            tvaRatePercent: d.supplierDirectPayment.tvaRatePercent,
            tvaAutoliquidation: false,
            tvaRateSource: "documentary" as const,
            netToPayHt: d.supplierDirectPayment.netToPayHt,
            tvaAmount: d.supplierDirectPayment.tvaAmount,
            netToPayTtc: d.supplierDirectPayment.netToPayTtc,
            isSolde: false,
            retenueReleased: false,
            retenueReleaseAmount: "0.00",
          }
        : await resolveCertificatDeductions({
            projectId: d.projectId,
            contractorId: d.contractorId,
            totalWorksHt: d.totalWorksHt,
            pvMvAdjustment: "0.00",
            previousPayments: d.previousPayments,
            // Documentary TVA must reflect the certified documents only.
            documentaryBasisInvoices: d.invoices.map((r) => ({
              amountHt: r.amountHt,
              amountTtc: r.amountTtc,
            })),
          });

    const nextRef = await storage.getNextCertificateRef(d.projectId);
    const invoiceNumbers = d.invoices.map((r) => `#${r.invoiceNumber}`).join(", ");
    const [created] = await tx
      .insert(certificatsTable)
      .values({
        projectId: d.projectId,
        contractorId: d.contractorId,
        certificateTrack: d.certificateTrack,
        certificateRef: nextRef,
        dateIssued: new Date().toISOString().split("T")[0],
        totalWorksHt: d.totalWorksHt,
        pvMvAdjustment: "0.00",
        previousPayments: d.previousPayments,
        status: "draft",
        notes:
          d.certificateTrack === "supplier_direct_payment"
            ? d.invoices.length === 1
              ? `Paiement direct fournisseur créé depuis la facture ${invoiceNumbers}.`
              : `Paiement direct fournisseur créé depuis les factures ${invoiceNumbers}.`
            : d.invoices.length === 1
              ? `Créé depuis la facture ${invoiceNumbers}.`
              : `Créé depuis les factures ${invoiceNumbers}.`,
        ...deductions,
      })
      .returning();
    // STRICT insert — a freshly created certificat can have no pre-existing
    // source rows, so a conflict or a short count means something is wrong:
    // fail the whole transaction rather than commit a partial source set.
    const inserted = await tx
      .insert(certificatSources)
      .values(d.invoices.map((r) => ({ certificatId: created.id, invoiceId: r.invoiceId, situationId: null })))
      .returning({ id: certificatSources.id });
    if (inserted.length !== d.invoices.length) {
      throw new Error(
        `certificat_sources insert wrote ${inserted.length}/${d.invoices.length} rows for certificat ${created.id}`,
      );
    }
    return created;
  });
}
