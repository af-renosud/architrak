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
  kind: "invalid_inventory" | "uncertain" | "missing" | "misplaced" | "duplicate" | "unattributed";
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
    // A short segment may also occur legitimately within a longer source
    // paragraph. Count source occurrences, not merely identical segment rows.
    const expectedCount = occurrences(normalizeQuotationText(source.filter(s => s.section === segment.section
      && s.disposition === segment.disposition).map(s => s.text).join("\n")), text);
    const count = targets.reduce((sum, target) => sum + occurrences(target, text), 0);
    if (count > expectedCount) issue("duplicate");
    if (count < expectedCount) {
      const elsewhere = normalized.some(c => c.section !== segment.section && occurrences(c.text, text) > 0);
      issue(elsewhere ? "misplaced" : "missing");
    }
  }
  // Check the reverse direction too: all candidate text must belong to this
  // section's source. Merely finding every source passage misses extra or
  // cross-section specifications appended to an otherwise correct product.
  for (const candidate of [...normalized.map(c => ({ ...c, document: false })),
    { section: "document", text: document, document: true }]) {
    const allowed = source.filter(s => candidate.document ? s.disposition === "document"
      : s.disposition === "item" && s.section === candidate.section);
    const covered = new Uint8Array(candidate.text.length);
    for (const segment of allowed) {
      const text = normalizeQuotationText(segment.text);
      if (!text) continue;
      let cursor = 0;
      while ((cursor = candidate.text.indexOf(text, cursor)) !== -1) {
        const before = candidate.text[cursor - 1] ?? "";
        const after = candidate.text[cursor + text.length] ?? "";
        if (!/[0-9A-Za-zÀ-ÿ]/.test(before) && !/[0-9A-Za-zÀ-ÿ]/.test(after))
          covered.fill(1, cursor, cursor + text.length);
        cursor += text.length;
      }
    }
    if (candidate.text.split("").some((char, i) => !covered[i] && !/\s/.test(char))) {
      const location = allowed[0];
      issues.push({ segmentId: location?.id ?? "", page: location?.page ?? 0, section: candidate.section,
        kind: "unattributed" });
    }
  }
  return { complete: issues.length === 0, issues };
}