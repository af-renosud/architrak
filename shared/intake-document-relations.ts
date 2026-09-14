/**
 * Deterministic, deliberately conservative correlation of documents which
 * belong to a supplier quotation.  This is not duplicate detection: many
 * invoices may correctly cite the same order/devis.
 *
 * Only references extracted as fields, or explicit verbatim reference
 * evidence, take part in this resolver.  Totals and model confidence are
 * intentionally not matching signals.
 */
import { normalizeRef } from "./intake-dedup";

export type IntakeRelatedReferenceKind = "quotation" | "order" | "invoice";

export interface IntakeRelatedReference {
  kind: IntakeRelatedReferenceKind;
  reference: string;
  evidenceText: string;
  page?: number;
}

export interface RelationExtraction {
  documentType?: string | null;
  reference?: string | null;
  devisNumber?: string | null;
  invoiceNumber?: string | null;
  relatedDocumentReferences?: readonly IntakeRelatedReference[] | null;
  /** Stored parser line descriptions are permitted legacy evidence. */
  lineItems?: readonly { description?: string | null; pageHint?: number | null }[] | null;
  description?: string | null;
  amountHt?: number | string | null;
}

export interface AuditableReference extends IntakeRelatedReference {
  normalizedReference: string;
  source: "header" | "explicit_evidence";
  /** True where this number identifies the source document, not its parent. */
  own: boolean;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function page(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Reject model-shaped data unless it includes the claimed reference verbatim
 * in its evidence.  This makes the stored JSON independently auditable and
 * prevents a bare classification confidence from becoming a financial link.
 */
export function validatedExplicitReferences(value: unknown): AuditableReference[] {
  if (!Array.isArray(value)) return [];
  const refs: AuditableReference[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const kind = record.kind;
    const reference = text(record.reference);
    const evidenceText = text(record.evidenceText);
    const normalizedReference = normalizeRef(reference);
    if (
      (kind !== "quotation" && kind !== "order" && kind !== "invoice")
      || !reference
      || !evidenceText
      || !normalizedReference
      || !normalizeRef(evidenceText).includes(normalizedReference)
    ) continue;
    refs.push({
      kind,
      reference,
      evidenceText,
      page: page(record.page),
      normalizedReference,
      source: "explicit_evidence",
      own: false,
    });
  }
  return refs;
}

/**
 * Pre-relationship-schema extracts did not have relatedDocumentReferences,
 * but did preserve invoice line descriptions. Recover only labelled French
 * document references from that stored text. This is transcription, not
 * inference: generic mentions, amounts and filenames never qualify.
 */
function legacyDescriptionReferences(parsed: RelationExtraction): AuditableReference[] {
  const descriptions = [
    ...(parsed.lineItems ?? []).map((line) => ({ text: line.description, page: line.pageHint })),
    { text: parsed.description, page: undefined },
  ];
  const refs: AuditableReference[] = [];
  const patterns: Array<{ kind: IntakeRelatedReferenceKind; pattern: RegExp }> = [
    { kind: "order", pattern: /\b(?:bon\s+de\s+)?commande\s*(?:n[°ºo.]?\s*)?([a-z0-9][a-z0-9./_-]{2,})/ig },
    { kind: "quotation", pattern: /\bdevis\s*(?:n[°ºo.]?\s*)?([a-z0-9][a-z0-9./_-]{2,})/ig },
  ];
  for (const description of descriptions) {
    const evidenceText = text(description.text);
    if (!evidenceText) continue;
    for (const { kind, pattern } of patterns) {
      pattern.lastIndex = 0;
      for (const match of Array.from(evidenceText.matchAll(pattern))) {
        const reference = match[1];
        const normalizedReference = normalizeRef(reference);
        if (!normalizedReference) continue;
        refs.push({
          kind,
          reference,
          evidenceText,
          page: page(description.page),
          normalizedReference,
          source: "explicit_evidence",
          own: false,
        });
      }
    }
  }
  return refs;
}

function headerReference(
  kind: IntakeRelatedReferenceKind,
  reference: string | null | undefined,
  own: boolean,
): AuditableReference[] {
  const value = text(reference);
  const normalizedReference = normalizeRef(value);
  return value && normalizedReference
    ? [{
        kind,
        reference: value,
        evidenceText: own ? `Document header: ${value}` : `Header reference: ${value}`,
        normalizedReference,
        source: "header",
        own,
      }]
    : [];
}

/**
 * Preserves the distinction that was missing from the original router:
 * `reference` / `invoiceNumber` identify an invoice itself; they do not make
 * it a parent quotation.  A commande's primary reference identifies the
 * order. New extracts use explicit related-reference evidence for parents.
 * The `devisNumber` field remains accepted on a commande solely to recover
 * older stored extracts (where it was the typed linked-devis field); an
 * invoice's `devisNumber` is never treated as its parent.
 */
export function extractAuditableReferences(parsed: RelationExtraction): AuditableReference[] {
  const type = parsed.documentType;
  const refs: AuditableReference[] = [];
  if (type === "quotation") {
    refs.push(...headerReference("quotation", parsed.devisNumber ?? parsed.reference, true));
  } else if (type === "commande") {
    refs.push(...headerReference("order", parsed.reference, true));
    // Legacy extracts (including the original regression) used devisNumber
    // for the quotation printed on an order. New parser output records this
    // as relatedDocumentReferences instead, but retaining this typed legacy
    // evidence is safe and enables bounded recovery without re-running AI.
    refs.push(...headerReference("quotation", parsed.devisNumber, false));
  } else if (type === "invoice" || type === "acompte") {
    refs.push(...headerReference("invoice", parsed.invoiceNumber ?? parsed.reference, true));
  }
  refs.push(...validatedExplicitReferences(parsed.relatedDocumentReferences));
  // Typed parser evidence and legacy labelled line text are independently
  // auditable. Keep both: hiding a legacy reference merely because one typed
  // reference exists could conceal a contradictory additional parent.
  refs.push(...legacyDescriptionReferences(parsed));

  // Repeated extraction chunks should not make one document ambiguous, while
  // separate stored documents are intentionally never deduplicated here.
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}|${ref.normalizedReference}|${ref.own}|${ref.evidenceText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface RelationDevis {
  id: number;
  contractorId: number;
  devisNumber: string | null;
  devisCode: string;
  status?: string | null;
  accountingState?: string | null;
  amountHt?: number | string | null;
}

export interface RelationOrder {
  id: number;
  devisId: number | null;
  extractedData: unknown;
}

export type IntakeRelationshipResolution =
  | {
      outcome: "resolved";
      devisId: number;
      route: "quotation" | "order";
      explanation: string;
      references: AuditableReference[];
    }
  | {
      outcome: "parked";
      code:
        | "contractor_unresolved"
        | "no_explicit_relationship"
        | "reference_not_found"
        | "ambiguous_quotation_reference"
        | "ambiguous_order_reference"
        | "conflicting_references"
        | "contractor_conflict"
        | "inactive_devis"
        | "contradictory_order_amount";
      explanation: string;
      references: AuditableReference[];
    };

function isActive(devis: RelationDevis): boolean {
  return devis.status !== "void" && devis.accountingState !== "superseded";
}

function quoteMatches(ref: AuditableReference, candidate: RelationDevis): boolean {
  return ref.kind === "quotation"
    && (normalizeRef(candidate.devisNumber) === ref.normalizedReference
      || normalizeRef(candidate.devisCode) === ref.normalizedReference);
}

function displayQuote(devis: RelationDevis): string {
  return devis.devisNumber || devis.devisCode || `devis #${devis.id}`;
}

function currency(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

/**
 * Resolves a source's parent quotation within one project.  `allDevis` is
 * deliberately not pre-filtered: a reference matching a different contractor
 * is an identity conflict, not an invitation to silently ignore evidence.
 */
export function resolveIntakeDocumentRelationship(input: {
  parsed: RelationExtraction;
  contractorId: number | null | undefined;
  allDevis: readonly RelationDevis[];
  orders: readonly RelationOrder[];
}): IntakeRelationshipResolution {
  const references = extractAuditableReferences(input.parsed);
  if (!input.contractorId) {
    return {
      outcome: "parked",
      code: "contractor_unresolved",
      explanation: "Parked: contractor identity is required before explicit references can be linked.",
      references,
    };
  }

  const quotationRefs = references.filter((r) => r.kind === "quotation" && !r.own);
  const orderRefs = references.filter((r) => r.kind === "order" && !r.own);
  if (!quotationRefs.length && !orderRefs.length) {
    return {
      outcome: "parked",
      code: "no_explicit_relationship",
      explanation: "Parked: no explicit quotation or order reference was extracted.",
      references,
    };
  }

  const directMatches = new Map<number, { devis: RelationDevis; ref: AuditableReference }>();
  for (const ref of quotationRefs) {
    for (const devis of input.allDevis) {
      if (quoteMatches(ref, devis)) directMatches.set(devis.id, { devis, ref });
    }
  }
  const direct = Array.from(directMatches.values());
  if (quotationRefs.some((ref) => !input.allDevis.some((candidate) => quoteMatches(ref, candidate)))) {
    return {
      outcome: "parked",
      code: "reference_not_found",
      explanation: "Parked: at least one explicit quotation reference has no stored match.",
      references,
    };
  }
  if (direct.some(({ devis }) => devis.contractorId !== input.contractorId)) {
    return {
      outcome: "parked",
      code: "contractor_conflict",
      explanation: "Parked: an explicit quotation reference belongs to a different contractor.",
      references,
    };
  }
  if (direct.length > 1) {
    return {
      outcome: "parked",
      code: "ambiguous_quotation_reference",
      explanation: `Parked: explicit quotation references match multiple devis (${direct.map((m) => displayQuote(m.devis)).join(", ")}); possible duplicate/revision.`,
      references,
    };
  }

  const orderMatches = new Map<number, { order: RelationOrder; ref: AuditableReference }>();
  for (const orderRef of orderRefs) {
    for (const order of input.orders) {
      const ownOrderRefs = extractAuditableReferences({
        ...((order.extractedData ?? {}) as RelationExtraction),
        documentType: "commande",
      }).filter((r) => r.kind === "order" && r.own);
      if (ownOrderRefs.some((r) => r.normalizedReference === orderRef.normalizedReference)) {
        orderMatches.set(order.id, { order, ref: orderRef });
      }
    }
  }
  const orderTargets = Array.from(orderMatches.values())
    .map(({ order, ref }) => ({
      order,
      ref,
      devis: order.devisId == null ? undefined : input.allDevis.find((d) => d.id === order.devisId),
    }));
  if (orderRefs.some((ref) => !input.orders.some((order) =>
    extractAuditableReferences({
      ...((order.extractedData ?? {}) as RelationExtraction),
      documentType: "commande",
    }).some((candidate) => candidate.kind === "order" && candidate.own && candidate.normalizedReference === ref.normalizedReference),
  ))) {
    return {
      outcome: "parked",
      code: "reference_not_found",
      explanation: "Parked: at least one explicit order reference has no stored match.",
      references,
    };
  }
  const orderDevisIds = new Set(orderTargets.map((m) => m.devis?.id).filter((id): id is number => id != null));
  if (orderMatches.size > 1 || orderDevisIds.size > 1 || orderTargets.some((m) => !m.devis)) {
    return {
      outcome: "parked",
      code: "ambiguous_order_reference",
      explanation: "Parked: the explicit order reference is duplicated, unresolved, or leads to more than one devis.",
      references,
    };
  }
  const orderTarget = orderTargets[0];
  if (orderTarget?.devis && orderTarget.devis.contractorId !== input.contractorId) {
    return {
      outcome: "parked",
      code: "contractor_conflict",
      explanation: "Parked: the referenced order is attached to a devis for a different contractor.",
      references,
    };
  }

  const directTarget = direct[0];
  if (directTarget && orderTarget?.devis && directTarget.devis.id !== orderTarget.devis.id) {
    return {
      outcome: "parked",
      code: "conflicting_references",
      explanation: `Parked: quotation ${displayQuote(directTarget.devis)} conflicts with the devis linked by the explicit order reference.`,
      references,
    };
  }
  const target = directTarget?.devis ?? orderTarget?.devis;
  if (!target) {
    return {
      outcome: "parked",
      code: "reference_not_found",
      explanation: "Parked: explicit reference does not yet resolve to one stored quotation/order chain.",
      references,
    };
  }
  if (!isActive(target)) {
    return {
      outcome: "parked",
      code: "inactive_devis",
      explanation: `Parked: referenced devis ${displayQuote(target)} is void or superseded.`,
      references,
    };
  }

  // Totals can only contradict an already explicit order -> devis edge; they
  // never create one. In particular an invoice/deposit amount is not compared
  // with the contract total.
  const orderExtraction = input.parsed.documentType === "commande"
    ? input.parsed
    : (orderTarget?.order.extractedData as RelationExtraction | null | undefined);
  const orderAmount = currency(orderExtraction?.amountHt);
  const devisAmount = currency(target.amountHt);
  if (orderAmount != null && devisAmount != null && orderAmount !== devisAmount) {
    return {
      outcome: "parked",
      code: "contradictory_order_amount",
      explanation: `Parked: the explicit order HT total (${(orderAmount / 100).toFixed(2)}) contradicts devis ${displayQuote(target)} (${(devisAmount / 100).toFixed(2)}).`,
      references,
    };
  }

  const orderPrefix = orderTarget
    ? `${orderTarget.ref.reference} -> `
    : "";
  const quoteRef = directTarget?.ref.reference ?? target.devisNumber ?? target.devisCode;
  return {
    outcome: "resolved",
    devisId: target.id,
    route: orderTarget ? "order" : "quotation",
    explanation: `${input.parsed.invoiceNumber || input.parsed.reference || "Document"} -> ${orderPrefix}${quoteRef} (${target.devisCode})`,
    references,
  };
}