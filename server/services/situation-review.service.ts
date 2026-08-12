/**
 * Task #450 — Situation traffic-light review.
 *
 * Mirrors the devis draft-review experience for situations de travaux:
 * an intake-classified "situation" PDF matched unambiguously to a mode_b
 * devis becomes a DRAFT situation whose lines map onto devis_line_items,
 * carrying the AI-claimed cumulative % per line. The architect reviews line
 * by line (green/amber/red + editable approved % + notes), then confirms.
 *
 * Money rules (all via roundCurrency, per ARCHITECTURE.md):
 *  - line cumulativeAmount = roundCurrency(devisLine.totalHt * approved% / 100)
 *  - line previousAmount   = cumulativeAmount of the SAME devis line on the
 *    latest prior CONFIRMED situation (baseline), else 0
 *  - line netAmount        = roundCurrency(cumulative - previous)
 *  - header totals are sums of rounded line values, re-rounded.
 * The baseline is always read from the latest confirmed situation row —
 * never derived via max()/sum() (see server-authoritative money rules).
 */
import { storage } from "../storage";
import { roundCurrency } from "@shared/financial-utils";
import type { Devis, DevisLineItem, Situation, SituationLine } from "@shared/schema";
import type { ParsedDocument } from "../gmail/document-parser";

export class SituationReviewError extends Error {
  constructor(message: string, public status: number = 409) {
    super(message);
    this.name = "SituationReviewError";
  }
}

function normalizeDesc(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clampPercent(v: number | undefined | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, roundCurrency(v)));
}

/**
 * Map parsed situation lines onto devis line items.
 * Strategy: exact normalized-description match first, then containment
 * match, then (only when the counts are equal) positional fallback.
 * Returns claimed % per devis line item id; unmatched devis lines get null
 * (treated as "no claim this period" → claimed = previous).
 */
export function mapClaimedPercents(
  devisLines: DevisLineItem[],
  parsedLines: NonNullable<ParsedDocument["lineItems"]>,
): Map<number, number | null> {
  const result = new Map<number, number | null>();
  const remaining = parsedLines.map((pl, idx) => ({ pl, idx, norm: normalizeDesc(pl.description || "") }));
  const taken = new Set<number>();

  const sorted = [...devisLines].sort((a, b) => a.lineNumber - b.lineNumber);
  for (const dl of sorted) {
    const norm = normalizeDesc(dl.description);
    let found = remaining.find((r) => !taken.has(r.idx) && r.norm && r.norm === norm);
    if (!found) {
      found = remaining.find(
        (r) =>
          !taken.has(r.idx) &&
          r.norm.length >= 8 &&
          norm.length >= 8 &&
          (r.norm.includes(norm) || norm.includes(r.norm)),
      );
    }
    if (found) {
      taken.add(found.idx);
      result.set(dl.id, clampPercent(found.pl.percentComplete));
    } else {
      result.set(dl.id, null);
    }
  }

  // Positional fallback: only safe when nothing matched by text AND the
  // document has exactly one parsed line per devis line.
  const anyMatched = taken.size > 0;
  if (!anyMatched && parsedLines.length === sorted.length) {
    sorted.forEach((dl, i) => {
      result.set(dl.id, clampPercent(parsedLines[i].percentComplete));
    });
  }
  return result;
}

/** Baseline: approved % + cumulative amount per devis line from the latest confirmed situation. */
export async function getBaseline(devisId: number): Promise<{
  situation: Situation | null;
  byLineItem: Map<number, { percent: number; cumulativeAmount: number }>;
}> {
  const all = await storage.getSituationsByDevis(devisId);
  const confirmed = all.filter((s) => s.status === "confirmed");
  const latest = confirmed.length ? confirmed[confirmed.length - 1] : null;
  const byLineItem = new Map<number, { percent: number; cumulativeAmount: number }>();
  if (latest) {
    const lines = await storage.getSituationLines(latest.id);
    for (const l of lines) {
      byLineItem.set(l.devisLineItemId, {
        percent: parseFloat(l.percentComplete),
        cumulativeAmount: parseFloat(l.cumulativeAmount),
      });
    }
  }
  return { situation: latest, byLineItem };
}

function computeLineMoney(totalHt: number, percent: number, previousAmount: number) {
  const cumulativeAmount = roundCurrency((totalHt * percent) / 100);
  const netAmount = roundCurrency(cumulativeAmount - previousAmount);
  return { cumulativeAmount, netAmount };
}

function computeHeaderTotals(
  lines: Array<{ cumulativeAmount: number; previousAmount: number }>,
  tvaRate: number,
) {
  const cumulativeHt = roundCurrency(lines.reduce((s, l) => s + l.cumulativeAmount, 0));
  const previousHt = roundCurrency(lines.reduce((s, l) => s + l.previousAmount, 0));
  const netHt = roundCurrency(cumulativeHt - previousHt);
  const netToPayHt = netHt; // retenue de garantie handled at certificat level
  const tvaAmount = roundCurrency((netToPayHt * tvaRate) / 100);
  const netToPayTtc = roundCurrency(netToPayHt + tvaAmount);
  return { cumulativeHt, previousHt, netHt, netToPayHt, tvaAmount, netToPayTtc };
}

function devisTvaRate(devis: Devis): number {
  // The devis stores no explicit rate — derive it from the HT/TTC pair
  // (e.g. 1200/1000 → 20%). Falls back to the standard 20% only when the
  // amounts can't produce a sane rate (0 ⇒ auto-liquidation is preserved).
  const ht = parseFloat(devis.amountHt);
  const ttc = parseFloat(devis.amountTtc);
  if (Number.isFinite(ht) && Number.isFinite(ttc) && ht > 0 && ttc >= ht) {
    return roundCurrency(((ttc - ht) / ht) * 100);
  }
  return 20;
}

/**
 * Create a DRAFT situation from an intake-parsed situation PDF.
 * Caller has already resolved the devis unambiguously and verified mode_b.
 */
export async function createDraftSituationFromParsed(args: {
  devis: Devis;
  parsed: ParsedDocument;
  fileName: string;
  storageKey: string;
}): Promise<{ situation: Situation; lines: SituationLine[] }> {
  const { devis, parsed, fileName, storageKey } = args;
  if (devis.invoicingMode !== "mode_b") {
    throw new SituationReviewError("Situation review requires a mode_b (line-item) devis", 422);
  }
  const devisLines = await storage.getDevisLineItems(devis.id);
  if (devisLines.length === 0) {
    throw new SituationReviewError("Devis has no line items to map the situation against", 422);
  }
  if (!parsed.lineItems?.length || !parsed.lineItems.some((l) => l.percentComplete != null)) {
    throw new SituationReviewError("Situation PDF has no per-line completion percentages", 422);
  }

  const existing = await storage.getSituationsByDevis(devis.id);
  if (existing.some((s) => s.status === "draft")) {
    throw new SituationReviewError(
      "A draft situation already exists for this devis — confirm or delete it before importing another",
      409,
    );
  }
  const nextNumber = existing.reduce((m, s) => Math.max(m, s.situationNumber), 0) + 1;

  const { byLineItem: baseline } = await getBaseline(devis.id);
  const claimedByLine = mapClaimedPercents(devisLines, parsed.lineItems);

  const lineInputs = devisLines
    .slice()
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .map((dl) => {
      const prev = baseline.get(dl.id);
      const previousPercent = prev?.percent ?? 0;
      const previousAmount = prev?.cumulativeAmount ?? 0;
      // Unmatched / unclaimed lines default to carrying the previous %
      // forward (no movement this period).
      const claimed = claimedByLine.get(dl.id);
      const approved = claimed ?? previousPercent;
      const totalHt = parseFloat(dl.totalHt);
      const { cumulativeAmount, netAmount } = computeLineMoney(totalHt, approved, previousAmount);
      return { dl, claimed, approved, previousAmount, cumulativeAmount, netAmount };
    });

  const totals = computeHeaderTotals(
    lineInputs.map((l) => ({ cumulativeAmount: l.cumulativeAmount, previousAmount: l.previousAmount })),
    devisTvaRate(devis),
  );

  const situation = await storage.createSituation({
    devisId: devis.id,
    situationNumber: nextNumber,
    dateIssued: parsed.date ?? null,
    cumulativeHt: totals.cumulativeHt.toFixed(2),
    previousHt: totals.previousHt.toFixed(2),
    netHt: totals.netHt.toFixed(2),
    retenueGarantie: "0.00",
    netToPayHt: totals.netToPayHt.toFixed(2),
    tvaAmount: totals.tvaAmount.toFixed(2),
    netToPayTtc: totals.netToPayTtc.toFixed(2),
    status: "draft",
    aiExtractedData: {
      documentType: parsed.documentType,
      reference: parsed.reference ?? null,
      date: parsed.date ?? null,
      amountHt: parsed.amountHt ?? null,
      lineItems: parsed.lineItems.map((l) => ({
        description: l.description,
        percentComplete: l.percentComplete ?? null,
        total: l.total ?? null,
      })),
    },
  });

  // Task #449 evidence columns — retain the signed source PDF through the
  // dedicated server-side attach (the insert schema seals these columns).
  // Freshly created, so the conditional attach cannot conflict.
  await storage.attachSituationSourcePdf(situation.id, {
    sourceStorageKey: storageKey,
    sourceFileName: fileName,
    sourceUploadedBy: "intake-auto",
    sourceIntakeDocumentId: null,
    confirmed: false,
  });

  const lines: SituationLine[] = [];
  for (const li of lineInputs) {
    lines.push(
      await storage.createSituationLine({
        situationId: situation.id,
        devisLineItemId: li.dl.id,
        percentComplete: li.approved.toFixed(2),
        cumulativeAmount: li.cumulativeAmount.toFixed(2),
        previousAmount: li.previousAmount.toFixed(2),
        netAmount: li.netAmount.toFixed(2),
        claimedPercent: li.claimed != null ? li.claimed.toFixed(2) : null,
        checkStatus: "unchecked",
        checkNotes: null,
      }),
    );
  }
  return { situation, lines };
}

/**
 * Recompute a DRAFT situation's line money + header totals from the current
 * approved percents. Called after any per-line % edit and at confirm time so
 * the persisted figures are always server-computed.
 */
export async function recomputeDraftSituation(situationId: number): Promise<Situation> {
  const situation = await storage.getSituation(situationId);
  if (!situation) throw new SituationReviewError("Situation not found", 404);
  if (situation.status !== "draft") {
    throw new SituationReviewError("Only draft situations can be recomputed", 409);
  }
  const devis = await storage.getDevis(situation.devisId);
  if (!devis) throw new SituationReviewError("Devis not found", 404);
  const devisLines = await storage.getDevisLineItems(devis.id);
  const byId = new Map(devisLines.map((d) => [d.id, d]));
  const lines = await storage.getSituationLines(situationId);

  const computed: Array<{ cumulativeAmount: number; previousAmount: number }> = [];
  for (const line of lines) {
    const dl = byId.get(line.devisLineItemId);
    if (!dl) continue;
    const approved = parseFloat(line.percentComplete);
    const previousAmount = parseFloat(line.previousAmount);
    const { cumulativeAmount, netAmount } = computeLineMoney(parseFloat(dl.totalHt), approved, previousAmount);
    computed.push({ cumulativeAmount, previousAmount });
    await storage.updateSituationLine(line.id, {
      cumulativeAmount: cumulativeAmount.toFixed(2),
      netAmount: netAmount.toFixed(2),
    });
  }
  const totals = computeHeaderTotals(computed, devisTvaRate(devis));
  const updated = await storage.updateSituation(situationId, {
    cumulativeHt: totals.cumulativeHt.toFixed(2),
    previousHt: totals.previousHt.toFixed(2),
    netHt: totals.netHt.toFixed(2),
    netToPayHt: totals.netToPayHt.toFixed(2),
    tvaAmount: totals.tvaAmount.toFixed(2),
    netToPayTtc: totals.netToPayTtc.toFixed(2),
  });
  return updated!;
}

export interface SituationReviewLine {
  id: number;
  devisLineItemId: number;
  lineNumber: number;
  description: string;
  totalHt: string;
  previousPercent: number;
  claimedPercent: number | null;
  approvedPercent: number;
  cumulativeAmount: string;
  previousAmount: string;
  netAmount: string;
  checkStatus: string;
  checkNotes: string | null;
  /** Review flags computed server-side (advisory, don't block): */
  flags: string[];
}

/**
 * Full review payload: situation + lines joined with devis line metadata,
 * previous validated %, claimed %, approved %, and advisory flags:
 *  - regression: claimed % below the previously validated %
 *  - jump: claimed % more than 50 points above the previous %
 *  - claim_on_rejected: claim increase on a line whose DEVIS review was red
 */
export async function getSituationReview(situationId: number) {
  const situation = await storage.getSituation(situationId);
  if (!situation) throw new SituationReviewError("Situation not found", 404);
  const devis = await storage.getDevis(situation.devisId);
  if (!devis) throw new SituationReviewError("Devis not found", 404);
  const devisLines = await storage.getDevisLineItems(devis.id);
  const byId = new Map(devisLines.map((d) => [d.id, d]));
  const lines = await storage.getSituationLines(situationId);

  const reviewLines: SituationReviewLine[] = [];
  for (const line of lines) {
    const dl = byId.get(line.devisLineItemId);
    if (!dl) continue;
    const previousAmount = parseFloat(line.previousAmount);
    const totalHt = parseFloat(dl.totalHt);
    const previousPercent =
      totalHt > 0 ? roundCurrency((previousAmount / totalHt) * 100) : 0;
    const claimed = line.claimedPercent != null ? parseFloat(line.claimedPercent) : null;
    const flags: string[] = [];
    if (claimed != null) {
      if (claimed < previousPercent) flags.push("regression");
      if (claimed - previousPercent > 50) flags.push("jump");
      if (dl.checkStatus === "red" && claimed > previousPercent) flags.push("claim_on_rejected");
    }
    reviewLines.push({
      id: line.id,
      devisLineItemId: dl.id,
      lineNumber: dl.lineNumber,
      description: dl.description,
      totalHt: dl.totalHt,
      previousPercent,
      claimedPercent: claimed,
      approvedPercent: parseFloat(line.percentComplete),
      cumulativeAmount: line.cumulativeAmount,
      previousAmount: line.previousAmount,
      netAmount: line.netAmount,
      checkStatus: line.checkStatus,
      checkNotes: line.checkNotes,
      flags,
    });
  }
  reviewLines.sort((a, b) => a.lineNumber - b.lineNumber);
  return { situation, lines: reviewLines };
}

/**
 * Confirm a draft situation. Requires every line to be resolved (any
 * traffic-light state other than "unchecked"). Recomputes all money
 * server-side before flipping the status so client-supplied figures can
 * never leak into a confirmed situation. Confirmed situations become the
 * baseline for the next situation on the devis.
 */
export async function confirmSituation(situationId: number): Promise<Situation> {
  const situation = await storage.getSituation(situationId);
  if (!situation) throw new SituationReviewError("Situation not found", 404);
  if (situation.status !== "draft") {
    throw new SituationReviewError("Only a draft situation can be confirmed", 409);
  }
  const lines = await storage.getSituationLines(situationId);
  const unresolved = lines.filter((l) => (l.checkStatus || "unchecked") === "unchecked");
  if (unresolved.length > 0) {
    throw new SituationReviewError(
      `Cannot confirm: ${unresolved.length} line(s) still unresolved — set each line to Approved, Questioned or Rejected first`,
      409,
    );
  }
  await recomputeDraftSituation(situationId);
  const updated = await storage.updateSituation(situationId, {
    status: "confirmed",
    confirmedAt: new Date(),
  });
  return updated!;
}
