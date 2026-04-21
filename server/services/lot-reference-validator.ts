import type { ParsedDocument } from "../gmail/document-parser";
import type { ValidationWarning } from "./extraction-validator";
import { storage } from "../storage";

export function extractCandidateCodes(reference: string): string[] {
  if (!reference) return [];
  const cleaned = reference.replace(/lot/gi, " ").toUpperCase();
  const tokens = cleaned.split(/[^A-Z0-9]+/).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (t.length > 16) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export async function checkLotReferencesAgainstCatalog(
  parsed: ParsedDocument,
): Promise<ValidationWarning[]> {
  const refs = parsed.lotReferences ?? [];
  if (refs.length === 0) return [];

  const warnings: ValidationWarning[] = [];
  const reportedMissing = new Set<string>();

  for (const raw of refs) {
    const candidates = extractCandidateCodes(raw);
    if (candidates.length === 0) continue;

    let matched: string | null = null;
    for (const code of candidates) {
      const entry = await storage.getLotCatalogByCode(code);
      if (entry) {
        matched = entry.code;
        break;
      }
    }

    if (!matched) {
      const key = candidates.join("|");
      if (reportedMissing.has(key)) continue;
      reportedMissing.add(key);
      warnings.push({
        field: "lotReferences",
        expected: "code present in master lot catalog",
        actual: raw,
        message: `Suggested lot reference "${raw}" does not match any code in the master lot catalog — needs new lot before assignment.`,
        severity: "warning",
      });
    }
  }

  return warnings;
}
