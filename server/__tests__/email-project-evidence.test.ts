/**
 * Task #531 — deterministic single-candidate project resolution: when the
 * AI matcher produced no project, unambiguous capture evidence (client-
 * contact sender or a subject/filename mentioning exactly ONE live project)
 * auto-assigns it; ambiguous evidence assigns nothing.
 */
import { describe, it, expect } from "vitest";
import { resolveUniqueProjectEvidence, type PrefilterContext } from "../gmail/email-prefilter";

const projects = [
  {
    id: 10,
    name: "Villa Beaulieu",
    clientName: "Famille Martin",
    clientContactName: "Sophie Martin",
    clientContactEmail: "sophie.martin@clientcorp.com",
  },
  {
    id: 11,
    name: "Featherstone Lot 40",
    clientName: "M. Featherstone",
    clientContactName: "John Featherstone",
    clientContactEmail: "john@featherstone.co.uk",
  },
] as PrefilterContext["projects"];

describe("resolveUniqueProjectEvidence", () => {
  it("assigns when the sender is the client contact of exactly one live project", () => {
    const r = resolveUniqueProjectEvidence(
      { emailFrom: "Sophie <SOPHIE.MARTIN@clientcorp.com>", emailSubject: "pj", attachmentFileName: "doc.pdf" },
      projects,
    );
    expect(r?.projectId).toBe(10);
    expect(r?.reason).toContain("client contact");
  });

  it("assigns when the subject/filename mentions exactly one live project", () => {
    const r = resolveUniqueProjectEvidence(
      { emailFrom: "x@unknown.io", emailSubject: "Devis volets", attachmentFileName: "DEVIS FEATHERSTONE POMPE.pdf" },
      projects,
    );
    expect(r?.projectId).toBe(11);
  });

  it("assigns nothing when several live projects are mentioned", () => {
    const r = resolveUniqueProjectEvidence(
      { emailFrom: "x@unknown.io", emailSubject: "Villa Beaulieu + Featherstone Lot 40 récap", attachmentFileName: null },
      projects,
    );
    expect(r).toBeNull();
  });

  it("assigns nothing when the same contact address is on two live projects", () => {
    const dup = [
      ...projects,
      { ...projects[0], id: 12, name: "Villa Beaulieu Phase 2" },
    ] as PrefilterContext["projects"];
    const r = resolveUniqueProjectEvidence(
      { emailFrom: "sophie.martin@clientcorp.com", emailSubject: null, attachmentFileName: null },
      dup,
    );
    // Contact evidence ambiguous; name evidence also ambiguous (both phases
    // share client names) → nothing.
    expect(r).toBeNull();
  });

  it("assigns nothing when the client-contact sender conflicts with a filename naming another project", () => {
    const r = resolveUniqueProjectEvidence(
      { emailFrom: "sophie.martin@clientcorp.com", emailSubject: "pj", attachmentFileName: "DEVIS FEATHERSTONE.pdf" },
      projects,
    );
    expect(r).toBeNull();
  });

  it("assigns nothing with no evidence at all", () => {
    expect(
      resolveUniqueProjectEvidence({ emailFrom: "x@unknown.io", emailSubject: "hello", attachmentFileName: "a.pdf" }, projects),
    ).toBeNull();
  });
});
