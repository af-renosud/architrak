import type { EmailDocument, ProjectIntakeDocument } from "./schema";

export type EmailDocumentFilingState =
  | "processing"
  | "needs_review"
  | "filed"
  | "duplicate"
  | "failed"
  | "removed"
  | "not_filed"
  | "mismatch";

export interface EmailDocumentFiling {
  state: EmailDocumentFilingState;
  label: string;
  reason: string | null;
  intakeId: number | null;
  projectId: number | null;
  promotedKind: string | null;
  promotedId: number | null;
  destination: { href: string; label: string } | null;
  /** Only extraction/analysis that is still running should drive UI polling. */
  isActive: boolean;
}

export type EmailDocumentWithFiling = EmailDocument & { filing: EmailDocumentFiling };

export type FilingEmailSource = Pick<
  EmailDocument,
  "id" | "projectId" | "extractionStatus" | "intakeDeletedAt" | "notes"
>;

export type FilingIntakeSource = Pick<
  ProjectIntakeDocument,
  "id" | "projectId" | "sourceEmailDocumentId" | "analysisState" | "routingState"
  | "promotedKind" | "promotedId" | "notes"
>;

/** A live, DB-resolved record, not an id inferred from extraction JSON. */
export interface FilingTarget {
  kind: string;
  id: number;
  projectId: number;
  sourceIntakeDocumentId: number | null;
  isRemoved: boolean;
}

export interface EmailDocumentFilingInput {
  email: FilingEmailSource;
  intake: FilingIntakeSource | null;
  /** Existence of intake.projectId, or email.projectId when there is no intake. */
  projectExists: boolean;
  target: FilingTarget | null;
}

const labels: Record<EmailDocumentFilingState, string> = {
  processing: "Processing",
  needs_review: "Needs review",
  filed: "Added to project",
  duplicate: "Duplicate",
  failed: "Failed",
  removed: "Removed",
  not_filed: "Not filed",
  mismatch: "Filing mismatch",
};

const supportedKinds = new Set(["devis", "invoice", "situation", "marche_document"]);

function note(value: string | null): string | null {
  return value?.trim() || null;
}

/**
 * Read-only filing classification. Email extraction completion is never proof
 * of promotion, and email.devisId/invoiceId are deliberately not inputs.
 *
 * Tombstones win over every stale pointer. On disagreement, navigation is
 * restricted to the actual linked intake's live project, never to the alleged
 * promoted target. Duplicate rows similarly navigate only to their own intake;
 * resolving chains of duplicate references is unnecessary and unsafe here.
 */
export function classifyEmailDocumentFiling(input: EmailDocumentFilingInput): EmailDocumentFiling {
  const { email, intake, target, projectExists } = input;
  const projectId = intake?.projectId ?? email.projectId;
  const intakeDestination = intake && projectExists && intake.sourceEmailDocumentId === email.id
    ? { href: `/projets/${intake.projectId}?tab=intake`, label: "Open project intake" }
    : null;
  const base = {
    intakeId: intake?.id ?? null,
    projectId,
    promotedKind: intake?.promotedKind ?? null,
    promotedId: intake?.promotedId ?? null,
  };
  function result(
    state: EmailDocumentFilingState,
    reason: string | null,
    destination: EmailDocumentFiling["destination"] = intakeDestination,
  ): EmailDocumentFiling {
    return { ...base, state, label: labels[state], reason, destination, isActive: state === "processing" };
  }

  if (email.intakeDeletedAt != null || ["skipped", "removed"].includes(email.extractionStatus)
    || (intake && (intake.analysisState === "removed" || intake.routingState === "removed"))) {
    return {
      ...result("removed", "This source was removed from document intake.", null),
      promotedKind: null,
      promotedId: null,
    };
  }
  if (intake && intake.sourceEmailDocumentId !== email.id) {
    return result("mismatch", "The intake source does not match this email document.", null);
  }
  if (projectId != null && !projectExists) {
    return result("mismatch", "The assigned project no longer exists.", null);
  }
  if (intake && email.projectId !== intake.projectId) {
    return result(
      "mismatch",
      `Email assignment (${email.projectId == null ? "unassigned" : `project #${email.projectId}`}) differs from linked intake project #${intake.projectId}. Review the existing intake; no records were moved.`,
    );
  }

  if (intake && (intake.promotedKind != null || intake.promotedId != null || intake.routingState === "routed")) {
    if (!intake.promotedKind || intake.promotedId == null || intake.routingState !== "routed") {
      return result("mismatch", "The intake routing state and promoted record reference disagree.");
    }
    if (!supportedKinds.has(intake.promotedKind)) {
      return result("mismatch", `The promoted record kind "${intake.promotedKind}" cannot be verified.`);
    }
    if (!target) return result("mismatch", "The promoted record no longer exists.");
    if (target.kind !== intake.promotedKind || target.id !== intake.promotedId
      || target.projectId !== intake.projectId
      || (target.sourceIntakeDocumentId != null && target.sourceIntakeDocumentId !== intake.id)) {
      return result("mismatch", "The promoted record does not match this intake source and project.");
    }
    if (target.isRemoved) return result("removed", "The promoted record was voided or removed.", null);
    if (target.kind === "devis") {
      return result("filed", null, {
        href: `/projets/${target.projectId}?devis=${target.id}`,
        label: "Open devis",
      });
    }
    if (target.kind === "invoice") {
      return result("filed", null, {
        href: `/projets/${target.projectId}?tab=factures&invoice=${target.id}`,
        label: "Open invoice",
      });
    }
    // Other verified typed records have no exact-record deep-link contract.
    return result("filed", null);
  }
  if (intake?.routingState === "duplicate" || (!intake && email.extractionStatus === "duplicate")) {
    return result("duplicate", note(intake?.notes ?? email.notes) ?? "A duplicate was detected; no new record was added.");
  }
  if (intake) {
    if (intake.analysisState === "failed" || intake.routingState === "failed") {
      return result("failed", note(intake.notes) ?? "Intake analysis or routing failed.");
    }
    if (["parked", "needs_review"].includes(intake.routingState)) {
      return result("needs_review", note(intake.notes) ?? "The document needs review in project intake before it can be filed.");
    }
    if (["pending", "analyzing", "processing"].includes(intake.analysisState)
      || (intake.analysisState === "analyzed" && intake.routingState === "unrouted")) {
      return result("processing", "The document is in project intake; analysis or routing has not finished.");
    }
    return result("needs_review", note(intake.notes) ?? "The intake document has not been routed to a verified record.");
  }
  if (email.extractionStatus === "failed") {
    return result("failed", note(email.notes) ?? "Email document extraction failed.", null);
  }
  if (["pending", "processing"].includes(email.extractionStatus)) {
    return result("processing", "Email document extraction has not finished.", null);
  }
  if (email.projectId == null || ["needs_review", "unmatched_sender"].includes(email.extractionStatus)) {
    return result("needs_review", note(email.notes) ?? "Assign a project and review this document before filing.", null);
  }
  return result("not_filed", "Extraction alone does not file a document. No linked project intake record was found.", null);
}