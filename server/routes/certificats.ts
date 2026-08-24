import { Router } from "express";
import { z } from "zod";
import { storage, CertificatSourceConflictError } from "../storage";
import {
  insertCertificatSchema,
  type Certificat,
  type InsertCertificat,
  type ServerInsertCertificat,
} from "@shared/schema";
import {
  generateCertificatPdf,
  BankingDetailsMissingError,
  BankingMismatchError,
  type SupplierDirectPaymentPresentation,
} from "../communications/certificat-generator";
import { sendCertificat, sendCommunication, CommunicationSendInProgressError } from "../communications/email-sender";
import { validateRequest } from "../middleware/validate";
import {
  resolveCertificatDeductions,
  SoldeConflictError,
  ReleaseRequiresSoldeError,
} from "../services/certificat-deductions.service";
import { PvReceptionRequiredError, isPvReceptionApproved } from "../services/pv-reception.service";
import { getDocumentBuffer } from "../storage/object-storage";
import { reconcilePayments } from "../services/certificat-payments.service";
import { db } from "../db";
import { certificats as certificatsTable, certificatSources } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  deriveCertificatFromInvoices,
  createCertificatFromInvoices,
  InvoiceStateChangedError,
  DerivationRefusedError,
  SupplierCertificateSourceError,
} from "../services/certificat-from-invoices.service";
import {
  assertSupplierPaymentReadiness,
  SupplierPaymentReadinessError,
} from "../services/supplier-payment-readiness.service";
import type { CertificateTrack } from "@shared/supplier-payment-readiness";
import {
  assertSupplierCertificateDispatchValid,
  SupplierCertificateDispatchError,
} from "../services/supplier-certificate-dispatch.service";
import {
  isSupplierDirectPaymentAllowedForProject,
  SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED,
} from "../services/supplier-certificate-rollout.service";

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
// Drizzle/node-postgres may wrap query failures, leaving the PostgreSQL
// metadata (SQLSTATE `code`, `constraint`) on the error's `cause` chain.
// Walk the chain so unique-violation branching never misses a wrapped error.
function pgErrorInfo(err: unknown): { code?: string; constraint?: string } {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const { code, constraint } = current as { code?: string; constraint?: string };
    if (code) return { code, constraint };
    current = (current as { cause?: unknown }).cause;
  }
  return {};
}

function publicCertificatDto(cert: Certificat) {
  const { issuanceSnapshot: _privateIssuanceSnapshot, ...publicFields } =
    cert;
  const supplierPresentation =
    cert.certificateTrack === "supplier_direct_payment" &&
    cert.issuanceSnapshot &&
    typeof cert.issuanceSnapshot === "object"
      ? (
          cert.issuanceSnapshot as {
            supplierDirectPayment?: {
              presentation?: SupplierDirectPaymentPresentation | null;
            };
          }
        ).supplierDirectPayment?.presentation ?? null
      : null;
  return { ...publicFields, supplierPresentation };
}

const deductionOverrideShape = {
  retenueOverride: z.string().optional(),
  prorataOverride: z.string().optional(),
  // Task #463 — draft-only override of the applied TVA rate (%). Strict
  // scale-2 decimal 0–100; ignored by the resolver on autoliquidation
  // contracts (the 0% rate is a legal consequence, not a preference).
  tvaRateOverride: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, "TVA rate must be a decimal with at most 2 decimal places")
    .refine((v) => { const n = parseFloat(v); return n >= 0 && n <= 100; }, {
      message: "TVA rate must be between 0 and 100",
    })
    .optional(),
  // Task #464 — explicit retenue de garantie release on the solde
  // certificat. NOT columns: the handler feeds `releaseRetenue` to the
  // resolver (which derives the released state + amount) and stamps the
  // audit reason/date itself. A release REQUIRES a reason.
  releaseRetenue: z.boolean().optional(),
  releaseReason: z.string().trim().min(1).max(500).optional(),
  // Task #464 — solde designation. Routed through the resolver (single
  // non-superseded solde per project+contractor), never written raw.
  isSolde: z.boolean().optional(),
  // Task #566 — audited override of the PV de réception gate (legacy
  // projects). Reason is architect-provided; who/when are server-stamped.
  pvOverrideReason: z.string().trim().min(1).max(500).optional(),
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
  // Task #462 — acompte recoupment amounts are computed from the devis'
  // paid-deposit state + the marché rule; never client-settable.
  cumulativeAcompteRecoupment: true,
  periodAcompteRecoupment: true,
  // Task #463 — the applied TVA rate + autoliquidation flag are resolved
  // from the marché/contractor regime (or the validated tvaRateOverride);
  // the raw columns are never client-settable.
  tvaRatePercent: true,
  tvaAutoliquidation: true,
  // Task #479 — the rate's provenance is derived alongside the rate itself.
  tvaRateSource: true,
  // Task #464 — solde/release state is server-derived: `isSolde` comes back
  // from the resolver (which enforces the single-solde rule) and the release
  // fields are derived from the validated `releaseRetenue`/`releaseReason`
  // request fields, never accepted as raw columns.
  isSolde: true,
  retenueReleased: true,
  retenueReleaseAmount: true,
  retenueReleaseReason: true,
  retenueReleaseDate: true,
  // Task #566 — PV-gate override audit trail: reason arrives through the
  // validated request field above, who/when are server-stamped. The raw
  // columns are never client-settable.
  pvOverrideReason: true,
  pvOverrideByUserId: true,
  pvOverrideAt: true,
  netToPayHt: true,
  tvaAmount: true,
  netToPayTtc: true,
} as const;

// Task #457 — closed lifecycle vocabulary for client-settable statuses.
// `superseded` is terminal and written ONLY by the atomic reissue
// transaction, never accepted from a request body.
const clientSettableStatus = z.enum(["draft", "ready", "sent", "paid"]);

// Task #464 — map the resolver's typed solde-precondition errors onto
// friendly HTTP responses (shared by create + PATCH).
function mapSoldeError(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof SoldeConflictError) {
    return { status: 409, body: { code: "SOLDE_ALREADY_EXISTS", message: err.message } };
  }
  if (err instanceof ReleaseRequiresSoldeError) {
    return { status: 422, body: { code: "RELEASE_REQUIRES_SOLDE", message: err.message } };
  }
  // Task #566 — final payment gated on the approved PV de réception.
  if (err instanceof PvReceptionRequiredError) {
    return {
      status: 422,
      body: { code: "PV_RECEPTION_REQUIRED", message: err.message, marcheId: err.marcheId, pvStatus: err.pvStatus },
    };
  }
  return null;
}

const createCertificatBodySchema = insertCertificatSchema
  .omit({ projectId: true, certificateRef: true, ...serverDerivedDeductionFields })
  .extend({ ...deductionOverrideShape, status: clientSettableStatus.default("draft") });
const updateCertificatSchema = insertCertificatSchema
  .omit(serverDerivedDeductionFields)
  .partial()
  .extend({ ...deductionOverrideShape, status: clientSettableStatus.optional() });

// Task #539 — cross-project list of ready-but-unsent certificats feeding the
// dashboard "Awaiting certificat send" alert and the per-devis certificat
// section. "Unsent" is defined ONCE server-side (storage), never inferred
// client-side.
router.get("/api/certificats/unsent", async (_req, res) => {
  const rows = await storage.getUnsentReadyCertificats();
  res.json(rows);
});

router.get("/api/projects/:projectId/certificats", async (req, res) => {
  const certs = await storage.getCertificatsByProject(Number(req.params.projectId));
  // Task #556 — enrich each certificat with its sent-email evidence so the UI
  // can display "Sent to <email> on <date>" without a separate request.
  const sentComms = await storage.getCertificatSentComms(certs.map((c) => c.id));
  const enriched = certs.map((c) => {
    const sent = sentComms.get(c.id);
    return sent
      ? { ...publicCertificatDto(c), sentAt: sent.sentAt.toISOString(), sentToEmail: sent.recipientEmail }
      : publicCertificatDto(c);
  });
  res.json(enriched);
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
    const { retenueOverride, prorataOverride, tvaRateOverride, releaseRetenue, releaseReason, isSolde, pvOverrideReason, ...body } = req.body as
      Omit<InsertCertificat, "projectId" | "certificateRef"> & {
        retenueOverride?: string;
        prorataOverride?: string;
        tvaRateOverride?: string;
        releaseRetenue?: boolean;
        releaseReason?: string;
        isSolde?: boolean;
        pvOverrideReason?: string;
      };

    // Task #464 — a release without a reason has no audit trail.
    if (releaseRetenue === true && !releaseReason) {
      return res.status(400).json({
        code: "RELEASE_REASON_REQUIRED",
        message: "Une raison est requise pour libérer la retenue de garantie.",
      });
    }

    // Task #243 — the server is authoritative for deduction money math.
    // Recompute Retenue de Garantie + Compte Prorata cumulatively from the
    // contract, overriding whatever the FE sent for the derived fields.
    let deductions;
    try {
      const partner = await storage.getContractor(body.contractorId);
      if (partner?.archidocPartnerType === "supplier") {
        return res.status(409).json({
          code: "SUPPLIER_CERTIFICATE_REQUIRES_INVOICE_SOURCES",
          message:
            "Un paiement direct fournisseur doit être créé depuis une ou plusieurs factures approuvées. La création manuelle sans sources est interdite.",
        });
      }
      deductions = await resolveCertificatDeductions({
        projectId,
        contractorId: body.contractorId,
        totalWorksHt: body.totalWorksHt,
        pvMvAdjustment: body.pvMvAdjustment,
        previousPayments: body.previousPayments,
        retenueOverride,
        prorataOverride,
        tvaRateOverride,
        isSolde,
        releaseRetenue,
        // Task #566 — a motivated override reason satisfies the PV gate.
        pvOverride: pvOverrideReason != null,
      });
    } catch (err) {
      const mapped = mapSoldeError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }

    // Task #566 — PV-gate override audit trail: recorded only on a solde
    // certificat with an architect-provided reason (who/when server-set).
    const pvAudit = deductions.isSolde && pvOverrideReason
      ? { pvOverrideReason, pvOverrideByUserId: req.session.userId ?? null, pvOverrideAt: new Date() }
      : { pvOverrideReason: null, pvOverrideByUserId: null, pvOverrideAt: null };

    // Task #464 — release audit trail (reason architect-provided, date
    // server-stamped) recorded only when the resolver confirmed the release.
    const releaseAudit = deductions.retenueReleased
      ? { retenueReleaseReason: releaseReason ?? null, retenueReleaseDate: new Date().toISOString().split("T")[0] }
      : { retenueReleaseReason: null, retenueReleaseDate: null };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nextRef = await storage.getNextCertificateRef(projectId);
        const cert = await storage.createCertificat({ ...body, ...deductions, ...releaseAudit, ...pvAudit, projectId, certificateRef: nextRef });
        return res.status(201).json(publicCertificatDto(cert));
      } catch (err) {
        const { code, constraint } = pgErrorInfo(err);
        if (code === "23505" && constraint === "certificats_solde_unique") {
          return res.status(409).json({
            code: "SOLDE_ALREADY_EXISTS",
            message: "Un certificat de solde existe déjà pour cette entreprise — un seul certificat de solde par marché.",
          });
        }
        if (code === "23505" && attempt < 2) continue;
        throw err;
      }
    }
  },
);

// Task #457 — one-click reissue of a sealed certificat. Clones the sealed
// row into a NEW draft (next certificateRef, financial inputs pre-filled,
// deductions recomputed excluding the superseded original), marks the old
// certificat `superseded`, and records the lineage in
// `reissuedFromCertificatId`. The partial unique index on that column makes
// double-reissue race-free: a concurrent second click loses at INSERT time.
router.post(
  "/api/certificats/:id/reissue",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const id = Number(req.params.id);
    const existing = await storage.getCertificat(id);
    if (!existing) return res.status(404).json({ message: "Certificat not found" });
    if (!existing.pdfStorageKey) {
      return res.status(409).json({
        code: "CERTIFICAT_NOT_SEALED",
        message: `Certificat ${existing.certificateRef} is still a draft — edit it directly instead of reissuing.`,
      });
    }
    const [priorReissue] = await storage.getCertificatReissues([id]);
    if (priorReissue) {
      return res.status(409).json({
        code: "CERTIFICAT_ALREADY_REISSUED",
        message: `Certificat ${existing.certificateRef} was already reissued as ${priorReissue.certificateRef}.`,
        reissueCertificatId: priorReissue.id,
      });
    }

    // Recompute the server-authoritative deductions from the cloned inputs,
    // EXCLUDING the superseded original from the prior set: the reissue
    // replaces it, so its cumulative figures must not feed the new draft.
    // Task #464 — the clone carries the original's solde designation and
    // release state (the reissue flow is precisely how a sealed release
    // decision gets corrected: the clone is a draft again). Excluding the
    // original from the prior set keeps the single-solde check happy.
    // Task #491 — ACOMPTE certificats sit outside the progress waterfall:
    // their money is fixed from the devis's acompte spec (zero deductions)
    // and must never be re-resolved through the cumulative engine. The
    // clone carries the original's figures and its acompteDevisId link so
    // the partial unique index (non-superseded only) keeps one live
    // acompte certificat per devis — the original is superseded in the
    // same transaction, so the insert never trips it.
    const isAcompteCert = existing.acompteDevisId != null;
    let supplierDerivation:
      | Extract<
          Awaited<ReturnType<typeof deriveCertificatFromInvoices>>,
          { ok: true }
        >["derivation"]
      | null = null;
    if (existing.certificateTrack === "supplier_direct_payment") {
      const sourceRows = await storage.getCertificatSources(existing.id);
      const sourceInvoiceIds = Array.from(
        new Set(
          sourceRows
            .map((source) => source.invoiceId)
            .filter((invoiceId): invoiceId is number => invoiceId != null),
        ),
      );
      if (
        sourceInvoiceIds.length === 0 ||
        sourceRows.some(
          (source) => source.situationId != null || source.invoiceId == null,
        )
      ) {
        return res.status(409).json({
          code: "SUPPLIER_CERTIFICATE_SOURCE_SET_INVALID",
          message:
            "Le certificat fournisseur ne possède pas un ensemble de sources facture-only valide et ne peut pas être réémis.",
        });
      }
      const result = await deriveCertificatFromInvoices(sourceInvoiceIds, {
        allowCertificatId: existing.id,
      });
      if (!result.ok) {
        return res.status(result.refusal.status).json(result.refusal.body);
      }
      if (result.derivation.certificateTrack !== "supplier_direct_payment") {
        return res.status(409).json({
          code: "SUPPLIER_CERTIFICATE_PARTNER_CHANGED",
          message:
            "L'intervenant n'est plus classé comme fournisseur dans ArchiDoc. La réémission est bloquée.",
        });
      }
      supplierDerivation = result.derivation;
    }
    const isFixedCert =
      isAcompteCert ||
      existing.certificateTrack === "supplier_direct_payment";
    const deductions = isFixedCert
      ? {
          retenueGarantie: "0.00",
          cumulativeProrataDeduction: "0.00",
          periodProrataDeduction: "0.00",
          cumulativeAcompteRecoupment: "0.00",
          periodAcompteRecoupment: "0.00",
          tvaRatePercent:
            supplierDerivation?.supplierDirectPayment?.tvaRatePercent ??
            existing.tvaRatePercent,
          tvaAutoliquidation:
            existing.certificateTrack === "supplier_direct_payment"
              ? false
              : existing.tvaAutoliquidation,
          tvaRateSource:
            existing.certificateTrack === "supplier_direct_payment"
              ? ("documentary" as const)
              : existing.tvaRateSource,
          netToPayHt:
            supplierDerivation?.supplierDirectPayment?.netToPayHt ??
            existing.netToPayHt,
          tvaAmount:
            supplierDerivation?.supplierDirectPayment?.tvaAmount ??
            existing.tvaAmount,
          netToPayTtc:
            supplierDerivation?.supplierDirectPayment?.netToPayTtc ??
            existing.netToPayTtc,
          isSolde:
            existing.certificateTrack === "supplier_direct_payment"
              ? false
              : existing.isSolde,
          retenueReleased: false,
          retenueReleaseAmount: "0.00",
        }
      : await resolveCertificatDeductions({
          projectId: existing.projectId,
          contractorId: existing.contractorId,
          totalWorksHt: existing.totalWorksHt,
          pvMvAdjustment: existing.pvMvAdjustment,
          previousPayments: existing.previousPayments,
          isSolde: existing.isSolde,
          releaseRetenue: existing.retenueReleased,
          // Task #566 — the clone inherits the original's recorded PV-gate
          // override so a legitimate legacy reissue is not re-blocked.
          pvOverride: existing.pvOverrideReason != null,
          excludeCertificatId: id,
        });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nextRef = await storage.getNextCertificateRef(existing.projectId);
        // Atomic paired transition: insert the draft AND mark the original
        // superseded in one transaction (storage.reissueCertificat) — a
        // failure on either write rolls back both, so the chain can never
        // hold a committed replacement next to a still-active original.
        const draft = await storage.reissueCertificat(id, {
          projectId: existing.projectId,
          contractorId: existing.contractorId,
          certificateTrack: existing.certificateTrack,
          certificateRef: nextRef,
          dateIssued: null,
          totalWorksHt:
            supplierDerivation?.totalWorksHt ?? existing.totalWorksHt,
          pvMvAdjustment:
            existing.certificateTrack === "supplier_direct_payment"
              ? "0.00"
              : existing.pvMvAdjustment,
          previousPayments:
            existing.certificateTrack === "supplier_direct_payment"
              ? "0.00"
              : existing.previousPayments,
          ...deductions,
          retenueReleaseReason: existing.retenueReleaseReason,
          retenueReleaseDate: existing.retenueReleaseDate,
          // Task #566 — carry the PV-gate override audit onto the clone.
          pvOverrideReason: existing.pvOverrideReason,
          pvOverrideByUserId: existing.pvOverrideByUserId,
          pvOverrideAt: existing.pvOverrideAt,
          status: "draft",
          notes: `Reissue of ${existing.certificateRef}${existing.notes ? ` — ${existing.notes}` : ""}`,
          reissuedFromCertificatId: id,
          // Task #491 — preserve the acompte link so the clone stays outside
          // the waterfall (and the one-live-acompte-per-devis index holds).
          acompteDevisId: existing.acompteDevisId,
        } as ServerInsertCertificat & { reissuedFromCertificatId: number });
        return res.status(201).json(draft);
      } catch (err) {
        const { code, constraint } = pgErrorInfo(err);
        if (code === "23505" && constraint === "certificats_reissued_from_unique") {
          const [winner] = await storage.getCertificatReissues([id]);
          return res.status(409).json({
            code: "CERTIFICAT_ALREADY_REISSUED",
            message: `Certificat ${existing.certificateRef} was already reissued${winner ? ` as ${winner.certificateRef}` : ""}.`,
            reissueCertificatId: winner?.id,
          });
        }
        if (code === "23505" && attempt < 2) continue; // ref collision — retry with a fresh ref
        throw err;
      }
    }
  },
);

router.get("/api/certificats/:id", async (req, res) => {
  const cert = await storage.getCertificat(Number(req.params.id));
  if (!cert) return res.status(404).json({ message: "Certificat not found" });
  // Task #556 — include sent-email evidence on single-cert detail too.
  const sentComms = await storage.getCertificatSentComms([cert.id]);
  const sent = sentComms.get(cert.id);
  if (sent) {
    return res.json({ ...publicCertificatDto(cert), sentAt: sent.sentAt.toISOString(), sentToEmail: sent.recipientEmail });
  }
  res.json(publicCertificatDto(cert));
});

router.patch(
  "/api/certificats/:id",
  validateRequest({ params: idParams, body: updateCertificatSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const { retenueOverride, prorataOverride, tvaRateOverride, releaseRetenue, releaseReason, isSolde, pvOverrideReason, ...body } = req.body as
      Partial<InsertCertificat> & {
        retenueOverride?: string;
        prorataOverride?: string;
        tvaRateOverride?: string;
        releaseRetenue?: boolean;
        releaseReason?: string;
        isSolde?: boolean;
        pvOverrideReason?: string;
      };

    const existing = await storage.getCertificat(id);
    if (!existing) return res.status(404).json({ message: "Certificat not found" });

    if (existing.certificateTrack === "supplier_direct_payment") {
      const allowedOnSupplier = new Set(["status", "notes"]);
      const blocked = Object.keys(body).filter(
        (key) => !allowedOnSupplier.has(key),
      );
      if (
        blocked.length > 0 ||
        retenueOverride !== undefined ||
        prorataOverride !== undefined ||
        tvaRateOverride !== undefined ||
        releaseRetenue !== undefined ||
        releaseReason !== undefined ||
        isSolde !== undefined ||
        pvOverrideReason !== undefined
      ) {
        return res.status(409).json({
          code: "SUPPLIER_CERTIFICATE_FIXED",
          message:
            "Les montants et les sources d'un paiement direct fournisseur sont dérivés des factures approuvées et ne peuvent pas être modifiés manuellement. Utilisez la réémission pour corriger le document.",
          blockedFields: blocked,
        });
      }
    }

    if (
      body.contractorId != null &&
      existing.certificateTrack === "contractor_works"
    ) {
      const newPartner = await storage.getContractor(body.contractorId);
      if (newPartner?.archidocPartnerType === "supplier") {
        return res.status(409).json({
          code: "CERTIFICATE_TRACK_IMMUTABLE",
          message:
            "Un certificat de travaux ne peut pas être transformé en paiement direct fournisseur.",
        });
      }
    }

    // Task #457 — `superseded` is TERMINAL and server-set only (written
    // exclusively by the atomic reissue transaction). A superseded certificat
    // must never be reactivated — its replacement already exists — and no
    // PATCH may move a certificat into or out of that state directly.
    if ("status" in body && existing.status === "superseded") {
      return res.status(409).json({
        code: "CERTIFICAT_SUPERSEDED",
        message: `Certificat ${existing.certificateRef} was superseded by a reissue and can no longer change status.`,
      });
    }

    // Task #465 — a sealed certificat is a payment instruction: its `paid`
    // status must be BACKED by the payment ledger. Manual status flips to
    // paid are refused unless the cumulative logged payments cover the TTC
    // total (the ledger's auto-flip is the normal path). Unsealed drafts and
    // already-paid rows (grandfathered status-only paids) are unaffected.
    if (body.status === "paid" && existing.pdfStorageKey && existing.status !== "paid") {
      const payments = await storage.getCertificatPayments(id);
      const paymentState = reconcilePayments(existing, payments);
      if (!paymentState.fullyPaid) {
        return res.status(409).json({
          code: "PAYMENTS_INCOMPLETE",
          message: `Certificat ${existing.certificateRef} ne peut pas être marqué payé : ${paymentState.paidToDate.toFixed(2)} € enregistrés sur ${parseFloat(existing.netToPayTtc).toFixed(2)} € TTC. Enregistrez les paiements reçus — le statut basculera automatiquement.`,
          paidToDate: paymentState.paidToDate,
          outstanding: paymentState.outstanding,
        });
      }
    }

    // Task #451 — issuance seal. Once a certificat carries a pinned PDF it is
    // an issued payment instruction: financial/source fields are locked and
    // corrections require a reissue (a new certificat). Only lifecycle fields
    // (status, notes) remain patchable. Belt-and-braces: `delete` the seal
    // columns from the body even though the Zod schema already omits them.
    delete (body as Record<string, unknown>).pdfStorageKey;
    delete (body as Record<string, unknown>).pdfFileName;
    delete (body as Record<string, unknown>).issuedAt;
    delete (body as Record<string, unknown>).issuanceSnapshot;
    // Task #457 — reissue lineage is server-set only, never patchable.
    delete (body as Record<string, unknown>).reissuedFromCertificatId;
    if (existing.pdfStorageKey) {
      const allowedOnSealed = new Set(["status", "notes"]);
      const blocked = Object.keys(body).filter((k) => !allowedOnSealed.has(k));
      // Task #464 — the solde designation and the retenue release state are
      // frozen by the seal too; changing them post-issuance requires reissue.
      if (
        blocked.length > 0 ||
        retenueOverride !== undefined ||
        prorataOverride !== undefined ||
        tvaRateOverride !== undefined ||
        releaseRetenue !== undefined ||
        releaseReason !== undefined ||
        isSolde !== undefined ||
        pvOverrideReason !== undefined
      ) {
        return res.status(409).json({
          code: "CERTIFICAT_SEALED",
          message: `Certificat ${existing.certificateRef} has been issued and is sealed. Corrections require issuing a new certificat.`,
          blockedFields: blocked,
        });
      }
    }

    // Task #491 — an ACOMPTE certificat's money is fixed from the signed
    // devis's deposit spec (zero deductions, outside the waterfall) and the
    // seal deliberately never re-resolves it. Letting the generic PATCH
    // touch its financial inputs would route them through the waterfall
    // resolver and seal the corrupted figures. Only lifecycle fields
    // (status, notes) are patchable; corrections go through reissue.
    if (existing.acompteDevisId != null) {
      const allowedOnAcompte = new Set(["status", "notes"]);
      const blocked = Object.keys(body).filter((k) => !allowedOnAcompte.has(k));
      if (
        blocked.length > 0 ||
        retenueOverride !== undefined ||
        prorataOverride !== undefined ||
        tvaRateOverride !== undefined ||
        releaseRetenue !== undefined ||
        releaseReason !== undefined ||
        isSolde !== undefined ||
        pvOverrideReason !== undefined
      ) {
        return res.status(409).json({
          code: "CERTIFICAT_ACOMPTE_FIXED",
          message: `Certificat ${existing.certificateRef} is an acompte certificat: its amounts are fixed from the signed devis's deposit. Corrections require a reissue.`,
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
      prorataOverride !== undefined ||
      tvaRateOverride !== undefined ||
      // Task #464 — solde/release changes move money (the release line) and
      // must run through the resolver's precondition checks.
      releaseRetenue !== undefined ||
      isSolde !== undefined ||
      // Task #566 — a new PV-gate override must run through the resolver so
      // the gate re-evaluates with it.
      pvOverrideReason !== undefined;

    // Task #464 — effective solde/release state after this PATCH: an
    // explicit request field wins, otherwise the stored state is preserved
    // through recomputes. Turning the solde flag off implicitly cancels any
    // release (release only exists on the solde certificat).
    const effectiveIsSolde = isSolde ?? existing.isSolde;
    const effectiveRelease = effectiveIsSolde ? (releaseRetenue ?? existing.retenueReleased) : false;
    // Task #566 — PV-gate override effective after this PATCH: a request
    // reason wins, otherwise the recorded one persists; dropping the solde
    // flag clears it (the gate only exists on the solde certificat).
    const effectivePvOverrideReason = effectiveIsSolde ? (pvOverrideReason ?? existing.pvOverrideReason) : null;
    if (releaseRetenue === true && !(releaseReason ?? existing.retenueReleaseReason)) {
      return res.status(400).json({
        code: "RELEASE_REASON_REQUIRED",
        message: "Une raison est requise pour libérer la retenue de garantie.",
      });
    }

    let patch: Partial<InsertCertificat> = body;
    if (touchesFinancials) {
      let deductions;
      try {
        deductions = await resolveCertificatDeductions({
          projectId: existing.projectId,
          contractorId: body.contractorId ?? existing.contractorId,
          totalWorksHt: body.totalWorksHt ?? existing.totalWorksHt,
          pvMvAdjustment: body.pvMvAdjustment ?? existing.pvMvAdjustment,
          previousPayments: body.previousPayments ?? existing.previousPayments,
          retenueOverride,
          prorataOverride,
          tvaRateOverride,
          isSolde: effectiveIsSolde,
          releaseRetenue: effectiveRelease,
          pvOverride: effectivePvOverrideReason != null,
          excludeCertificatId: id,
        });
      } catch (err) {
        const mapped = mapSoldeError(err);
        if (mapped) return res.status(mapped.status).json(mapped.body);
        throw err;
      }
      // Release audit trail follows the resolved release state.
      const releaseAudit = deductions.retenueReleased
        ? {
            retenueReleaseReason: releaseReason ?? existing.retenueReleaseReason,
            retenueReleaseDate: existing.retenueReleased
              ? existing.retenueReleaseDate
              : new Date().toISOString().split("T")[0],
          }
        : { retenueReleaseReason: null, retenueReleaseDate: null };
      // Task #566 — PV-gate override audit: a newly provided reason stamps
      // who/when; an inherited one keeps its original stamps; a non-solde
      // result clears all three.
      const pvAudit = !deductions.isSolde
        ? { pvOverrideReason: null, pvOverrideByUserId: null, pvOverrideAt: null }
        : pvOverrideReason != null && pvOverrideReason !== existing.pvOverrideReason
          ? { pvOverrideReason, pvOverrideByUserId: req.session.userId ?? null, pvOverrideAt: new Date() }
          : {};
      patch = { ...body, ...deductions, ...releaseAudit, ...pvAudit };
    }

    // Task #451 — status/notes-only patches remain allowed on sealed rows;
    // anything touching financial/source inputs goes through the GUARDED
    // update (WHERE pdf_storage_key IS NULL) so a PATCH authorized against
    // an unsealed row can never commit after a concurrent seal.
    const onlyLifecycleFields = Object.keys(patch).every((k) => k === "status" || k === "notes");
    if (
      onlyLifecycleFields &&
      retenueOverride === undefined &&
      prorataOverride === undefined &&
      tvaRateOverride === undefined &&
      releaseRetenue === undefined &&
      isSolde === undefined &&
      pvOverrideReason === undefined
    ) {
      const cert = await storage.updateCertificat(id, patch);
      if (!cert) return res.status(404).json({ message: "Certificat not found" });
      return res.json(publicCertificatDto(cert));
    }
    let cert;
    try {
      cert = await storage.updateCertificatUnsealed(id, patch);
    } catch (err) {
      // Task #464 — single-solde race: two concurrent PATCHes can both pass
      // the resolver's friendly check; the partial unique index elects the
      // winner and the loser gets a friendly 409 instead of a 500.
      const { code, constraint } = pgErrorInfo(err);
      if (code === "23505" && constraint === "certificats_solde_unique") {
        return res.status(409).json({
          code: "SOLDE_ALREADY_EXISTS",
          message: "Un certificat de solde existe déjà pour cette entreprise — un seul certificat de solde par marché.",
        });
      }
      throw err;
    }
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
    res.json(publicCertificatDto(cert));
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
        const fallbackFileName =
          cert.certificateTrack === "supplier_direct_payment"
            ? `Certificat_Paiement_Direct_Fournisseur_${cert.certificateRef}.pdf`
            : `Certificat_${cert.certificateRef}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${cert.pdfFileName || fallbackFileName}"`);
        return res.send(pinned);
      }
      if (cert.certificateTrack === "supplier_direct_payment") {
        const project = await storage.getProject(cert.projectId);
        if (
          !project?.archidocId ||
          !isSupplierDirectPaymentAllowedForProject(project.archidocId)
        ) {
          return res.status(409).json({
            code: SUPPLIER_DIRECT_PAYMENT_ROLLOUT_BLOCKED,
            message:
              "Le paiement direct fournisseur n'est pas encore activé pour ce projet. Aucun nouvel aperçu de certificat fournisseur ne peut être généré.",
          });
        }
      }
      const { pdfBuffer } = await generateCertificatPdf(certId, { mode: "preview" });
      const previewFileName =
        cert.certificateTrack === "supplier_direct_payment"
          ? `Certificat_Paiement_Direct_Fournisseur_${cert.certificateRef}.pdf`
          : `Certificat_${cert.certificateRef}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${previewFileName}"`);
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
      if (err instanceof SupplierPaymentReadinessError) {
        return res.status(422).json({
          code: err.code,
          message:
            "Le paiement direct fournisseur est bloqué : les données de préparation au paiement ArchiDoc sont absentes, incomplètes ou ne sont plus valides.",
          blockers: err.blockers,
        });
      }
      if (err instanceof SupplierCertificateSourceError) {
        return res.status(409).json({
          code: err.code,
          message: err.message,
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
      const fallbackFileName =
        cert.certificateTrack === "supplier_direct_payment"
          ? `Certificat_Paiement_Direct_Fournisseur_${cert.certificateRef}.pdf`
          : `Certificat_${cert.certificateRef}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${cert.pdfFileName || fallbackFileName}"`);
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
    const sources = await storage.getCertificatSources(cert.id);
    const frozenSupplierInvoices =
      cert.certificateTrack === "supplier_direct_payment" &&
      cert.issuanceSnapshot &&
      typeof cert.issuanceSnapshot === "object"
        ? (
            cert.issuanceSnapshot as {
              supplierDirectPayment?: {
                sources?: {
                  invoices?: Array<{
                    invoiceId: number;
                    invoiceNumber: string;
                    invoiceDate: string | null;
                    amountHt: string;
                    tvaAmount: string;
                    amountTtc: string;
                  }>;
                };
              };
            }
          ).supplierDirectPayment?.sources?.invoices ?? []
        : [];
    const frozenByInvoiceId = new Map(
      frozenSupplierInvoices.map((invoice) => [invoice.invoiceId, invoice]),
    );
    const enriched = await Promise.all(
      sources.map(async (source) => {
        if (source.invoiceId == null) return { ...source, invoice: null };
        const frozen = frozenByInvoiceId.get(source.invoiceId);
        if (frozen) {
          return {
            ...source,
            invoice: {
              id: frozen.invoiceId,
              invoiceNumber: frozen.invoiceNumber,
              dateIssued: frozen.invoiceDate,
              amountHt: frozen.amountHt,
              tvaAmount: frozen.tvaAmount,
              amountTtc: frozen.amountTtc,
            },
          };
        }
        const invoice = await storage.getInvoice(source.invoiceId);
        return {
          ...source,
          invoice: invoice
            ? {
                id: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                dateIssued: invoice.dateIssued,
                amountHt: invoice.amountHt,
                tvaAmount: invoice.tvaAmount,
                amountTtc: invoice.amountTtc,
              }
            : null,
        };
      }),
    );
    res.json(enriched);
  },
);

// ─── Task #496 — one-click certificat from a contractor invoice ────────────
//
// The certificat is, in practice, the payment authorization for the
// contractor's facture. Instead of re-typing the cumulative figures in the
// manual dialog, the operator launches creation FROM the invoice: the server
// derives every input (cumulative works from the invoice's claim, previous
// payments from the prior certificat chain), resolves all deductions, and the
// FE shows them read-only for verification. The invoice→certificat link is
// recorded in `certificat_sources` at creation (the seal's own linking pass
// uses onConflictDoNothing, so no duplicate rows).

// Derivation + creation now live in the shared multi-facture service
// (server/services/certificat-from-invoices.service.ts); the single-invoice
// endpoints below are thin wrappers over the N-invoice versions.

async function buildPreviewPayload(invoiceIds: number[], res: import("express").Response) {
  const result = await deriveCertificatFromInvoices(invoiceIds);
  if (!result.ok) return res.status(result.refusal.status).json(result.refusal.body);
  const d = result.derivation;
  const supplierReadiness =
    d.certificateTrack === "supplier_direct_payment"
      ? d.supplierDirectPayment.readiness
      : null;
  let deductions;
  if (d.certificateTrack === "supplier_direct_payment") {
    deductions = {
      retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00",
      periodProrataDeduction: "0.00",
      cumulativeAcompteRecoupment: "0.00",
      periodAcompteRecoupment: "0.00",
      tvaRatePercent: d.supplierDirectPayment.tvaRatePercent,
      tvaAutoliquidation: false,
      tvaRateSource: "documentary",
      netToPayHt: d.supplierDirectPayment.netToPayHt,
      tvaAmount: d.supplierDirectPayment.tvaAmount,
      netToPayTtc: d.supplierDirectPayment.netToPayTtc,
      isSolde: false,
      retenueReleased: false,
      retenueReleaseAmount: "0.00",
    };
  } else {
    try {
      deductions = await resolveCertificatDeductions({
        projectId: d.projectId,
        contractorId: d.contractorId,
        totalWorksHt: d.totalWorksHt,
        pvMvAdjustment: "0.00",
        previousPayments: d.previousPayments,
        documentaryBasisInvoices: d.invoices.map((r) => ({
          amountHt: r.amountHt,
          amountTtc: r.amountTtc,
        })),
      });
    } catch (err) {
      const mapped = mapSoldeError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      throw err;
    }
  }
  const nextRef = await storage.getNextCertificateRef(d.projectId);
  // Backwards-compatible single-invoice fields alongside the multi shape.
  const firstRow = d.invoices[0];
  return res.json({
    derivation: {
      ...d,
      devisId: firstRow.devisId,
      mode: firstRow.mode,
    },
    deductions,
    supplierReadiness: supplierReadiness
      ? {
          supplierName: supplierReadiness.supplier.name,
          siret: supplierReadiness.supplier.siret,
          contactName:
            supplierReadiness.supplier.primaryContact?.name ?? null,
          contactEmail:
            supplierReadiness.supplier.primaryContact?.email ?? null,
          accountHolderName:
            supplierReadiness.supplier.banking?.accountHolderName ?? null,
          iban: supplierReadiness.supplier.banking?.iban ?? null,
          bic: supplierReadiness.supplier.banking?.bic ?? null,
          bankName: supplierReadiness.supplier.banking?.bankName ?? null,
          bankingVerifiedAt:
            supplierReadiness.supplier.banking?.bankingVerifiedAt ?? null,
          bankingVerifiedBy:
            supplierReadiness.supplier.banking?.bankingVerifiedBy
              ?.displayName ?? null,
          assignmentStatus:
            supplierReadiness.assignment.directPaymentStatus,
          assignmentValidFrom: supplierReadiness.assignment.validFrom,
          assignmentValidUntil: supplierReadiness.assignment.validUntil,
          sourceSequence: supplierReadiness.provenance.sourceSequence,
        }
      : null,
    nextRef,
  });
}

async function handleCreateFromInvoices(
  invoiceIds: number[],
  res: import("express").Response,
) {
  const preview = await deriveCertificatFromInvoices(invoiceIds);
  if (!preview.ok) {
    return res
      .status(preview.refusal.status)
      .json(preview.refusal.body);
  }
  const identity: {
    projectId: number;
    contractorId: number;
    certificateTrack: CertificateTrack;
  } = {
    projectId: preview.derivation.projectId,
    contractorId: preview.derivation.contractorId,
    certificateTrack: preview.derivation.certificateTrack,
  };
  // Task #612 — mirror the same IBAN gate the preview handler relies on via
  // generateCertificatPdf. A cert created without an IBAN can never be
  // previewed or issued; block here with the same 422 code so the FE can
  // show the banking-missing message immediately, before any DB writes.
  const contractor = await storage.getContractor(identity.contractorId);
  if (!contractor?.iban) {
    return res.status(422).json({
      code: "BANKING_DETAILS_MISSING",
      message: `Coordonnées bancaires manquantes — à compléter dans Archi Doc`,
    });
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cert = await createCertificatFromInvoices(invoiceIds, identity);
      return res.status(201).json(publicCertificatDto(cert));
    } catch (err) {
      if (err instanceof InvoiceStateChangedError) {
        return res.status(409).json({ code: "INVOICE_STATE_CHANGED", message: "Une facture a changé pendant la création — actualisez et réessayez." });
      }
      if (err instanceof DerivationRefusedError) {
        return res.status(err.refusal.status).json(err.refusal.body);
      }
      const mapped = mapSoldeError(err);
      if (mapped) return res.status(mapped.status).json(mapped.body);
      const { code } = pgErrorInfo(err);
      if (code === "23505" && attempt < 2) continue; // ref collision (e.g. manual dialog racing) — full retry
      throw err;
    }
  }
}

// Read-only derivation preview powering the confirmation dialog.
router.get(
  "/api/invoices/:id/certificat-preview",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await buildPreviewPayload([Number(req.params.id)], res);
  },
);

// One-click creation. Server-authoritative end to end: the request body is
// empty — every figure is derived here, never accepted from the client.
router.post(
  "/api/invoices/:id/create-certificat",
  validateRequest({ params: idParams, body: z.object({}).strict().optional() }),
  async (req, res) => {
    const invoiceId = Number(req.params.id);
    // Identity read only — everything financial is (re-)derived under the
    // chain lock inside the service transaction.
    const invoiceRef = await storage.getInvoice(invoiceId);
    if (!invoiceRef) return res.status(404).json({ code: "INVOICE_NOT_FOUND", message: "Facture introuvable." });
    await handleCreateFromInvoices([invoiceId], res);
  },
);

// ─── Multi-facture certificats — grouped creation from a selection ─────────
const fromInvoicesBody = z.object({
  invoiceIds: z.array(z.number().int().positive()).min(1).max(50),
});

/** Load the selection, enforce URL-project ownership, return shared identity. */
async function checkSelectionProject(invoiceIds: number[], projectId: number, res: import("express").Response) {
  const uniqueIds = Array.from(new Set(invoiceIds));
  for (const id of uniqueIds) {
    const inv = await storage.getInvoice(id);
    if (!inv) {
      res.status(404).json({ code: "INVOICE_NOT_FOUND", message: "Facture introuvable." });
      return null;
    }
    if (inv.projectId !== projectId) {
      res.status(409).json({ code: "INVOICE_WRONG_PROJECT", message: "Une des factures sélectionnées n'appartient pas à ce projet." });
      return null;
    }
  }
  const first = await storage.getInvoice(uniqueIds[0]);
  return { uniqueIds };
}

router.post(
  "/api/projects/:projectId/certificats/from-invoices/preview",
  validateRequest({ params: projectIdParams, body: fromInvoicesBody }),
  async (req, res) => {
    const checked = await checkSelectionProject(req.body.invoiceIds, Number(req.params.projectId), res);
    if (!checked) return;
    await buildPreviewPayload(checked.uniqueIds, res);
  },
);

router.post(
  "/api/projects/:projectId/certificats/from-invoices",
  validateRequest({ params: projectIdParams, body: fromInvoicesBody }),
  async (req, res) => {
    const checked = await checkSelectionProject(req.body.invoiceIds, Number(req.params.projectId), res);
    if (!checked) return;
    await handleCreateFromInvoices(checked.uniqueIds, res);
  },
);

// Task #496 — per-project invoice→certificat links (live certs only), powering
// the "Certifié" badge on invoice cards.
router.get(
  "/api/projects/:projectId/certificat-invoice-links",
  validateRequest({ params: projectIdParams }),
  async (req, res) => {
    const projectId = Number(req.params.projectId);
    const rows = await db
      .select({
        invoiceId: certificatSources.invoiceId,
        certificatId: certificatsTable.id,
        certificateRef: certificatsTable.certificateRef,
        certStatus: certificatsTable.status,
      })
      .from(certificatSources)
      .innerJoin(certificatsTable, eq(certificatSources.certificatId, certificatsTable.id))
      .where(eq(certificatsTable.projectId, projectId));
    res.json(rows.filter((r) => r.invoiceId != null && r.certStatus !== "superseded"));
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
      // Task #539 — archived projects must not emit payment instructions.
      // The UI disables Send on archived projects; enforce it server-side
      // too so no other surface (e.g. the dashboard alert) can bypass it.
      const project = await storage.getProject(projectId);
      if (project?.archivedAt) {
        return res.status(409).json({
          code: "PROJECT_ARCHIVED",
          message: "This project is archived — unarchive it before sending a certificat.",
        });
      }
      // Task #457 — a superseded certificat was replaced by a reissue; its
      // pinned PDF is corrected history and must never be (re)sent.
      if (cert.status === "superseded") {
        return res.status(409).json({
          code: "CERTIFICAT_SUPERSEDED",
          message: `Certificat ${cert.certificateRef} was superseded by a reissue and cannot be sent. Send the replacement instead.`,
        });
      }
      if (cert.certificateTrack === "supplier_direct_payment") {
        await assertSupplierCertificateDispatchValid(cert);
      }
      // Task #566 — final-payment gate at the last exit: a solde certificat
      // (already-sealed rows included, which skip the seal's resolver
      // recompute) must not go out without an approved PV de réception or a
      // recorded, audited override.
      if (cert.isSolde && cert.pvOverrideReason == null) {
        const projectMarches = await storage.getMarchesByProject(projectId);
        const marche = projectMarches.find((m) => m.contractorId === cert.contractorId);
        if (!isPvReceptionApproved(marche)) {
          return res.status(422).json({
            code: "PV_RECEPTION_REQUIRED",
            message:
              "Ce certificat de solde ne peut pas être envoyé : le PV de réception du marché n'est pas approuvé. Approuvez le PV (ou enregistrez une dérogation motivée sur le certificat) avant l'envoi.",
            marcheId: marche?.id ?? null,
            pvStatus: marche?.pvReceptionStatus ?? null,
          });
        }
      }

      if (cert.certificateTrack === "contractor_works") {
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
      }

      // Task #543 — one-click send: queue AND dispatch. sendCertificat()
      // only creates/requeues the communication rows; without the dispatch
      // below they sat "queued" forever until the user found them in the
      // Communications hub. sendCommunication() marks the row sent (and
      // chains the contractor notice) or flips it to a visible, retryable
      // FAILED row before rethrowing — never a silent queued row.
      const commId = await sendCertificat(certId);
      try {
        await sendCommunication(commId, { sentByUserId: req.session.userId ?? null });
      } catch (sendErr: unknown) {
        // Concurrent request already holds the dispatch claim — no duplicate
        // email went out; report it without flagging a failure.
        if (sendErr instanceof CommunicationSendInProgressError) {
          const comm = await storage.getProjectCommunication(commId);
          return res.status(409).json({
            code: "CERTIFICAT_SEND_IN_PROGRESS",
            message: "This certificat is already being sent — check the Communications tab in a moment.",
            communication: comm,
          });
        }
        const message = sendErr instanceof Error ? sendErr.message : String(sendErr);
        const failedComm = await storage.getProjectCommunication(commId);
        // Idempotent double-click: the other request finished first and the
        // email is out — that is success, not an error.
        if (failedComm?.status === "sent") {
          return res.json(failedComm);
        }
        return res.status(502).json({
          code: "CERTIFICAT_SEND_FAILED",
          message: `Certificat email could not be sent: ${message}. The communication is marked failed — fix the issue and retry from the Communications tab.`,
          communication: failedComm,
        });
      }
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
      if (err instanceof SupplierPaymentReadinessError) {
        return res.status(422).json({
          code: err.code,
          message:
            "Le paiement direct fournisseur est bloqué : les données de préparation au paiement ArchiDoc sont absentes, incomplètes ou ne sont plus valides.",
          blockers: err.blockers,
        });
      }
      if (err instanceof SupplierCertificateSourceError) {
        return res.status(409).json({
          code: err.code,
          message: err.message,
        });
      }
      if (err instanceof SupplierCertificateDispatchError) {
        return res.status(409).json({
          code: err.code,
          message: err.message,
        });
      }
      // Task #605 — a source in the rendered annexe is already certified by
      // another live certificat: the seal refused (nothing was issued).
      if (err instanceof CertificatSourceConflictError) {
        return res.status(409).json({
          code: "CERTIFICAT_SOURCE_CONFLICT",
          message: err.message,
          conflictingInvoiceIds: err.conflictingInvoiceIds,
          claimingCertificateRefs: err.claimingCertificateRefs,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Failed to send certificat: ${message}` });
    }
  },
);

export default router;
