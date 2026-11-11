import { describe, expect, it } from "vitest";
import { matchesEmailDocumentFilters } from "../email-document-filters";

const doc = {
  extractionStatus: "financial_excluded",
  projectId: null,
  documentType: "unknown",
  attachmentFileName: "Devis_DV261082.pdf",
  emailSubject: "Quotation",
  emailFrom: "supplier@example.test",
};

describe("email document filters", () => {
  it.each([
    "pending", "processing", "completed", "needs_review", "failed",
    "financial_excluded", "financial_identity_review", "financial_unreadable",
    "unmatched_sender", "low_relevance", "archived_project_candidate",
  ])("finds %s documents in all statuses", extractionStatus => {
    expect(matchesEmailDocumentFilters({ ...doc, extractionStatus }, "all_statuses", "all", "dv261082")).toBe(true);
  });
  it("preserves the focused financial default", () => {
    expect(matchesEmailDocumentFilters(doc, "all", "all", "")).toBe(false);
    expect(matchesEmailDocumentFilters({ ...doc, extractionStatus: "completed" }, "all", "all", "")).toBe(true);
  });
  it("includes removed documents only when explicitly requested", () => {
    const removed = { ...doc, extractionStatus: "skipped" };
    expect(matchesEmailDocumentFilters(removed, "all_statuses", "all", "")).toBe(false);
    expect(matchesEmailDocumentFilters(removed, "all_statuses", "all", "", true)).toBe(true);
    expect(matchesEmailDocumentFilters(removed, "skipped", "all", "")).toBe(true);
    expect(matchesEmailDocumentFilters(removed, "all", "all", "", true)).toBe(false);
  });
  it("keeps type and search filters active", () => {
    expect(matchesEmailDocumentFilters(doc, "all_statuses", "invoice", "")).toBe(false);
    expect(matchesEmailDocumentFilters(doc, "all_statuses", "all", "missing")).toBe(false);
    expect(matchesEmailDocumentFilters(doc, "all_statuses", "unknown", " DV261082 ")).toBe(true);
  });
  it("preserves specific and actionable status filters", () => {
    expect(matchesEmailDocumentFilters(doc, "financial_excluded", "all", "")).toBe(true);
    expect(matchesEmailDocumentFilters(doc, "pending", "all", "")).toBe(false);
    expect(matchesEmailDocumentFilters({ ...doc, extractionStatus: "failed" }, "needs_attention", "all", "")).toBe(true);
    expect(matchesEmailDocumentFilters({ ...doc, extractionStatus: "needs_review" }, "needs_project", "all", "")).toBe(true);
    expect(matchesEmailDocumentFilters({ ...doc, extractionStatus: "needs_review", projectId: 12 }, "needs_project", "all", "")).toBe(false);
  });
});
