/**
 * Task #323 — cheap deterministic pre-filter that runs BEFORE any AI vision
 * extraction. The Gmail monitor captures every email with a PDF attachment;
 * previously each one burned a full AI extraction even when the sender had
 * nothing to do with any client project (newsletters, receipts, spam).
 *
 * Task #503 — evidence-TIERED relevance, anchored on the LIVE project list.
 * The old boolean pass promoted ANY generic construction keyword ("facture",
 * "devis", "TTC"…) to full AI extraction — essentially every French
 * invoice-like email — and archived projects still whitelisted senders.
 * The prefilter now returns a tier:
 *
 *   - `high`      — real identity evidence ties the email to the business:
 *                   assigned project/contractor (operator rescue), exact
 *                   known contractor / LIVE-project client-contact / linked
 *                   inbox address, the firm's own domain, a safe non-freemail
 *                   domain matching a known contact, or a subject/filename
 *                   mention of a LIVE project / client / contact / contractor
 *                   / firm legal name. → stored `pending`, AI runs as before.
 *   - `archived`  — the ONLY evidence points at an archived project (contact
 *                   email/domain or project/client/contact name). → stored
 *                   `archived_project_candidate`; no AI, rescuable, never
 *                   silently dropped (a late invoice for a just-archived
 *                   project stays visible in a collapsed bucket).
 *   - `low`       — generic construction-document keyword with NO identity
 *                   evidence. → stored `low_relevance`; no AI; collapsed
 *                   bucket; auto-expires after a retention window. Keeps a
 *                   brand-new contractor's very first devis rescuable
 *                   without flooding the queue.
 *   - `unmatched` — no signal at all. → `unmatched_sender` (as before).
 *
 * Contractors are never archived, so a contractor signal is always high.
 * Freemail domains never whitelist by domain (exact address still passes).
 */
import type { Contractor, Project } from "@shared/schema";

export const UNMATCHED_SENDER_STATUS = "unmatched_sender";
export const LOW_RELEVANCE_STATUS = "low_relevance";
export const ARCHIVED_CANDIDATE_STATUS = "archived_project_candidate";

export type PrefilterTier = "high" | "archived" | "low" | "unmatched";

/** Map a tier to the extraction_status the captured document should get. */
export function tierToExtractionStatus(tier: PrefilterTier): string {
  switch (tier) {
    case "high": return "pending";
    case "archived": return ARCHIVED_CANDIDATE_STATUS;
    case "low": return LOW_RELEVANCE_STATUS;
    default: return UNMATCHED_SENDER_STATUS;
  }
}

export interface PrefilterInput {
  emailFrom: string | null;
  emailSubject: string | null;
  attachmentFileName?: string | null;
  projectId?: number | null;
  contractorId?: number | null;
}

type PrefilterProject = Pick<Project, "id" | "name" | "clientName" | "clientContactName" | "clientContactEmail">;

export interface PrefilterContext {
  contractors: Pick<Contractor, "id" | "name" | "email" | "website">[];
  /** LIVE (non-archived) projects only — these grant high-tier evidence. */
  projects: PrefilterProject[];
  /**
   * Task #503 — archived projects. Their identity data never grants high
   * tier; a match here yields tier `archived` (quarantined, rescuable).
   */
  archivedProjects?: PrefilterProject[];
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
  /** true only for tier `high` — kept for existing callers/tests. */
  pass: boolean;
  tier: PrefilterTier;
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
// Task #503 — recognition unchanged, but a keyword alone is now LOW tier
// (no AI) instead of a full pass: any French invoice says "facture TTC HT".
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

/** Name candidates from a set of projects (project/client/contact names). */
function projectNameCandidates(projects: PrefilterProject[]): { label: string; value: string | null | undefined }[] {
  const out: { label: string; value: string | null | undefined }[] = [];
  for (const p of projects) {
    out.push({ label: "project", value: p.name });
    out.push({ label: "client", value: p.clientName });
    out.push({ label: "client contact", value: p.clientContactName });
  }
  return out;
}

function findNameMention(
  haystackPadded: string,
  candidates: { label: string; value: string | null | undefined }[],
): { label: string; value: string } | null {
  for (const cand of candidates) {
    if (!cand.value) continue;
    const norm = normalize(cand.value);
    // Too-short names (e.g. "SA", "BAT") would false-positive constantly.
    if (norm.replace(/\s+/g, "").length < 4) continue;
    if (haystackPadded.includes(` ${norm} `)) {
      return { label: cand.label, value: cand.value };
    }
  }
  return null;
}

// Task #531 — self-echo suppression. The app's own outbound mail comes back
// through the monitored inbox as "new" documents: signature-envelope
// confirmations (Docusign/Archisign), PDF-service receipts (DocRaptor), and
// re-sends of app-generated files. These are echoes of documents the app
// already holds, so they park as low relevance (rescuable) instead of
// burning AI extraction and cluttering the queue.
const SERVICE_ECHO_DOMAINS = ["docusign.net", "docusign.com", "docraptor.com"];
// Normalized markers that only appear on app-generated artifacts.
const APP_ECHO_MARKERS = [
  "electronic signature request",
  "demande de signature electronique",
  "archidoc proposal",
];

function matchesServiceDomain(senderDomain: string | null): string | null {
  if (!senderDomain) return null;
  for (const d of SERVICE_ECHO_DOMAINS) {
    if (senderDomain === d || senderDomain.endsWith(`.${d}`)) return d;
  }
  return null;
}

export function evaluateEmailPrefilter(
  input: PrefilterInput,
  ctx: PrefilterContext,
): PrefilterResult {
  const high = (reason: string): PrefilterResult => ({ pass: true, tier: "high", reason });

  // Operator already tied the doc to the business — always pass.
  if (input.projectId != null) {
    return high("project already assigned");
  }
  if (input.contractorId != null) {
    return high("contractor already assigned");
  }

  const senderEmail = extractSenderEmail(input.emailFrom);
  const senderDomain = domainOf(senderEmail);

  // ── Signal 0 (Task #531): self-echo suppression ─────────────────────────
  // Checked before any identity signal: a Docusign envelope confirmation or
  // a re-send of an app-generated file is an echo even when it mentions a
  // live project. Content dedupe upstream already collapses byte-identical
  // copies; this catches the service-generated variants (signed envelope
  // PDFs, receipts).
  const echoHaystack = normalize(
    `${input.emailSubject ?? ""} ${input.attachmentFileName ?? ""}`,
  );
  const serviceDomainHit = matchesServiceDomain(senderDomain);
  if (serviceDomainHit) {
    return {
      pass: false, tier: "low",
      reason: `Expéditeur de service (${serviceDomainHit}) — écho d'un envoi de l'application (enveloppe de signature / reçu de service), document déjà conservé par l'application. Analyse IA non lancée (récupérable manuellement).`,
    };
  }
  const echoMarker = APP_ECHO_MARKERS.find((m) => echoHaystack.includes(m));
  if (echoMarker) {
    return {
      pass: false, tier: "low",
      reason: `Sujet/fichier généré par l'application (« ${echoMarker} ») — écho d'un envoi de l'application, document déjà conservé. Analyse IA non lancée (récupérable manuellement).`,
    };
  }

  // ── Signal 1: exact sender address (live evidence only) ────────────────
  // Task #531 — the firm's own linked inbox addresses are handled separately
  // below: mail from ourselves needs document evidence (keyword or live-name
  // mention) to pass, otherwise internal working files flood the queue.
  const selfAddresses = new Set<string>();
  for (const e of ctx.knownEmails ?? []) {
    const norm = extractSenderEmail(e ?? null);
    if (norm) selfAddresses.add(norm);
  }
  const knownAddresses = new Set<string>();
  for (const c of ctx.contractors) {
    const e = extractSenderEmail(c.email ?? null);
    if (e) knownAddresses.add(e);
  }
  for (const p of ctx.projects) {
    const e = extractSenderEmail(p.clientContactEmail ?? null);
    if (e) knownAddresses.add(e);
  }
  for (const e of Array.from(selfAddresses)) knownAddresses.add(e);
  const senderIsSelf = senderEmail != null && selfAddresses.has(senderEmail);
  if (senderEmail && knownAddresses.has(senderEmail) && !senderIsSelf) {
    return high(`sender ${senderEmail} is a known contact`);
  }

  // Archived-project contact addresses — collected separately so they can
  // NEVER grant high tier (Task #503).
  const archivedAddresses = new Set<string>();
  for (const p of ctx.archivedProjects ?? []) {
    const e = extractSenderEmail(p.clientContactEmail ?? null);
    if (e && !knownAddresses.has(e)) archivedAddresses.add(e);
  }

  // ── Signal 3/4 precompute: name mentions + document keywords ────────────
  // Computed early because the firm/self gate below (Task #531) needs them.
  const haystack = echoHaystack;
  let liveHit: { label: string; value: string } | null = null;
  let archivedNameHit: { label: string; value: string } | null = null;
  let keywordHit: string | null = null;
  if (haystack) {
    const padded = ` ${haystack} `;
    const liveCandidates = projectNameCandidates(ctx.projects);
    for (const c of ctx.contractors) {
      liveCandidates.push({ label: "contractor", value: c.name });
    }
    // Task #425 — the firm's own legal name on a subject/filename (e.g.
    // "Facture-…-ARCHITECTS-FRANCE-F-2026-138.pdf") is a valid signal.
    for (const n of ctx.firm?.legalNames ?? []) {
      liveCandidates.push({ label: "firm", value: n });
    }
    liveHit = findNameMention(padded, liveCandidates);
    archivedNameHit = findNameMention(padded, projectNameCandidates(ctx.archivedProjects ?? []));

    const tokens = new Set(haystack.split(" "));
    for (const kw of DOC_KEYWORDS) {
      const hit = kw.includes(" ") ? haystack.includes(kw) : tokens.has(kw);
      if (hit) { keywordHit = kw; break; }
    }
  }

  // ── Signal 1b (Task #425, tightened by #531) ────────────────────────────
  // The LINKED INBOX's own address is where the app's echoes and internal
  // working files come from: mail from ourselves needs document evidence
  // (keyword or live-name mention) to pass; with none it parks as internal
  // mail (rescuable). Checked BEFORE the firm-domain allowance so self mail
  // never rides the unconditional firm pass.
  if (senderIsSelf) {
    if (liveHit) {
      return high(`firm-origin mail; subject/filename mentions ${liveHit.label} "${liveHit.value}"`);
    }
    if (keywordHit) {
      return high(`firm-origin mail with document keyword "${keywordHit}"`);
    }
    return {
      pass: false, tier: "low",
      reason: `Courrier interne (${senderEmail ?? senderDomain}) sans mot-clé de document ni mention d'un projet actif — probablement un fichier de travail ou un écho d'envoi. Analyse IA non lancée (récupérable manuellement).`,
    };
  }
  // Task #425 — other firm-domain senders (e.g. compta@) stay a first-class
  // signal: the firm's outbound honoraires invoices must reach AI
  // classification even with no keyword or name mention.
  if (senderDomain && ctx.firm?.domains.some((d) => d.toLowerCase() === senderDomain)) {
    return high(`sender domain ${senderDomain} is the firm's own domain`);
  }

  // ── Signal 2: sender domain (non-freemail only) ────────────────────────
  let archivedDomainHit = false;
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
      return high(`sender domain ${senderDomain} matches a known contact domain`);
    }
    for (const addr of Array.from(archivedAddresses)) {
      const d = domainOf(addr);
      if (d && !FREEMAIL_DOMAINS.has(d) && d === senderDomain) archivedDomainHit = true;
    }
  }

  // ── Signal 3: name mentions in subject or filename (precomputed) ───────
  if (liveHit) {
    return high(`subject/filename mentions ${liveHit.label} "${liveHit.value}"`);
  }

  // ── Archived-only evidence → quarantine, never high, never dropped ─────
  if (senderEmail && archivedAddresses.has(senderEmail)) {
    return {
      pass: false, tier: "archived",
      reason: `Expéditeur ${senderEmail} : contact d'un projet archivé — document mis de côté (projet clos), récupérable manuellement.`,
    };
  }
  if (archivedDomainHit) {
    return {
      pass: false, tier: "archived",
      reason: `Domaine ${senderDomain} : contact d'un projet archivé — document mis de côté (projet clos), récupérable manuellement.`,
    };
  }
  if (archivedNameHit) {
    return {
      pass: false, tier: "archived",
      reason: `Sujet/fichier mentionne ${archivedNameHit.label === "project" ? "le projet archivé" : "un client de projet archivé"} « ${archivedNameHit.value} » — document mis de côté (projet clos), récupérable manuellement.`,
    };
  }

  // ── Generic keyword with no identity evidence → LOW relevance ──────────
  if (keywordHit) {
    return {
      pass: false, tier: "low",
      reason: `Mot-clé générique « ${keywordHit} » sans lien identifié avec un client, un projet actif ou un intervenant connu — pertinence faible, analyse IA non lancée (récupérable manuellement).`,
    };
  }

  return {
    pass: false,
    tier: "unmatched",
    reason: senderEmail
      ? `Expéditeur inconnu (${senderEmail}) — aucun lien avec un intervenant, un client ou un projet, et aucun mot-clé de document de chantier dans le sujet ou le nom de fichier. Extraction IA non lancée.`
      : "Expéditeur illisible — aucun signal projet/intervenant détecté. Extraction IA non lancée.",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Task #531 — deterministic single-candidate project resolution. Used at
// processing time as a fallback when AI-based matching produced no project:
// if the capture evidence (sender = client contact of exactly one live
// project, or subject/filename mentioning exactly one live project) is
// unambiguous, assign that project; ambiguous evidence assigns nothing.
// ─────────────────────────────────────────────────────────────────────────

export function resolveUniqueProjectEvidence(
  input: Pick<PrefilterInput, "emailFrom" | "emailSubject" | "attachmentFileName">,
  liveProjects: PrefilterProject[],
): { projectId: number; reason: string } | null {
  const senderEmail = extractSenderEmail(input.emailFrom);

  // Evidence A: sender is the client contact of a live project.
  const byContact = senderEmail
    ? liveProjects.filter(
        (p) => extractSenderEmail(p.clientContactEmail ?? null) === senderEmail,
      )
    : [];

  // Evidence B: subject/filename mentions of live projects. Full
  // name/client/contact mentions count, and so do DISTINCTIVE single tokens
  // (≥5 letters, not a construction keyword) from those names — real
  // filenames say "DEVIS FEATHERSTONE POMPE", not "Featherstone Lot 40".
  // Safety comes from the uniqueness requirement: a token shared by two
  // live projects resolves nothing.
  const haystack = normalize(
    `${input.emailSubject ?? ""} ${input.attachmentFileName ?? ""}`,
  );
  const padded = ` ${haystack} `;
  const haystackTokens = new Set(haystack.split(" "));
  const mentioned = new Map<number, { project: PrefilterProject; hit: { label: string; value: string } }>();
  for (const p of haystack ? liveProjects : []) {
    let hit = findNameMention(padded, projectNameCandidates([p]));
    if (!hit) {
      outer: for (const cand of projectNameCandidates([p])) {
        if (!cand.value) continue;
        for (const token of normalize(cand.value).split(" ")) {
          if (token.length < 5) continue;
          if (DOC_KEYWORDS.includes(token)) continue;
          if (haystackTokens.has(token)) {
            hit = { label: cand.label, value: cand.value };
            break outer;
          }
        }
      }
    }
    if (hit) mentioned.set(p.id, { project: p, hit });
  }
  // Combine BOTH signals: the union of contact-based and mention-based
  // candidates must point at exactly ONE project. A client-contact sender
  // whose attachment names a different project is a conflict → nothing.
  const combined = new Set<number>([
    ...byContact.map((p) => p.id),
    ...Array.from(mentioned.keys()),
  ]);
  if (combined.size !== 1) return null;
  const projectId = Array.from(combined)[0];
  if (byContact.length === 1 && byContact[0].id === projectId) {
    return {
      projectId,
      reason: `sender ${senderEmail} is the client contact of project "${byContact[0].name}"`,
    };
  }
  const only = mentioned.get(projectId)!;
  return {
    projectId,
    reason: `subject/filename mentions ${only.hit.label} "${only.hit.value}" of project "${only.project.name}" (only live candidate)`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Task #503 — targeted Gmail query batches. Built from LIVE, distinctive
// identity signals only (known sender addresses + live project/client
// names). Generic words like "facture"/"TTC"/"HT" are NEVER used alone as
// a Gmail positive selector — they don't establish relevance. These batches
// run BEFORE the broad backstop query so high-confidence mail is captured
// first; the broad query remains the completeness/audit backstop.
// ─────────────────────────────────────────────────────────────────────────

const MAX_FROM_PER_QUERY = 20;
const MAX_NAMES_PER_QUERY = 8;
const MAX_TARGETED_QUERIES = 6;
// Conservative serialized-length budget per Gmail search string — names and
// addresses are unconstrained text, so item-count caps alone are not enough.
const MAX_QUERY_CHARS = 700;

/** Sanitize a name for use as a quoted Gmail phrase; null if unusable. */
function gmailPhrase(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.replace(/\s/g, "").length < 4) return null;
  return `"${cleaned}"`;
}

export function buildTargetedGmailQueries(
  ctx: Pick<PrefilterContext, "contractors" | "projects" | "knownEmails">,
  baseQuery: string,
): string[] {
  const addresses = new Set<string>();
  for (const c of ctx.contractors) {
    const e = extractSenderEmail(c.email ?? null);
    if (e) addresses.add(e);
  }
  for (const p of ctx.projects) {
    const e = extractSenderEmail(p.clientContactEmail ?? null);
    if (e) addresses.add(e);
  }

  const phrases = new Set<string>();
  for (const p of ctx.projects) {
    for (const v of [p.name, p.clientName, p.clientContactName]) {
      const ph = gmailPhrase(v);
      if (ph) phrases.add(ph);
    }
  }

  const queries: string[] = [];

  // Chunk by BOTH item count and serialized character budget — client and
  // project names are unconstrained text, so a count-only cap could still
  // produce a query past Gmail's search-string limit. Overflowing terms
  // roll into the next batch; anything beyond MAX_TARGETED_QUERIES is
  // covered by the broad backstop query the caller always appends.
  const emitChunked = (
    terms: string[],
    maxPerQuery: number,
    wrap: (joined: string) => string,
  ) => {
    let chunk: string[] = [];
    const flush = () => {
      if (chunk.length > 0 && queries.length < MAX_TARGETED_QUERIES) {
        queries.push(`${baseQuery} ${wrap(chunk.join(" OR "))}`);
      }
      chunk = [];
    };
    let len = 0;
    for (const term of terms) {
      // Skip pathological single terms that alone would blow the budget.
      if (baseQuery.length + term.length + 12 > MAX_QUERY_CHARS) continue;
      if (
        chunk.length >= maxPerQuery ||
        baseQuery.length + len + term.length + 4 /* " OR " */ + 12 /* wrapper */ > MAX_QUERY_CHARS
      ) {
        flush();
        len = 0;
      }
      chunk.push(term);
      len += term.length + 4;
    }
    flush();
  };

  emitChunked(Array.from(addresses), MAX_FROM_PER_QUERY, (j) => `from:(${j})`);
  emitChunked(Array.from(phrases), MAX_NAMES_PER_QUERY, (j) => `(${j})`);
  return queries;
}
