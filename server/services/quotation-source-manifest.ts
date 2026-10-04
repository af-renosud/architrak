import { z } from "zod";
import { createHash } from "node:crypto";
import { compareQuotationContent } from "../../shared/quotation-content-coverage";
import type { ParsedDocument } from "../gmail/document-parser";
import type { IllustratedPriceRow } from "./illustrated-quotation";

const region = z.object({
  page: z.number().int().positive(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().positive().max(1),
  h: z.number().positive().max(1),
}).refine(r => r.x + r.w <= 1.001 && r.y + r.h <= 1.001, "Region extends outside page");

export const quotationSourceManifestSchema = z.object({
  sections: z.array(z.object({
    id: z.string().trim().min(1),
    reference: z.string().trim().min(1),
    priceRegion: region,
    specificationRegions: z.array(region).min(1),
    quantity: z.number().positive(),
    unitPrice: z.number().nonnegative(),
    total: z.number().nonnegative(),
  })).min(1),
  segments: z.array(z.object({
    id: z.string().trim().min(1),
    section: z.string().trim().min(1),
    page: z.number().int().positive(),
    text: z.string(),
    disposition: z.enum(["item", "document", "boilerplate", "uncertain"]),
    classificationReason: z.string().optional(),
    region,
  })).min(1),
  // Every rendered page must be represented, including terms-only pages.
  inventoriedPages: z.array(z.number().int().positive()),
});
export type QuotationSourceManifest = z.infer<typeof quotationSourceManifestSchema>;

const cents = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Validates independently collected source evidence before using it to judge a
 * candidate. A model's claimed success/confidence never substitutes for these
 * checks. This does not establish that the transcription itself is error-free.
 */
export function verifyQuotationManifest(
  raw: unknown,
  sourceRows: IllustratedPriceRow[],
  candidate: ParsedDocument,
  pageCount: number,
) {
  const parsed = quotationSourceManifestSchema.safeParse(raw);
  const failures: string[] = [];
  if (!parsed.success) return { verified: false as const, failures: ["Invalid source inventory"], coverage: null };
  const manifest = parsed.data;
  if (candidate.documentType !== "quotation") failures.push("Candidate is not a quotation");
  const pageSet = new Set(manifest.inventoriedPages);
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageSet.size !== pageCount
    || manifest.inventoriedPages.length !== pageCount
    || Array.from(pageSet).some(p => p > pageCount)) failures.push("Incomplete source-page inventory");
  if (!sourceRows.length || manifest.sections.length !== sourceRows.length
    || candidate.lineItems?.length !== sourceRows.length) failures.push("Source and candidate section counts differ");
  const ids = new Set(manifest.sections.map(s => s.id));
  const refs = new Set(manifest.sections.map(s => s.reference.toUpperCase()));
  if (ids.size !== manifest.sections.length || refs.size !== manifest.sections.length) failures.push("Repeated source section identity");
  manifest.sections.forEach((section, i) => {
    const row = sourceRows[i];
    const line = candidate.lineItems?.[i];
    if (!row || !line || row.page !== section.priceRegion.page
      || row.quantity !== section.quantity || row.quantity !== line.quantity
      || cents(row.unitPrice) !== cents(section.unitPrice) || cents(row.unitPrice) !== cents(line.unitPrice)
      || cents(row.total) !== cents(section.total) || cents(row.total) !== cents(line.total)
      || (row.reference && row.reference.toUpperCase() !== section.reference.toUpperCase())) {
      failures.push(`Unreconciled source section ${section.id}`);
    }
    const next = manifest.sections[i + 1]?.priceRegion;
    for (const r of section.specificationRegions) {
      if (r.page > pageCount || r.page < section.priceRegion.page
        || (r.page === section.priceRegion.page && r.y < section.priceRegion.y)
        || (next && (r.page > next.page || (r.page === next.page && r.y + r.h > next.y + 0.001)))) {
        failures.push(`Ambiguous specification boundary ${section.id}`);
      }
    }
    if (!manifest.segments.some(s => s.section === section.id && s.disposition === "item"
      && s.text.includes(section.reference))) failures.push(`Missing source reference ${section.id}`);
  });
  for (const segment of manifest.segments) {
    if (segment.page !== segment.region.page || segment.page > pageCount
      || (segment.disposition === "item" && !ids.has(segment.section))) failures.push(`Invalid segment provenance ${segment.id}`);
    if (segment.disposition === "item") {
      const section = manifest.sections.find(s => s.id === segment.section);
      const r = segment.region;
      if (!section?.specificationRegions.some(parent => parent.page === r.page
        && r.x >= parent.x - 0.001 && r.y >= parent.y - 0.001
        && r.x + r.w <= parent.x + parent.w + 0.001
        && r.y + r.h <= parent.y + parent.h + 0.001)) {
        failures.push(`Segment outside its source section ${segment.id}`);
      }
    }
  }
  const coverage = compareQuotationContent(manifest.segments,
    (candidate.lineItems ?? []).map((line, i) => ({
      section: manifest.sections[i]?.id ?? "", text: line.description,
    })), [candidate.description, candidate.paymentTerms].filter(Boolean).join("\n"));
  return {
    verified: failures.length === 0 && coverage.complete,
    failures, coverage,
    manifestDigest: digest(manifest),
    candidateDigest: digest(candidate.lineItems),
  };
}