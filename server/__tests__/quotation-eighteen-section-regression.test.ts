import { describe, expect, it } from "vitest";
import { verifyQuotationManifest, type QuotationSourceManifest } from "../services/quotation-source-manifest";
import type { ParsedDocument } from "../gmail/document-parser";

// Synthetic region fixture with the source's 18 references/prices and the three
// independently checked critical dimensions. Other dimensions are test values,
// not claims about the supplier PDF. No supplier/customer personal data.
const references = ["001", "002", "003", "004", "005", "006", "101", "102", "103", "104", "105", "106", "107", "201", "202", "203", "204", "205"];
const prices = [3085, 3405, 945, 2100, 2610, 1655, 2825, 3025, 2195, 1795, 1795, 1825, 1145, 745, 885, 555, 900, 915];
function fixture(annotated: boolean) {
  const manifest: QuotationSourceManifest = { sections: [], segments: [], inventoriedPages: Array.from({ length: 11 }, (_, i) => i + 1) };
  const rows = prices.map((total, i) => ({ quantity: 1, unitPrice: total, total, page: Math.floor(i / 2) + 1 }));
  references.forEach((ref, i) => {
    const id = String(i + 1).padStart(3, "0"), reference = `MEXT ${ref}`;
    const dimensions = i === 9 ? "920 mm X 850 mm" : i === 10 ? "800 mm X 900 mm" : i === 17 ? "600 mm X 700 mm" : "900 mm X 1200 mm";
    const page = rows[i].page, y = i % 2 ? 0.85 : 0.15;
    const region = { page: i % 2 ? page + 1 : page, x: 0.1, y: i % 2 ? 0.02 : 0.3, w: 0.8, h: 0.1 };
    const text = `${reference}\nDim. L x H : ${dimensions}\nPose comprise, vitrage 16 mm, paumelle simple, hors peinture.`;
    manifest.sections.push({ id, reference, independentText: text,
      priceRegion: { page, x: 0.1, y, w: 0.8, h: 0.01 }, specificationRegions: [region], ...rows[i] });
    manifest.segments.push({ id, section: id, page: region.page, region, text, disposition: "item" });
  });
  manifest.segments.push({ id: "terms", section: "document", page: 11, text: "Conditions générales conservées.",
    disposition: "document", region: { page: 11, x: 0, y: 0, w: 1, h: 1 } });
  if (annotated) manifest.segments.push({ id: "annotation", section: "document", page: 6,
    text: "Repère de contrôle ajouté en rouge", disposition: "boilerplate", classificationReason: "Reviewer annotation, not supplier text",
    region: { page: 6, x: 0, y: 0, w: 1, h: 0.01 } });
  const candidate: ParsedDocument = { documentType: "quotation", amountHt: 32405,
    rawText: "Conditions générales conservées.",
    lineItems: rows.map((r, i) => ({ ...r, description: manifest.segments[i].text })) };
  return { manifest, rows, candidate };
}
describe("18-section source-alignment regression", () => {
  it.each([true, false])("preserves distinct equal-price products and final continuation (annotated=%s)", annotated => {
    const { manifest, rows, candidate } = fixture(annotated);
    expect(verifyQuotationManifest(manifest, rows, candidate, 11).verified).toBe(true);
    expect(rows.reduce((sum, r) => sum + r.total, 0)).toBe(32405);
    expect(rows[9].total).toBe(1795); expect(rows[10].total).toBe(1795); expect(rows[17].total).toBe(915);
  });
  it("rejects a one-position shift even with unchanged counts and finances", () => {
    const { manifest, rows, candidate } = fixture(false);
    const descriptions = candidate.lineItems!.map(l => l.description);
    candidate.lineItems!.forEach((line, i) => { line.description = descriptions[(i + 1) % descriptions.length]; });
    expect(verifyQuotationManifest(manifest, rows, candidate, 11).verified).toBe(false);
  });
  it("rejects a missing terminal description", () => {
    const { manifest, rows, candidate } = fixture(false);
    candidate.lineItems![17].description = "";
    expect(verifyQuotationManifest(manifest, rows, candidate, 11).verified).toBe(false);
  });
});