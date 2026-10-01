import { describe, expect, it } from "vitest";
import {
  classifyEmailDocumentFiling,
  type EmailDocumentFilingInput,
  type FilingEmailSource,
  type FilingIntakeSource,
  type FilingTarget,
} from "../email-document-filing";

const email: FilingEmailSource = {
  id: 898, projectId: 12, extractionStatus: "completed", intakeDeletedAt: null, notes: null,
};
const intake: FilingIntakeSource = {
  id: 80, projectId: 12, sourceEmailDocumentId: 898,
  analysisState: "analyzed", routingState: "routed",
  promotedKind: "devis", promotedId: 35, notes: null,
};
const target: FilingTarget = {
  kind: "devis", id: 35, projectId: 12, sourceIntakeDocumentId: 80, isRemoved: false,
};
function classify(overrides: Partial<EmailDocumentFilingInput> = {}) {
  return classifyEmailDocumentFiling({ email, intake, target, projectExists: true, ...overrides });
}
const intakeDestination = { href: "/projets/12?tab=intake", label: "Open project intake" };

describe("email document filing classification", () => {
  it("verifies a received/draft devis without consulting legacy email.devisId", () => {
    expect(classify()).toEqual({
      state: "filed", label: "Added to project", reason: null, isActive: false,
      intakeId: 80, projectId: 12, promotedKind: "devis", promotedId: 35,
      destination: { href: "/projets/12?devis=35", label: "Open devis" },
    });
  });

  it("uses the supported Factures invoice route for a verified invoice", () => {
    expect(classify({
      intake: { ...intake, promotedKind: "invoice", promotedId: 44 },
      target: { ...target, kind: "invoice", id: 44 },
    })).toMatchObject({
      state: "filed", promotedKind: "invoice", promotedId: 44, isActive: false,
      destination: { href: "/projets/12?tab=factures&invoice=44", label: "Open invoice" },
    });
  });

  it.each(["pending", "analyzing", "processing"])(
    "does not confuse completed email extraction with intake %s",
    (analysisState) => {
      expect(classify({
        intake: { ...intake, analysisState, routingState: "unrouted", promotedKind: null, promotedId: null },
        target: null,
      })).toMatchObject({ state: "processing", destination: intakeDestination, isActive: true });
    },
  );

  it("keeps analyzed but still unrouted intake active", () => {
    expect(classify({
      intake: { ...intake, routingState: "unrouted", promotedKind: null, promotedId: null },
      target: null,
    })).toMatchObject({ state: "processing", isActive: true });
  });

  it("completed extraction with no intake is explicitly not filed", () => {
    expect(classify({ intake: null, target: null })).toMatchObject({
      state: "not_filed", intakeId: null, promotedId: null, destination: null, isActive: false,
    });
  });

  it("pending extraction with no intake is active", () => {
    expect(classify({ intake: null, target: null, email: { ...email, extractionStatus: "pending" } }))
      .toMatchObject({ state: "processing", destination: null, isActive: true });
  });

  it("unassigned completed extraction needs review, not a fabricated destination", () => {
    expect(classify({ intake: null, target: null, email: { ...email, projectId: null }, projectExists: false }))
      .toMatchObject({ state: "needs_review", projectId: null, destination: null, isActive: false });
  });

  it.each(["needs_review", "unmatched_sender"])("surfaces extraction review status %s", (extractionStatus) => {
    expect(classify({
      intake: null, target: null, email: { ...email, extractionStatus, notes: "Project evidence is ambiguous." },
    })).toMatchObject({ state: "needs_review", reason: "Project evidence is ambiguous.", destination: null });
  });

  it("parked intake keeps its actionable routing reason separate from extraction", () => {
    expect(classify({
      intake: { ...intake, routingState: "parked", promotedKind: null, promotedId: null, notes: "No matching contractor quotation." },
      target: null,
    })).toMatchObject({
      state: "needs_review", reason: "No matching contractor quotation.",
      destination: intakeDestination, isActive: false,
    });
  });

  it.each(["analysis", "routing"])("surfaces %s failure with intake navigation", (failure) => {
    expect(classify({
      intake: {
        ...intake, promotedKind: null, promotedId: null,
        analysisState: failure === "analysis" ? "failed" : "analyzed",
        routingState: failure === "routing" ? "failed" : "unrouted",
        notes: "Unable to analyze PDF.",
      },
      target: null,
    })).toMatchObject({ state: "failed", reason: "Unable to analyze PDF.", destination: intakeDestination, isActive: false });
  });

  it("surfaces extraction failure when no intake exists", () => {
    expect(classify({
      intake: null, target: null, email: { ...email, extractionStatus: "failed", notes: "Password-protected PDF." },
    })).toMatchObject({ state: "failed", reason: "Password-protected PDF.", destination: null });
  });

  it("duplicate navigates only to its own intake, not unverified JSON references", () => {
    expect(classify({
      intake: { ...intake, routingState: "duplicate", promotedKind: null, promotedId: null, notes: "Duplicate of intake document #79." },
      target: null,
    })).toMatchObject({
      state: "duplicate", reason: "Duplicate of intake document #79.",
      promotedId: null, destination: intakeDestination, isActive: false,
    });
  });

  it.each(["tombstone", "skipped", "removed"])("removal %s defeats even a stale valid promotion", (removed) => {
    expect(classify({
      email: {
        ...email,
        intakeDeletedAt: removed === "tombstone" ? new Date("2026-10-01T15:00:00Z") : null,
        extractionStatus: removed === "tombstone" ? "completed" : removed,
      },
    })).toMatchObject({ state: "removed", promotedKind: null, promotedId: null, destination: null, isActive: false });
  });

  it("voided promoted record has no stale open action", () => {
    expect(classify({ target: { ...target, isRemoved: true } }))
      .toMatchObject({ state: "removed", destination: null, isActive: false });
  });

  it("assignment disagreement exposes the actual intake project, never the target", () => {
    const filing = classify({ email: { ...email, projectId: 99 } });
    expect(filing).toMatchObject({ state: "mismatch", projectId: 12, destination: intakeDestination, isActive: false });
    expect(filing.reason).toMatch(/project #99.*intake project #12/);
  });

  it("unassigned email with existing intake also requires assignment review", () => {
    expect(classify({ email: { ...email, projectId: null } }))
      .toMatchObject({ state: "mismatch", destination: intakeDestination });
  });

  it("missing project cannot generate a dead navigation action", () => {
    expect(classify({ projectExists: false })).toMatchObject({ state: "mismatch", destination: null });
  });

  it("missing promoted target gives safe intake navigation", () => {
    expect(classify({ target: null })).toMatchObject({ state: "mismatch", destination: intakeDestination });
  });

  it.each([
    { id: 999 },
    { kind: "invoice" },
    { projectId: 99 },
    { sourceIntakeDocumentId: 79 },
  ])("rejects target identity discrepancy %j", (change) => {
    expect(classify({ target: { ...target, ...change } }))
      .toMatchObject({ state: "mismatch", destination: intakeDestination });
  });

  it("accepts legacy nullable target provenance when the authoritative intake pointer agrees", () => {
    expect(classify({ target: { ...target, sourceIntakeDocumentId: null } })).toMatchObject({ state: "filed" });
  });

  it.each([
    { promotedKind: null },
    { promotedId: null },
    { routingState: "parked" },
    { promotedKind: "unknown_kind" },
  ])("rejects incomplete or unverifiable promotion %j", (change) => {
    expect(classify({ intake: { ...intake, ...change } }))
      .toMatchObject({ state: "mismatch", destination: intakeDestination, isActive: false });
  });

  it("does not offer intake navigation for the wrong source email identity", () => {
    expect(classify({ intake: { ...intake, sourceEmailDocumentId: 897 } }))
      .toMatchObject({ state: "mismatch", destination: null });
  });

  it.each(["situation", "marche_document"])("verifies %s without inventing an exact-record URL", (kind) => {
    expect(classify({
      intake: { ...intake, promotedKind: kind },
      target: { ...target, kind },
    })).toMatchObject({ state: "filed", destination: intakeDestination });
  });
});