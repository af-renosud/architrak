/**
 * Task #323 — cheap deterministic pre-filter that runs BEFORE any AI vision
 * extraction. The Gmail monitor captures every email with a PDF attachment;
 * previously each one burned a full AI extraction even when the sender had
 * nothing to do with any client project (newsletters, receipts, spam).
 *
 * A document passes when at least ONE deterministic signal ties it to the
 * business:
 *   - it was already assigned a project or contractor (operator rescue path);
 *   - the sender's exact email matches a known contractor email, a project's
 *     client contact email, or a linked architect inbox;
 *   - the sender's domain matches a known contractor/client domain
 *     (freemail domains like gmail.com are excluded from domain-level
 *     matching — one gmail contact must not whitelist all of Gmail);
 *   - the subject or attachment filename mentions a known project name,
 *     client name, or contractor name;
 *   - the subject or filename carries a French construction-document keyword
 *     (devis, facture, situation, avenant, …) — deliberately generous so a
 *     brand-new contractor's very first devis is never dropped.
 *
 * Failing documents are parked in extraction_status='unmatched_sender'
 * WITHOUT any AI call. They stay visible in the email queue where an
 * operator can assign a project or force a re-analysis (no silent loss).
 */
import type { Contractor, Project } from "@shared/schema";

export const UNMATCHED_SENDER_STATUS = "unmatched_sender";

export interface PrefilterInput {
  emailFrom: string | null;
  emailSubject: string | null;
  attachmentFileName?: string | null;
  projectId?: number | null;
  contractorId?: number | null;
}

export interface PrefilterContext {
  contractors: Pick<Contractor, "id" | "name" | "email" | "website">[];
  projects: Pick<Project, "id" | "name" | "clientName" | "clientContactName" | "clientContactEmail">[];
  /** Linked architect inbox addresses (forward-to-self is a valid signal). */
  knownEmails?: (string | null | undefined)[];
  /**
   * Task #425 — the firm's own identity. The firm's outbound honoraires
   * invoices (facture d'honoraires) must reach AI classification even when
   * the sender is unknown and the subject/filename carries no construction
   * keyword: mail from a firm domain, or mentioning a firm legal name,
   * always passes the prefilter (the deterministic issuer gate downstream
   * decides what the document actually is).
   */
  firm?: {
    legalNames: string[];
    domains: string[];
  };
}

export interface PrefilterResult {
  pass: boolean;
  /** Human-readable explanation, stored in notes when the doc is parked. */
  reason: string;
}

// Personal/free mail providers: a contractor with a gmail.com address must
// not cause EVERY gmail.com sender to pass the domain check. Exact-address
// matching still works for these.
const FREEMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.fr", "hotmail.com",
  "hotmail.fr", "outlook.com", "outlook.fr", "live.com", "live.fr",
  "msn.com", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr", "neuf.fr",
  "laposte.net", "icloud.com", "me.com", "aol.com", "protonmail.com",
  "proton.me", "gmx.com", "gmx.fr", "bbox.fr", "numericable.fr",
]);

// French construction-document vocabulary. Single tokens are matched as
// whole words; multi-word phrases as normalized substrings.
const DOC_KEYWORDS = [
  "devis", "facture", "facturation", "proforma", "situation", "avenant",
  "acompte", "marche", "chantier", "travaux", "dpgf", "cctp", "dgd",
  "decompte", "attestation", "quitus", "retenue de garantie", "honoraires",
  "appel d offre", "situation de travaux", "bon de commande",
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Extract the bare address from a From header like `Name <a@b.c>`. */
export function extractSenderEmail(from: string | null | undefined): string | null {
  if (!from) return null;
  const angled = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const raw = angled ? angled[1] : from.trim();
  const m = raw.match(/[^\s"'<>,;]+@[^\s"'<>,;]+/);
  return m ? m[0].toLowerCase() : null;
}

function domainOf(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim() || null;
}

function websiteDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  const cleaned = website.trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  return cleaned.includes(".") ? cleaned : null;
}

export function evaluateEmailPrefilter(
  input: PrefilterInput,
  ctx: PrefilterContext,
): PrefilterResult {
  // Operator already tied the doc to the business — always pass.
  if (input.projectId != null) {
    return { pass: true, reason: "project already assigned" };
  }
  if (input.contractorId != null) {
    return { pass: true, reason: "contractor already assigned" };
  }

  const senderEmail = extractSenderEmail(input.emailFrom);
  const senderDomain = domainOf(senderEmail);

  // ── Signal 1: exact sender address ─────────────────────────────────────
  const knownAddresses = new Set<string>();
  for (const c of ctx.contractors) {
    const e = extractSenderEmail(c.email ?? null);
    if (e) knownAddresses.add(e);
  }
  for (const p of ctx.projects) {
    const e = extractSenderEmail(p.clientContactEmail ?? null);
    if (e) knownAddresses.add(e);
  }
  for (const e of ctx.knownEmails ?? []) {
    const norm = extractSenderEmail(e ?? null);
    if (norm) knownAddresses.add(norm);
  }
  if (senderEmail && knownAddresses.has(senderEmail)) {
    return { pass: true, reason: `sender ${senderEmail} is a known contact` };
  }

  // ── Signal 1b (Task #425): firm's own mail domain ──────────────────────
  // The firm forwarding/bcc'ing its own fee invoices is a first-class
  // signal — never park mail from the firm's own domain(s).
  if (senderDomain && ctx.firm?.domains.some((d) => d.toLowerCase() === senderDomain)) {
    return { pass: true, reason: `sender domain ${senderDomain} is the firm's own domain` };
  }

  // ── Signal 2: sender domain (non-freemail only) ────────────────────────
  if (senderDomain && !FREEMAIL_DOMAINS.has(senderDomain)) {
    const knownDomains = new Set<string>();
    for (const addr of Array.from(knownAddresses)) {
      const d = domainOf(addr);
      if (d && !FREEMAIL_DOMAINS.has(d)) knownDomains.add(d);
    }
    for (const c of ctx.contractors) {
      const d = websiteDomain(c.website);
      if (d && !FREEMAIL_DOMAINS.has(d)) knownDomains.add(d);
    }
    if (knownDomains.has(senderDomain)) {
      return { pass: true, reason: `sender domain ${senderDomain} matches a known contact domain` };
    }
  }

  // ── Signal 3: project / client / contractor name in subject or filename ─
  const haystack = normalize(
    `${input.emailSubject ?? ""} ${input.attachmentFileName ?? ""}`,
  );
  if (haystack) {
    const candidates: { label: string; value: string | null | undefined }[] = [];
    for (const p of ctx.projects) {
      candidates.push({ label: "project", value: p.name });
      candidates.push({ label: "client", value: p.clientName });
      candidates.push({ label: "client contact", value: p.clientContactName });
    }
    for (const c of ctx.contractors) {
      candidates.push({ label: "contractor", value: c.name });
    }
    // Task #425 — the firm's own legal name on a subject/filename (e.g.
    // "Facture-…-ARCHITECTS-FRANCE-F-2026-138.pdf") is a valid signal.
    for (const n of ctx.firm?.legalNames ?? []) {
      candidates.push({ label: "firm", value: n });
    }
    const padded = ` ${haystack} `;
    for (const cand of candidates) {
      if (!cand.value) continue;
      const norm = normalize(cand.value);
      // Too-short names (e.g. "SA", "BAT") would false-positive constantly.
      if (norm.replace(/\s+/g, "").length < 4) continue;
      if (padded.includes(` ${norm} `)) {
        return { pass: true, reason: `subject/filename mentions ${cand.label} "${cand.value}"` };
      }
    }

    // ── Signal 4: construction-document keywords ─────────────────────────
    const tokens = new Set(haystack.split(" "));
    for (const kw of DOC_KEYWORDS) {
      const hit = kw.includes(" ") ? haystack.includes(kw) : tokens.has(kw);
      if (hit) {
        return { pass: true, reason: `subject/filename contains keyword "${kw}"` };
      }
    }
  }

  return {
    pass: false,
    reason: senderEmail
      ? `Expéditeur inconnu (${senderEmail}) — aucun lien avec un intervenant, un client ou un projet, et aucun mot-clé de document de chantier dans le sujet ou le nom de fichier. Extraction IA non lancée.`
      : "Expéditeur illisible — aucun signal projet/intervenant détecté. Extraction IA non lancée.",
  };
}
