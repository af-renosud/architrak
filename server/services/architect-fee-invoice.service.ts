/**
 * Architect fee-invoice capture service (Task #425).
 *
 * The firm's own outbound honoraires invoices caught by Gmail polling are
 * typed `architect_fee_invoice` (AI classification + deterministic
 * firm-identity gate) and captured here as evidence rows in
 * `architect_fee_invoices`, parked `pending_review` for the operator.
 *
 * NOTHING here moves money: no fee entry, no milestone transition, no
 * Pennylane call. Confirmation/reconciliation is Task #426. This service
 * only records evidence + ranked SUGGESTIONS (project, milestone).
 *
 * Dedup layers:
 *  - unique source pointers (email doc / intake doc) — DB partial uniques;
 *  - normalized invoice-number dedup among non-dismissed rows (DB partial
 *    unique + pre-check here for a friendlier no-op path).
 */
import { env } from "../env";
import { storage } from "../storage";
import {
  applyFirmIdentityGate,
  normalizeInvoiceRef,
  rankProjectCandidates,
  rankMilestoneCandidates,
  rankWorksFeeCandidates,
  isHighConfidenceProjectMatch,
  type FirmProfile,
  type FeeInvoiceExtraction,
  type FirmGateResult,
  type RankedProjectCandidate,
  type RankedMilestoneCandidate,
  type RankedWorksFeeCandidate,
} from "@shared/architect-fee-match";
import type { ParsedDocument } from "../gmail/document-parser";

/** Firm identity from env — server-controlled, never AI- or user-derived. */
export function getFirmProfile(): FirmProfile {
  return {
    siret: (env.FIRM_SIRET ?? "").replace(/\D/g, ""),
    legalNames: env.FIRM_LEGAL_NAMES.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Mail domains the firm sends from (prefilter allowance, Task #425). */
export function getFirmEmailDomains(): string[] {
  return env.FIRM_EMAIL_DOMAINS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Applies the deterministic firm-identity gate to a fresh extraction and
 * MUTATES parsed.documentType in place when a rewrite happened (so every
 * downstream consumer — routing, persistence, UI type badge — sees the
 * gated type). Returns the gate verdict for audit logging.
 */
export function applyFirmGateToParsed(parsed: ParsedDocument): FirmGateResult {
  const gate = applyFirmIdentityGate(parsed as FeeInvoiceExtraction, getFirmProfile());
  if (gate.documentType !== parsed.documentType) {
    (parsed as { documentType: string }).documentType = gate.documentType;
  }
  return gate;
}

export interface CaptureArgs {
  parsed: ParsedDocument;
  gateReason?: string;
  emailDocumentId?: number | null;
  intakeDocumentId?: number | null;
  fileName?: string | null;
  storageKey?: string | null;
  /** Extra matching haystack, e.g. attachment filename + email subject. */
  matchHaystack?: string | null;
}

export interface CaptureResult {
  outcome: "created" | "duplicate_ref" | "duplicate_source";
  id: number;
}

interface CandidatesPayload {
  projects: (RankedProjectCandidate & { name: string; clientName: string })[];
  highConfidenceProjectId: number | null;
  /** Keyed by projectId — milestones only ranked for top project candidates. */
  milestones: Record<string, (RankedMilestoneCandidate & { labelFr: string; sequence: number; amountTtc: string })[]>;
  /**
   * Task #430 — keyed by projectId: pending works-commission fee entries the
   * invoice could bind to instead of a design milestone (suggestions only).
   */
  worksFees: Record<
    string,
    (RankedWorksFeeCandidate & {
      feeAmount: string;
      contractorName: string | null;
      devisNumber: string | null;
      contractorInvoiceNumber: string | null;
    })[]
  >;
}

/**
 * Records a caught architect fee invoice as a pending_review evidence row.
 * Idempotent across re-catches: an existing non-dismissed row with the same
 * normalized invoice number, or the same source document, is a no-op.
 */
export async function captureArchitectFeeInvoice(args: CaptureArgs): Promise<CaptureResult> {
  const parsed = args.parsed as FeeInvoiceExtraction;

  // Source-pointer dedup (crash-retry safety).
  if (args.emailDocumentId != null) {
    const existing = await storage.getArchitectFeeInvoiceByEmailDocumentId(args.emailDocumentId);
    if (existing) return { outcome: "duplicate_source", id: existing.id };
  }
  if (args.intakeDocumentId != null) {
    const existing = await storage.getArchitectFeeInvoiceByIntakeDocumentId(args.intakeDocumentId);
    if (existing) return { outcome: "duplicate_source", id: existing.id };
  }

  // Business-ref dedup (pre-check; the DB partial unique is the backstop).
  const refNorm = normalizeInvoiceRef(parsed.invoiceNumber ?? parsed.reference);
  if (refNorm) {
    const existing = await storage.getArchitectFeeInvoiceByNormalizedRef(refNorm);
    if (existing) return { outcome: "duplicate_ref", id: await backfillSourcePointer(existing, args) };
  }

  // Rank candidates — suggestions only, never auto-confirmed.
  const projects = await storage.getProjects({ includeArchived: false });
  const rankedProjects = rankProjectCandidates(parsed, projects, args.matchHaystack ?? args.fileName ?? null).slice(0, 5);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const highConfidence = isHighConfidenceProjectMatch(rankedProjects);

  const milestones: CandidatesPayload["milestones"] = {};
  const worksFees: CandidatesPayload["worksFees"] = {};
  const worksHaystack = args.matchHaystack ?? args.fileName ?? null;
  for (const cand of rankedProjects.slice(0, 3)) {
    const contract = await storage.getDesignContractByProject(cand.projectId);
    if (contract) {
      const rows = await storage.getDesignContractMilestones(contract.id);
      const ranked = rankMilestoneCandidates(parsed, rows);
      if (ranked.length > 0) {
        const rowById = new Map(rows.map((m) => [m.id, m]));
        milestones[String(cand.projectId)] = ranked.map((r) => {
          const m = rowById.get(r.milestoneId)!;
          return { ...r, labelFr: m.labelFr, sequence: m.sequence, amountTtc: m.amountTtc };
        });
      }
    }
    // Task #430 — pending works-commission entries as alternative binding.
    const worksRows = await storage.getPendingWorksFeeCandidates(cand.projectId);
    const rankedWorks = rankWorksFeeCandidates(parsed as FeeInvoiceExtraction & { devisNumber?: string | null }, worksRows, worksHaystack);
    if (rankedWorks.length > 0) {
      const rowByEntry = new Map(worksRows.map((w) => [w.feeEntryId, w]));
      worksFees[String(cand.projectId)] = rankedWorks.map((r) => {
        const w = rowByEntry.get(r.feeEntryId)!;
        return {
          ...r,
          feeAmount: w.feeAmount,
          contractorName: w.contractorName,
          devisNumber: w.devisNumber ?? w.devisCode,
          contractorInvoiceNumber: w.contractorInvoiceNumber,
        };
      });
    }
  }

  const candidates: CandidatesPayload = {
    projects: rankedProjects.map((r) => {
      const p = projectById.get(r.projectId);
      return { ...r, name: p?.name ?? "?", clientName: p?.clientName ?? "?" };
    }),
    highConfidenceProjectId: highConfidence ? rankedProjects[0].projectId : null,
    milestones,
    worksFees,
  };

  const toMoney = (v: number | null | undefined): string | null =>
    v != null && Number.isFinite(v) ? v.toFixed(2) : null;

  const inserted = await storage.createArchitectFeeInvoice({
    emailDocumentId: args.emailDocumentId ?? null,
    intakeDocumentId: args.intakeDocumentId ?? null,
    invoiceNumber: parsed.invoiceNumber ?? parsed.reference ?? null,
    invoiceNumberNormalized: refNorm || null,
    issueDate: parsed.date ?? null,
    amountHt: toMoney(parsed.amountHt),
    tvaAmount: toMoney(parsed.tvaAmount),
    amountTtc: toMoney(parsed.amountTtc),
    clientName: parsed.clientName ?? null,
    // Task #430 — first-class works-commission correlation (devis reference
    // printed on the firm's commission invoice).
    devisNumber: (parsed as { devisNumber?: string | null }).devisNumber ?? null,
    devisNumberNormalized: normalizeInvoiceRef((parsed as { devisNumber?: string | null }).devisNumber) || null,
    fileName: args.fileName ?? null,
    storageKey: args.storageKey ?? null,
    source: "gmail",
    identityReason: args.gateReason ?? null,
    candidates,
    extractionSnapshot: { ...args.parsed },
    notes: null,
  });
  if (!inserted) {
    // Lost a concurrent-capture race: ON CONFLICT DO NOTHING swallowed the
    // insert. Resolve the surviving row by source pointer, then by ref.
    const existing =
      (args.emailDocumentId != null ? await storage.getArchitectFeeInvoiceByEmailDocumentId(args.emailDocumentId) : undefined) ??
      (args.intakeDocumentId != null ? await storage.getArchitectFeeInvoiceByIntakeDocumentId(args.intakeDocumentId) : undefined) ??
      (refNorm ? await storage.getArchitectFeeInvoiceByNormalizedRef(refNorm) : undefined);
    if (!existing) {
      throw new Error("architect fee-invoice insert conflicted but no surviving row was found");
    }
    return { outcome: "duplicate_ref", id: await backfillSourcePointer(existing, args) };
  }
  console.log(
    `[ArchitectFeeInvoice] Captured fee invoice ${inserted.id} (ref="${parsed.invoiceNumber ?? "?"}", ` +
      `${rankedProjects.length} project candidate(s)${highConfidence ? `, high-confidence project ${rankedProjects[0].projectId}` : ""})`,
  );
  return { outcome: "created", id: inserted.id };
}

/**
 * Backfills a missing source pointer on an existing evidence row so the
 * source-unique guard also covers this catch on future retries. Unique
 * conflicts (another row already claimed that pointer) are non-fatal —
 * dedup already succeeded, the pointer is best-effort audit linkage.
 */
async function backfillSourcePointer(
  existing: { id: number; emailDocumentId: number | null; intakeDocumentId: number | null },
  args: CaptureArgs,
): Promise<number> {
  try {
    if (args.emailDocumentId != null && existing.emailDocumentId == null) {
      await storage.updateArchitectFeeInvoice(existing.id, { emailDocumentId: args.emailDocumentId });
    } else if (args.intakeDocumentId != null && existing.intakeDocumentId == null) {
      await storage.updateArchitectFeeInvoice(existing.id, { intakeDocumentId: args.intakeDocumentId });
    }
  } catch (err) {
    console.warn(`[ArchitectFeeInvoice] Source-pointer backfill on row ${existing.id} skipped:`, err);
  }
  return existing.id;
}
