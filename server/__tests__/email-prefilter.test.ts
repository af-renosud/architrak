/**
 * Task #323 — deterministic sender/subject pre-filter that gates AI
 * extraction. Unknown senders with no project/contractor signal must be
 * parked without an AI call; anything with a plausible signal passes.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateEmailPrefilter,
  extractSenderEmail,
  type PrefilterContext,
} from "../gmail/email-prefilter";

const ctx: PrefilterContext = {
  contractors: [
    { id: 1, name: "AT Travaux", email: "contact@at-travaux.fr", website: "https://www.at-travaux.fr" },
    { id: 2, name: "Plomberie Dupont", email: "jean.dupont@gmail.com", website: null },
  ] as PrefilterContext["contractors"],
  projects: [
    {
      id: 10,
      name: "Villa Beaulieu",
      clientName: "Famille Martin",
      clientContactName: "Sophie Martin",
      clientContactEmail: "sophie.martin@clientcorp.com",
    },
  ] as PrefilterContext["projects"],
  knownEmails: ["architecte@cabinet-arch.fr"],
};

const base = { emailFrom: null, emailSubject: null, attachmentFileName: null };

describe("extractSenderEmail", () => {
  it("parses angle-bracketed From headers", () => {
    expect(extractSenderEmail('"AT Travaux" <Contact@AT-Travaux.fr>')).toBe("contact@at-travaux.fr");
  });
  it("parses bare addresses", () => {
    expect(extractSenderEmail("foo@bar.com")).toBe("foo@bar.com");
    expect(extractSenderEmail("Newsletter Weekly")).toBeNull();
  });
});

describe("evaluateEmailPrefilter", () => {
  it("passes when a project or contractor is already assigned", () => {
    expect(evaluateEmailPrefilter({ ...base, projectId: 10 }, ctx).pass).toBe(true);
    expect(evaluateEmailPrefilter({ ...base, contractorId: 2 }, ctx).pass).toBe(true);
  });

  it("passes on exact known sender address (even freemail)", () => {
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "Jean Dupont <jean.dupont@gmail.com>", emailSubject: "Re:" },
      ctx,
    );
    expect(r.pass).toBe(true);
  });

  it("passes on known contractor domain (email + website)", () => {
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "compta@at-travaux.fr", emailSubject: "hello" }, ctx).pass).toBe(true);
  });

  it("passes on client contact domain", () => {
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "billing@clientcorp.com", emailSubject: "" }, ctx).pass).toBe(true);
  });

  it("does NOT whitelist all of gmail because one contractor uses gmail", () => {
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "random.spammer@gmail.com", emailSubject: "You won a prize" },
      ctx,
    );
    expect(r.pass).toBe(false);
  });

  it("passes on project/client/contractor name in subject (accent-insensitive)", () => {
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "Chiffrage villa beaulieu étage" }, ctx).pass).toBe(true);
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "Dossier FAMILLE MARTIN" }, ctx).pass).toBe(true);
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "PJ", attachmentFileName: "AT-TRAVAUX offre.pdf" }, ctx).pass).toBe(true);
  });

  it("passes on construction-document keywords in subject or filename", () => {
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "Votre devis n°123" }, ctx).pass).toBe(true);
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "doc", attachmentFileName: "facture_2026.pdf" }, ctx).pass).toBe(true);
  });

  it("parks unknown senders with no signal, with an explanatory reason", () => {
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "newsletter@shopping-deals.com", emailSubject: "Weekly deals inside!", attachmentFileName: "catalogue.pdf" },
      ctx,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("newsletter@shopping-deals.com");
  });

  it("ignores too-short names to avoid substring false positives", () => {
    const shortCtx: PrefilterContext = {
      contractors: [{ id: 3, name: "SA", email: null, website: null }] as PrefilterContext["contractors"],
      projects: [],
    };
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "a@b.io", emailSubject: "sa promotion" }, shortCtx).pass).toBe(false);
  });
});
