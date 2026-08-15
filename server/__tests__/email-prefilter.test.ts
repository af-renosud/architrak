/**
 * Task #323 — deterministic sender/subject pre-filter that gates AI
 * extraction. Unknown senders with no project/contractor signal must be
 * parked without an AI call; anything with a plausible signal passes.
 */
import { describe, it, expect } from "vitest";
import {
  evaluateEmailPrefilter,
  extractSenderEmail,
  tierToExtractionStatus,
  buildTargetedGmailQueries,
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
  firm: {
    legalNames: ["SAS ARCHITECTS-FRANCE", "ARCHITECTS-FRANCE"],
    domains: ["renosud.com"],
  },
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
  it("passes mail from the firm's own domain even with no other signal (Task #425)", () => {
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "Compta <compta@renosud.com>", emailSubject: "Document", attachmentFileName: "piece.pdf" },
      ctx,
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toContain("firm's own domain");
  });

  it("passes when the filename mentions a firm legal name (Task #425)", () => {
    const r = evaluateEmailPrefilter(
      {
        ...base,
        emailFrom: "someone@unknown-sender.xyz",
        emailSubject: "fwd",
        attachmentFileName: "F-2026-138 ARCHITECTS-FRANCE.pdf",
      },
      ctx,
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toContain("firm");
  });

  it("still parks unknown senders when no firm context is provided", () => {
    const noFirm = { ...ctx, firm: undefined };
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "someone@unknown-sender.xyz", emailSubject: "hello", attachmentFileName: "doc.pdf" },
      noFirm,
    );
    expect(r.pass).toBe(false);
  });

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

  it("demotes construction-document keywords with no identity evidence to LOW tier (Task #503)", () => {
    const r1 = evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "Votre devis n°123" }, ctx);
    expect(r1.pass).toBe(false);
    expect(r1.tier).toBe("low");
    expect(tierToExtractionStatus(r1.tier)).toBe("low_relevance");
    const r2 = evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "doc", attachmentFileName: "facture_2026.pdf" }, ctx);
    expect(r2.tier).toBe("low");
    expect(r2.reason).toContain("facture");
  });

  it("keyword + known identity evidence still passes high (keyword recognition unchanged)", () => {
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "compta@at-travaux.fr", emailSubject: "Facture TTC" },
      ctx,
    );
    expect(r.tier).toBe("high");
    expect(r.pass).toBe(true);
  });

  it("parks unknown senders with no signal, with an explanatory reason", () => {
    const r = evaluateEmailPrefilter(
      { ...base, emailFrom: "newsletter@shopping-deals.com", emailSubject: "Weekly deals inside!", attachmentFileName: "catalogue.pdf" },
      ctx,
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("newsletter@shopping-deals.com");
  });

  it("quarantines archived-project-only evidence as tier 'archived' (Task #503)", () => {
    const archCtx: PrefilterContext = {
      ...ctx,
      archivedProjects: [
        {
          id: 99,
          name: "Chalet Ancien",
          clientName: "Famille Durand",
          clientContactName: "Paul Durand",
          clientContactEmail: "paul.durand@oldclient.org",
        },
      ] as PrefilterContext["archivedProjects"],
    };
    // exact archived contact address
    const byEmail = evaluateEmailPrefilter({ ...base, emailFrom: "paul.durand@oldclient.org", emailSubject: "hello" }, archCtx);
    expect(byEmail.tier).toBe("archived");
    expect(byEmail.pass).toBe(false);
    expect(tierToExtractionStatus(byEmail.tier)).toBe("archived_project_candidate");
    // archived project name in subject
    const byName = evaluateEmailPrefilter({ ...base, emailFrom: "x@unknown.io", emailSubject: "Solde chalet ancien" }, archCtx);
    expect(byName.tier).toBe("archived");
    // archived contact domain (non-freemail)
    const byDomain = evaluateEmailPrefilter({ ...base, emailFrom: "billing@oldclient.org", emailSubject: "" }, archCtx);
    expect(byDomain.tier).toBe("archived");
    // live evidence still wins over archived
    const live = evaluateEmailPrefilter({ ...base, emailFrom: "sophie.martin@clientcorp.com", emailSubject: "chalet ancien" }, archCtx);
    expect(live.tier).toBe("high");
  });

  it("archived evidence + keyword stays archived, keyword-only stays low, nothing stays unmatched", () => {
    const archCtx: PrefilterContext = {
      ...ctx,
      archivedProjects: [
        { id: 99, name: "Chalet Ancien", clientName: "Famille Durand", clientContactName: null, clientContactEmail: null },
      ] as PrefilterContext["archivedProjects"],
    };
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@u.io", emailSubject: "Facture chalet ancien" }, archCtx).tier).toBe("archived");
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@u.io", emailSubject: "Facture 123" }, archCtx).tier).toBe("low");
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "x@u.io", emailSubject: "Weekly deals" }, archCtx).tier).toBe("unmatched");
  });

  it("ignores too-short names to avoid substring false positives", () => {
    const shortCtx: PrefilterContext = {
      contractors: [{ id: 3, name: "SA", email: null, website: null }] as PrefilterContext["contractors"],
      projects: [],
    };
    expect(evaluateEmailPrefilter({ ...base, emailFrom: "a@b.io", emailSubject: "sa promotion" }, shortCtx).pass).toBe(false);
  });
});

describe("buildTargetedGmailQueries (Task #503)", () => {
  const base = 'has:attachment filename:pdf -label:ArchiTrak-Extracted';

  it("builds from: batches for known addresses and quoted phrases for live names", () => {
    const queries = buildTargetedGmailQueries(
      { contractors: ctx.contractors, projects: ctx.projects, knownEmails: [] },
      base,
    );
    expect(queries.length).toBeGreaterThanOrEqual(2);
    const fromQ = queries.find((q) => q.includes("from:("));
    expect(fromQ).toContain("contact@at-travaux.fr");
    expect(fromQ).toContain("sophie.martin@clientcorp.com");
    const nameQ = queries.find((q) => q.includes('"Villa Beaulieu"'));
    expect(nameQ).toBeDefined();
    expect(nameQ).toContain('"Famille Martin"');
    for (const q of queries) expect(q.startsWith(base)).toBe(true);
  });

  it("never emits generic keywords as positive selectors and sanitizes names", () => {
    const queries = buildTargetedGmailQueries(
      {
        contractors: [],
        projects: [
          { id: 1, name: 'Villa "Les (Pins)"', clientName: "Ab", clientContactName: null, clientContactEmail: null },
        ] as PrefilterContext["projects"],
        knownEmails: [],
      },
      base,
    );
    expect(queries.join(" ")).not.toMatch(/facture|devis|TTC|HT/);
    // quotes/parens stripped from the phrase, too-short "Ab" dropped
    expect(queries[0]).toContain('"Villa Les Pins"');
    expect(queries.join(" ")).not.toContain('"Ab"');
  });

  it("returns no queries when there is nothing distinctive to search for", () => {
    expect(buildTargetedGmailQueries({ contractors: [], projects: [], knownEmails: [] }, base)).toEqual([]);
  });

  it("never emits a query past the serialized character budget, even with long names", () => {
    const longProjects = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      name: `Résidence de la Grande Corniche des Alpes Maritimes tranche ${i + 1} lot spécial`,
      clientName: `Société Civile Immobilière du Boulevard de la Méditerranée numéro ${i + 1}`,
      clientContactName: null,
      clientContactEmail: `contact.long.address.number.${i + 1}@some-very-long-corporate-domain-name.example.com`,
    })) as PrefilterContext["projects"];
    const queries = buildTargetedGmailQueries({ contractors: [], projects: longProjects, knownEmails: [] }, base);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.length).toBeLessThanOrEqual(6);
    for (const q of queries) {
      expect(q.length).toBeLessThanOrEqual(700);
      expect(q.startsWith(base)).toBe(true);
    }
  });

  it("drops a single pathological term that alone exceeds the budget", () => {
    const queries = buildTargetedGmailQueries(
      {
        contractors: [],
        projects: [
          { id: 1, name: "x".repeat(900), clientName: "Famille Martin", clientContactName: null, clientContactEmail: null },
        ] as PrefilterContext["projects"],
        knownEmails: [],
      },
      base,
    );
    expect(queries.join(" ")).not.toContain("x".repeat(100));
    expect(queries.some((q) => q.includes('"Famille Martin"'))).toBe(true);
  });
});
