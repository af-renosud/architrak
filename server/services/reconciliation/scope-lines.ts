// Task #231 — canonical scope-line model.
//
// Every devis is normalised into a stable, comparable shape: a header, a
// set of scope lines (description / quantity / unit / unit price / total),
// a single canonical text used for embedding, and a content hash of that
// text. The hash lets the embedding cache skip re-calling the model when a
// devis hasn't materially changed across reconciliation runs.
//
// All money is carried as integer cents derived through the shared
// roundCurrency helper so the arithmetic (subset-sum, proofs) is exact.

import { createHash } from "node:crypto";
import { roundCurrency } from "@shared/financial-utils";
import { normalizeUnit } from "../benchmark-tags";
import type { Devis, DevisLineItem } from "@shared/schema";

export interface ScopeLine {
  lineNumber: number | null;
  description: string;
  normalizedDescription: string;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number | null;
  totalCents: number;
}

export interface DevisScope {
  devisId: number;
  devisCode: string | null;
  descriptionFr: string;
  contractorId: number;
  totalCents: number;
  lines: ScopeLine[];
  embeddingText: string;
  contentHash: string;
}

/** Convert a numeric/string euro amount to integer cents via roundCurrency. */
export function toCents(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return 0;
  return Math.round(roundCurrency(n) * 100);
}

function normalizeDescription(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the canonical scope for one devis. `lineItems` should be the rows
 * for this devis (caller fetches them). The embedding text deliberately
 * leads with the human description and folds in each line so semantically
 * similar devis (a consolidator vs the originals) land near each other in
 * vector space.
 */
export function buildDevisScope(devis: Devis, lineItems: DevisLineItem[]): DevisScope {
  const lines: ScopeLine[] = lineItems
    .slice()
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((li) => ({
      lineNumber: li.lineNumber,
      description: li.description,
      normalizedDescription: normalizeDescription(li.description),
      quantity: li.quantity != null ? Number(li.quantity) : null,
      unit: normalizeUnit(li.unit),
      unitPriceCents: li.unitPriceHt != null ? toCents(li.unitPriceHt) : null,
      totalCents: toCents(li.totalHt),
    }));

  const totalCents = toCents(devis.amountHt);

  const lineText = lines
    .map((l) => {
      const qty = l.quantity != null ? `${l.quantity}${l.unit ? ` ${l.unit}` : ""} ` : "";
      return `- ${qty}${l.normalizedDescription} = ${(l.totalCents / 100).toFixed(2)}`;
    })
    .join("\n");

  const embeddingText = [
    `devis ${devis.devisCode}`,
    normalizeDescription(devis.descriptionFr),
    `total ${(totalCents / 100).toFixed(2)}`,
    lineText,
  ].filter(Boolean).join("\n");

  const contentHash = createHash("sha256").update(embeddingText).digest("hex");

  return {
    devisId: devis.id,
    devisCode: devis.devisCode,
    descriptionFr: devis.descriptionFr,
    contractorId: devis.contractorId,
    totalCents,
    lines,
    embeddingText,
    contentHash,
  };
}
