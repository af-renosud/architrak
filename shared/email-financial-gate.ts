/** Content-only email admission. Sender identity deliberately is not an input. */
export const EMAIL_FINANCIAL_GATE_VERSION = 2;
export interface FinancialProject {
  id: number;
  name: string;
  clientName: string;
  code?: string | null;
  archivedAt?: Date | string | null;
}
export type FinancialKind = "quotation" | "invoice" | "credit_note" | "avenant" | "situation" | "commande" | "final_account" | "payment_confirmation";
export interface FinancialDecision {
  version: number;
  status: "eligible" | "financial_excluded" | "financial_identity_review" | "archived_project_candidate" | "financial_unreadable";
  reason: string;
  projectId: number | null;
  kind: FinancialKind | null;
  heading: string | null;
  identitySource: "pdf" | "email" | null;
  financialMarkers: string[];
  financialAmountLines: string[];
}
export function normalizeFinancialText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}
const hasPhrase = (text: string, phrase: string) => {
  const p = normalizeFinancialText(phrase);
  return p.length > 0 && ` ${normalizeFinancialText(text)} `.includes(` ${p} `);
};
const headingRules: Array<[FinancialKind, RegExp]> = [
  ["credit_note", /^(?:facture d avoir|facture avoir|avoir)(?: |$)/],
  ["avenant", /^avenant(?: |$)/],
  ["final_account", /^(?:decompte general definitif|dgd)(?: |$)/],
  ["payment_confirmation", /^(?:avis de virement|confirmation de paiement|recu de paiement|releve de virement|accuse de reception de paiement)(?: |$)/],
  ["situation", /^(?:situation de travaux|situation de paiement)(?: |$)/],
  ["commande", /^bon de commande(?: |$)/],
  ["quotation", /^devis(?: |$)/],
  ["invoice", /^facture(?: |$)/],
];
const nonFinancialHeading = /^(?:plan(?:s)?(?: |$)|fiche technique|fiche produit|detail(?:s)? technique|catalogue|notice technique|certificat de paiement|payment certificate|certificate of payment|demande de signature|electronic signature request)/;
function identity(text: string, projects: FinancialProject[]) {
  const exactProjects = projects.filter(p => hasPhrase(text, p.name));
  const named = projects.filter(p => hasPhrase(text, p.name) || hasPhrase(text, p.clientName));
  // Explicit unknown/conflicting client or project labels cannot be replaced by email context.
  const labels = text.split(/\r?\n/).map(l => l.match(/^\s*(?:client|ma[iî]tre d['’]ouvrage|projet|chantier|op[eé]ration)\s*:\s*(.+)$/i)?.[1])
    .filter((s): s is string => !!s?.trim());
  const invalidLabel = labels.some(label => !projects.some(p => hasPhrase(label, p.name) || hasPhrase(label, p.clientName)));
  const codes = text.split(/\r?\n/).map(l => l.match(/^\s*(?:r[eé]f(?:[eé]rence)?\.?\s*(?:projet|chantier)|code\s*(?:projet|chantier|op[eé]ration))\s*:\s*(.+)$/i)?.[1])
    .filter((s): s is string => !!s);
  const codeMatches = codes.length ? projects.filter(p => p.code && codes.every(c => normalizeFinancialText(c) === normalizeFinancialText(p.code!))) : [];
  if (codes.length && (codeMatches.length !== 1 || !named.some(p => p.id === codeMatches[0].id)
    || exactProjects.some(p => p.id !== codeMatches[0].id && normalizeFinancialText(p.name) !== normalizeFinancialText(p.clientName)))) {
    return { matches: named, conflict: true };
  }
  // A code can disambiguate identical client names, not contradictory named clients.
  if (codeMatches.length === 1 && named.every(p => normalizeFinancialText(p.clientName) === normalizeFinancialText(codeMatches[0].clientName))) {
    return { matches: codeMatches, conflict: invalidLabel };
  }
  // The exact project name disambiguates a shared client, but never another
  // explicitly named project or a conflicting client identity.
  if (exactProjects.length === 1 && named.every(p =>
    normalizeFinancialText(p.clientName) === normalizeFinancialText(exactProjects[0].clientName))) {
    return { matches: exactProjects, conflict: invalidLabel };
  }
  return { matches: named, conflict: invalidLabel };
}
export function evaluateFinancialPdf(text: string, emailText: string, projects: FinancialProject[]): FinancialDecision {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const markerPatterns: Array<[string, RegExp]> = [
    ["HT", /\b(?:h\s*\.?\s*t\.?|hors taxes)\b/i],
    ["TTC", /\b(?:t\s*\.?\s*t\s*\.?\s*c\.?|toutes taxes comprises)\b/i],
    ["TVA", /\b(?:t\s*\.?\s*v\s*\.?\s*a\.?|taxe sur la valeur ajoutee)\b/i],
  ];
  const normalizedAccent = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const markers = markerPatterns.filter(([, re]) => re.test(normalizedAccent)).map(([label]) => label);
  const amountLines = lines.filter(l => /\d/.test(l) && markerPatterns.some(([, re]) => re.test(l.normalize("NFD").replace(/[\u0300-\u036f]/g, "")))).slice(0, 12);
  const result: FinancialDecision = {
    version: EMAIL_FINANCIAL_GATE_VERSION, status: "financial_excluded", reason: "",
    projectId: null, kind: null, heading: null, identitySource: null,
    financialMarkers: markers, financialAmountLines: amountLines,
  };
  if (text.replace(/\s/g, "").length < 15) return { ...result, status: "financial_unreadable", reason: "PDF text could not be read reliably; retry text recognition or inspect the original." };
  // Layout-preserving text often places the title to the right of company details.
  const header = lines.flatMap(line => line.split(/\t+| {3,}/).map(part => part.trim()).filter(Boolean));
  // Devis may be prefixed ("Réf. Devis") or appear later in a multi-page PDF.
  // Match a whole word, not "devise", while retaining explicit nonfinancial titles.
  const quotationLine = header.findIndex(line => /(?:^| )devis(?: |$)/.test(normalizeFinancialText(line)));
  const firstFinancialHeading = header.findIndex(line => headingRules.some(([, pattern]) =>
    pattern.test(normalizeFinancialText(line).replace(/^document /, ""))));
  const firstNonfinancialHeading = header.findIndex(l => !/@|https?:\/\/|www\./i.test(l) && nonFinancialHeading.test(normalizeFinancialText(l)));
  // A quotation can legitimately contain a priced "Plan ..." line after its title.
  const firstPurpose = firstFinancialHeading < 0 ? quotationLine
    : quotationLine < 0 ? firstFinancialHeading : Math.min(firstFinancialHeading, quotationLine);
  if (firstNonfinancialHeading >= 0 && (firstPurpose < 0 || firstNonfinancialHeading < firstPurpose)) {
    return { ...result, reason: "Nonfinancial document or application certificate; incidental prices and financial references do not qualify." };
  }
  for (const [kind, pattern] of headingRules) {
    const heading = header.find(l => pattern.test(normalizeFinancialText(l).replace(/^document /, "")));
    if (heading) { result.kind = kind; result.heading = heading.slice(0, 240); break; }
  }
  if (!result.kind && quotationLine >= 0) {
    result.kind = "quotation";
    result.heading = header[quotationLine].slice(0, 240);
  }
  if (!result.kind) return { ...result, reason: "No financial document heading in the PDF. HT/TTC/TVA alone cannot admit plans or technical documents." };
  const pdf = identity(text, projects);
  const chosen = pdf.matches.length || pdf.conflict ? pdf : identity(emailText, projects);
  result.identitySource = pdf.matches.length || pdf.conflict ? "pdf" : "email";
  if (chosen.conflict || chosen.matches.length !== 1) {
    return { ...result, status: "financial_identity_review", reason: "Financial PDF, but client/project identity is missing, conflicting or matches multiple projects. No automatic assignment." };
  }
  const project = chosen.matches[0];
  if (project.archivedAt) return { ...result, status: "archived_project_candidate", reason: "Exact identity belongs to a closed project; retained for manual recovery." };
  return { ...result, status: "eligible", projectId: project.id,
    reason: `Exact ${result.identitySource} client/project match; ${result.heading}; financial evidence: ${markers.join(", ") || "document heading (no tax markers)"}.` };
}

export const FINANCIAL_PARKED_STATUSES = new Set([
  "financial_excluded", "financial_identity_review", "financial_unreadable",
  "unmatched_sender", "low_relevance", "archived_project_candidate",
]);
export function emailNeedsAttention(doc: { extractionStatus: string }): boolean {
  return ["pending", "needs_review", "failed", "financial_unreadable"].includes(doc.extractionStatus);
}
export function emailVisibleByDefault(doc: { extractionStatus: string }): boolean {
  return doc.extractionStatus !== "skipped"
    && (!FINANCIAL_PARKED_STATUSES.has(doc.extractionStatus) || doc.extractionStatus === "financial_unreadable");
}
