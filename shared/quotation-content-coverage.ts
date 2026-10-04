/**
 * A coverage comparison is not an OCR accuracy certificate. Its inventory must
 * be collected independently of the candidate being checked. Unknown source
 * regions remain blocking even if all readable text matches.
 */
export interface QuotationSourceSegment {
  id: string;
  page: number;
  section: string;
  text: string;
  disposition: "item" | "document" | "boilerplate" | "uncertain";
  classificationReason?: string;
}

export interface QuotationContentCandidate {
  section: string;
  text: string;
}

export interface QuotationCoverageIssue {
  segmentId: string;
  page: number;
  section: string;
  kind: "invalid_inventory" | "uncertain" | "missing" | "misplaced" | "duplicate";
}

// Do not remove punctuation, accents, numbers or units: those can change the
// meaning of a specification. Normalize only typography and whitespace.
export function normalizeQuotationText(text: string): string {
  return text.normalize("NFC").replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    const before = cursor === 0 ? "" : haystack[cursor - 1];
    const after = haystack[cursor + needle.length] ?? "";
    // Avoid certifying 15 mm as present in 115 mm.
    if (!/[0-9A-Za-zÀ-ÿ]/.test(before) && !/[0-9A-Za-zÀ-ÿ]/.test(after)) count++;
    cursor += needle.length;
  }
  return count;
}

export function compareQuotationContent(
  source: QuotationSourceSegment[],
  candidates: QuotationContentCandidate[],
  documentText: string,
): { complete: boolean; issues: QuotationCoverageIssue[] } {
  const issues: QuotationCoverageIssue[] = [];
  const ids = new Set<string>();
  const normalized = candidates.map(c => ({ ...c, text: normalizeQuotationText(c.text) }));
  const document = normalizeQuotationText(documentText);
  if (!source.length) {
    return { complete: false, issues: [{ segmentId: "", page: 0, section: "", kind: "invalid_inventory" }] };
  }
  for (const segment of source) {
    const issue = (kind: QuotationCoverageIssue["kind"]) =>
      issues.push({ segmentId: segment.id, page: segment.page, section: segment.section, kind });
    const text = normalizeQuotationText(segment.text);
    if (!segment.id || ids.has(segment.id) || !Number.isInteger(segment.page) || segment.page < 1
      || !segment.section || (!text && segment.disposition !== "uncertain")) {
      issue("invalid_inventory");
      continue;
    }
    ids.add(segment.id);
    if (segment.disposition === "uncertain") {
      issue("uncertain");
      continue;
    }
    if (segment.disposition === "boilerplate") {
      if (!segment.classificationReason?.trim()) issue("invalid_inventory");
      continue;
    }
    if (segment.disposition !== "item" && segment.disposition !== "document") {
      issue("invalid_inventory");
      continue;
    }
    const targets = segment.disposition === "document"
      ? [document] : normalized.filter(c => c.section === segment.section).map(c => c.text);
    const expectedCount = source.filter(s => s.section === segment.section
      && s.disposition === segment.disposition && normalizeQuotationText(s.text) === text).length;
    const count = targets.reduce((sum, target) => sum + occurrences(target, text), 0);
    if (count > expectedCount) issue("duplicate");
    if (count < expectedCount) {
      const elsewhere = normalized.some(c => c.section !== segment.section && occurrences(c.text, text) > 0);
      issue(elsewhere ? "misplaced" : "missing");
    }
  }
  return { complete: issues.length === 0, issues };
}