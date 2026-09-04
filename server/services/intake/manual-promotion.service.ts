import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  acompteNoInvoicePayments,
  contractors,
  devis,
  devisLineItems,
  emailDocuments,
  intakeManualPromotions,
  invoiceAcompteApplications,
  invoices,
  projectDocuments,
  projectIntakeDocuments,
  projects,
} from "@shared/schema";
import type { ParsedDocument } from "../../gmail/document-parser";
import { db } from "../../db";
import { assertPdfMagic } from "../../middleware/upload";
import { getDocumentBuffer } from "../../storage/object-storage";
import { roundCurrency, deriveTvaAmount } from "../../../shared/financial-utils";
import { safeExtractBic, safeExtractIban } from "../../../shared/iban";
import { toSentenceCase } from "../../lib/sentence-case";
import { validateExtraction, type ValidationWarning } from "../extraction-validator";
import { coerceBbox } from "../devis-upload.service";
import { triggerDevisTranslation } from "../devis-translation";
import { enqueueReconciliation } from "../reconciliation/reconciliation-queue.service";
import { reconcileAdvisories } from "../advisory-reconciler";
import { enqueueDriveUpload } from "../drive/upload-queue.service";
import { storage } from "../../storage";

export type ManualPromotionKind = "devis" | "invoice";

export interface ManualPromotionInput {
  intakeDocumentId: number;
  expectedFingerprint?: string | null;
  kind: ManualPromotionKind;
  contractorId?: number;
  devisId?: number;
  note: string;
  confirmedByUserId: number;
}

export interface ManualPromotionResult {
  kind: ManualPromotionKind;
  id: number;
  projectId: number;
  replayed: boolean;
}

export class ManualPromotionError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManualPromotionError";
  }
}

function fail(status: 404 | 409 | 422, code: string, message: string): never {
  throw new ManualPromotionError(status, code, message);
}

function sourceFingerprint(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function parkReason(doc: {
  notes: string | null;
  analysisState: string;
  routingState: string;
  extractedData: unknown;
}): string {
  if (doc.notes?.trim()) return doc.notes.trim();
  const data = doc.extractedData;
  if (data && typeof data === "object") {
    const candidate = data as Record<string, unknown>;
    const reason = candidate.parseFailureReason ?? candidate.error ?? candidate.message;
    if (typeof reason === "string" && reason.trim()) return reason.trim();
  }
  return `Automatic processing stopped in ${doc.analysisState}/${doc.routingState}.`;
}

function asParsedDocument(value: unknown, kind: ManualPromotionKind): ParsedDocument {
  const base =
    value && typeof value === "object" && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>) }
      : {};
  return {
    ...base,
    documentType: kind === "devis" ? "quotation" : "invoice",
  } as ParsedDocument;
}

function amountPair(parsed: ParsedDocument, corrected: Partial<ParsedDocument>): {
  ht: number;
  ttc: number;
} {
  const effectiveHt = corrected.amountHt ?? parsed.amountHt;
  const effectiveTtc = corrected.amountTtc ?? parsed.amountTtc;
  const fallback = effectiveHt ?? effectiveTtc ?? 0;
  const rawHt = roundCurrency(Number.isFinite(Number(effectiveHt ?? fallback)) ? Number(effectiveHt ?? fallback) : 0);
  const rawTtc = roundCurrency(Number.isFinite(Number(effectiveTtc ?? fallback)) ? Number(effectiveTtc ?? fallback) : 0);
  const ht = Math.max(0, rawHt);
  return {
    ht,
    // The invoice table forbids negative derived TVA. Preserve the extraction
    // verbatim in aiExtractedData, but keep the deliberately incomplete draft
    // editable by storing a non-negative placeholder pair.
    ttc: Math.max(ht, rawTtc, 0),
  };
}

function manualWarnings(
  validationWarnings: ValidationWarning[],
  parsed: ParsedDocument,
  reason: string,
): ValidationWarning[] {
  const warnings = [...validationWarnings];
  if (parsed.amountHt == null || parsed.amountTtc == null) {
    warnings.push({
      field: parsed.amountHt == null ? "amountHt" : "amountTtc",
      expected: "operator-entered HT and TTC",
      actual: undefined,
      message: "Manual override created this draft without a complete HT/TTC pair. Both amounts must be checked before confirmation.",
      severity: "error",
    });
  }
  warnings.push({
    field: "manualPromotion",
    expected: "complete operator review before confirmation",
    actual: "automatic intake bypassed",
    message: `Submitted manually after automatic processing parked this PDF: ${reason}`,
    severity: "error",
  });
  return warnings;
}

function isPromotableState(doc: { analysisState: string; routingState: string }): boolean {
  return doc.routingState === "parked"
    || doc.routingState === "failed"
    || (doc.analysisState === "failed" && doc.routingState === "unrouted");
}

export async function promoteParkedFinancialDocument(
  input: ManualPromotionInput,
): Promise<ManualPromotionResult> {
  const note = input.note.trim();
  if (note.length < 10) {
    fail(422, "note_too_short", "The audit note must contain at least 10 characters.");
  }

  const source = await db.query.projectIntakeDocuments.findFirst({
    where: eq(projectIntakeDocuments.id, input.intakeDocumentId),
  });
  if (!source) fail(404, "not_found", "Document not found.");

  let buffer: Buffer;
  try {
    buffer = await getDocumentBuffer(source.storageKey);
    assertPdfMagic(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(422, "invalid_source_pdf", `The stored source is not a readable PDF: ${message}`);
  }

  const fingerprint = sourceFingerprint(buffer);
  if (input.expectedFingerprint && input.expectedFingerprint.toLowerCase() !== fingerprint) {
    fail(409, "fingerprint_changed", "The source PDF changed. Refresh before submitting it.");
  }

  const transactionResult = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(projectIntakeDocuments)
      .where(eq(projectIntakeDocuments.id, input.intakeDocumentId))
      .for("update");
    if (!doc) fail(404, "not_found", "Document not found.");

    const [existingAudit] = await tx
      .select()
      .from(intakeManualPromotions)
      .where(eq(intakeManualPromotions.intakeDocumentId, doc.id));
    if (existingAudit) {
      const sameTarget =
        existingAudit.promotedKind === input.kind
        && existingAudit.sourceContentFingerprint === fingerprint
        && (input.kind === "invoice"
          ? existingAudit.targetDevisId === input.devisId
          : existingAudit.contractorId === input.contractorId);
      if (!sameTarget) {
        fail(409, "already_promoted", "This source was already submitted to a different draft.");
      }
      return {
        result: {
          kind: existingAudit.promotedKind as ManualPromotionKind,
          id: existingAudit.promotedId,
          projectId: existingAudit.projectId,
          replayed: true,
        },
        warnings: [] as ValidationWarning[],
        targetDevis: null as typeof devis.$inferSelect | null,
      };
    }

    if (!isPromotableState(doc) || doc.promotedKind != null || doc.promotedId != null) {
      fail(409, "source_not_parked", "Only a parked, failed, unpromoted source can be submitted manually.");
    }
    if (doc.contentFingerprint && doc.contentFingerprint !== fingerprint) {
      fail(409, "fingerprint_changed", "The stored source fingerprint no longer matches the PDF bytes.");
    }
    if (doc.contentFingerprint && !input.expectedFingerprint) {
      fail(422, "expected_fingerprint_required", "Refresh the document before submitting it.");
    }

    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, doc.projectId))
      .for("update");
    if (!project) fail(404, "project_not_found", "Project not found.");
    if (project.archivedAt != null) {
      fail(409, "project_archived", "Archived projects are read-only.");
    }

    const [paymentEvidence] = await tx
      .select({ id: acompteNoInvoicePayments.id })
      .from(acompteNoInvoicePayments)
      .where(eq(acompteNoInvoicePayments.sourceIntakeDocumentId, doc.id))
      .limit(1);
    const [applicationEvidence] = await tx
      .select({ id: invoiceAcompteApplications.id })
      .from(invoiceAcompteApplications)
      .where(eq(invoiceAcompteApplications.sourceIntakeDocumentId, doc.id))
      .limit(1);
    if (paymentEvidence || applicationEvidence) {
      fail(409, "immutable_payment_evidence", "This source is immutable payment evidence and cannot be overridden.");
    }

    let selectedContractorId: number;
    let targetDevis: typeof devis.$inferSelect | null = null;
    if (input.kind === "devis") {
      if (!input.contractorId) fail(422, "contractor_required", "Choose the contractor for this devis.");
      const [contractor] = await tx
        .select()
        .from(contractors)
        .where(eq(contractors.id, input.contractorId));
      if (!contractor) fail(422, "contractor_not_found", "The selected contractor no longer exists.");
      selectedContractorId = contractor.id;
    } else {
      if (!input.devisId) fail(422, "devis_required", "Choose the devis this invoice belongs to.");
      [targetDevis] = await tx.select().from(devis).where(eq(devis.id, input.devisId)).for("update");
      if (!targetDevis || targetDevis.projectId !== doc.projectId) {
        fail(422, "devis_wrong_project", "The selected devis does not belong to this project.");
      }
      if (targetDevis.accountingState === "superseded" || targetDevis.status === "void") {
        fail(409, "devis_inactive", "The selected devis is no longer active.");
      }
      selectedContractorId = targetDevis.contractorId;
    }

    if (doc.sourceEmailDocumentId != null) {
      const [email] = await tx
        .select()
        .from(emailDocuments)
        .where(eq(emailDocuments.id, doc.sourceEmailDocumentId))
        .for("update");
      if (!email || email.extractionStatus === "dismissed" || email.extractionStatus === "skipped") {
        fail(409, "email_source_unavailable", "The source email was dismissed or removed.");
      }
    }

    const reason = parkReason(doc);
    const parsed = asParsedDocument(doc.extractedData, input.kind);
    const validation = validateExtraction(parsed);
    const corrected = { ...parsed, ...validation.correctedValues };
    const amounts = amountPair(parsed, validation.correctedValues);
    const warnings = manualWarnings(validation.warnings, parsed, reason);
    let promotedId: number;

    if (input.kind === "devis") {
      const [created] = await tx
        .insert(devis)
        .values({
          projectId: doc.projectId,
          contractorId: selectedContractorId,
          sourceIntakeDocumentId: doc.id,
          lotId: null,
          marcheId: null,
          devisCode: parsed.reference || parsed.devisNumber || doc.fileName.replace(/\.pdf$/i, ""),
          devisNumber: parsed.devisNumber || parsed.reference || null,
          ref2: null,
          descriptionFr: toSentenceCase(parsed.description || parsed.contractorName || doc.fileName) as string,
          descriptionUk: null,
          amountHt: String(amounts.ht),
          amountTtc: String(amounts.ttc),
          invoicingMode: parsed.lineItems?.length ? "mode_b" : "mode_a",
          status: "draft",
          accountingState: "provisional",
          dateSent: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
          dateSigned: null,
          pvmvRef: null,
          pdfStorageKey: doc.storageKey,
          pdfFileName: doc.fileName,
          validationWarnings: warnings,
          aiExtractedData: corrected,
          aiConfidence: validation.confidenceScore,
          extractedIban: safeExtractIban(parsed.iban),
          extractedBic: safeExtractBic(parsed.bic),
          notes: `Manual intake override: ${note}`,
          manualIntakeReviewRequired: true,
        })
        .onConflictDoNothing({
          target: devis.sourceIntakeDocumentId,
          where: isNotNull(devis.sourceIntakeDocumentId),
        })
        .returning();
      const promoted = created ?? (await tx
        .select()
        .from(devis)
        .where(eq(devis.sourceIntakeDocumentId, doc.id)))[0];
      if (!promoted) throw new Error("devis source insert conflicted without an existing target");
      promotedId = promoted.id;

      if (created && parsed.lineItems?.length) {
        await tx.insert(devisLineItems).values(parsed.lineItems.map((line, index) => ({
          devisId: created.id,
          lineNumber: index + 1,
          description: toSentenceCase(line.description || `Line ${index + 1}`) as string,
          quantity: String(Number.isFinite(Number(line.quantity)) ? Math.round(Number(line.quantity) * 1000) / 1000 : 1),
          unit: "u",
          unitPriceHt: String(roundCurrency(line.unitPrice ?? 0)),
          totalHt: String(roundCurrency(line.total ?? 0)),
          percentComplete: "0",
          pdfPageHint: Number.isInteger(line.pageHint) && Number(line.pageHint) >= 1 ? Number(line.pageHint) : null,
          pdfBbox: coerceBbox(line.bbox),
        })));
      }
    } else {
      const [created] = await tx
        .insert(invoices)
        .values({
          devisId: targetDevis!.id,
          projectId: doc.projectId,
          contractorId: selectedContractorId,
          sourceIntakeDocumentId: doc.id,
          invoiceNumber: parsed.invoiceNumber || parsed.reference || doc.fileName.replace(/\.pdf$/i, ""),
          amountHt: String(amounts.ht),
          tvaAmount: String(deriveTvaAmount(amounts.ht, amounts.ttc)),
          amountTtc: String(amounts.ttc),
          status: "draft",
          dateIssued: parsed.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : null,
          datePaid: null,
          pdfPath: doc.storageKey,
          notes: `Manual intake override: ${note}`,
          validationWarnings: warnings,
          aiExtractedData: corrected,
          aiConfidence: validation.confidenceScore,
          extractedIban: safeExtractIban(parsed.iban),
          extractedBic: safeExtractBic(parsed.bic),
          manualIntakeReviewRequired: true,
        })
        .onConflictDoNothing({
          target: invoices.sourceIntakeDocumentId,
          where: isNotNull(invoices.sourceIntakeDocumentId),
        })
        .returning();
      const promoted = created ?? (await tx
        .select()
        .from(invoices)
        .where(eq(invoices.sourceIntakeDocumentId, doc.id)))[0];
      if (!promoted) throw new Error("invoice source insert conflicted without an existing target");
      promotedId = promoted.id;
    }

    const projectDocExists = doc.sourceEmailDocumentId == null
      ? false
      : (await tx
        .select({ id: projectDocuments.id })
        .from(projectDocuments)
        .where(eq(projectDocuments.sourceEmailDocumentId, doc.sourceEmailDocumentId))
        .limit(1)).length > 0;
    if (!projectDocExists) {
      await tx.insert(projectDocuments).values({
        projectId: doc.projectId,
        fileName: doc.fileName,
        storageKey: doc.storageKey,
        documentType: input.kind === "devis" ? "quotation" : "invoice",
        uploadedBy: `manual-override:${input.confirmedByUserId}`,
        description: `Source PDF submitted manually as ${input.kind}: ${note}`,
        sourceEmailDocumentId: doc.sourceEmailDocumentId,
      }).onConflictDoNothing();
    }

    await tx.insert(intakeManualPromotions).values({
      intakeDocumentId: doc.id,
      projectId: doc.projectId,
      sourceStorageKey: doc.storageKey,
      sourceFileName: doc.fileName,
      sourceContentFingerprint: fingerprint,
      priorAnalysisState: doc.analysisState,
      priorRoutingState: doc.routingState,
      priorParkReason: reason,
      promotedKind: input.kind,
      promotedId,
      contractorId: selectedContractorId,
      targetDevisId: targetDevis?.id ?? null,
      operatorNote: note,
      confirmedByUserId: input.confirmedByUserId,
    });

    const manualNote = `Submitted manually as ${input.kind} draft by user ${input.confirmedByUserId}: ${note}`;
    await tx
      .update(projectIntakeDocuments)
      .set({
        contentFingerprint: fingerprint,
        analysisState: "analyzed",
        routingState: "routed",
        promotedKind: input.kind,
        promotedId,
        notes: doc.notes ? `${doc.notes}\n${manualNote}` : manualNote,
        updatedAt: new Date(),
      })
      .where(and(
        eq(projectIntakeDocuments.id, doc.id),
        isNull(projectIntakeDocuments.promotedKind),
        isNull(projectIntakeDocuments.promotedId),
      ));

    if (doc.sourceEmailDocumentId != null) {
      await tx
        .update(emailDocuments)
        .set({
          projectId: doc.projectId,
          contentFingerprint: fingerprint,
          documentType: input.kind === "devis" ? "quotation" : "invoice",
          extractionStatus: "completed",
          notes: manualNote,
          updatedAt: new Date(),
        })
        .where(eq(emailDocuments.id, doc.sourceEmailDocumentId));
    }

    return {
      result: { kind: input.kind, id: promotedId, projectId: doc.projectId, replayed: false },
      warnings,
      targetDevis,
    };
  });

  if (!transactionResult.result.replayed) {
    try {
      if (transactionResult.result.kind === "devis") {
        await reconcileAdvisories({ devisId: transactionResult.result.id }, transactionResult.warnings, "manual");
        triggerDevisTranslation(transactionResult.result.id);
        await enqueueReconciliation(transactionResult.result.projectId);
      } else {
        await reconcileAdvisories({ invoiceId: transactionResult.result.id }, transactionResult.warnings, "manual");
        const parent = transactionResult.targetDevis;
        if (parent) {
          void enqueueDriveUpload({
            docKind: "invoice",
            docId: transactionResult.result.id,
            projectId: transactionResult.result.projectId,
            lotId: parent.lotId ?? null,
            sourceStorageKey: source.storageKey,
            displayName: `${source.fileName.replace(/\.pdf$/i, "")}.pdf`,
            seedDevisCode: parent.devisCode,
          });
          await storage.revokeDevisCheckTokenIfFullyInvoiced(parent.id);
        }
      }
    } catch (error) {
      console.warn("[ManualPromotion] post-commit side effect failed:", error);
    }
  }

  return transactionResult.result;
}