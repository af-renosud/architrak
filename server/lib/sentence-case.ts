// Normalize free-text fields entered into the devis setup flow (manual or
// AI-extracted) to Sentence case so the project breakdown UI doesn't show a
// jarring mix of "PROJET CONSTRUCTION PISCINE", "Aménagement Piscine" and
// "Accès provisoire de chantier" side by side. Locale is fr-FR so accented
// letters (é, à, ç, etc.) round-trip correctly through case folding.

const LOCALE = "fr-FR";

/**
 * Lowercase the whole string, then re-capitalize the very first letter and
 * the first letter after each sentence terminator (`.`, `!`, `?`) followed
 * by whitespace. Returns null/undefined unchanged so callers can chain.
 */
export function toSentenceCase<T extends string | null | undefined>(input: T): T {
  if (input == null) return input;
  const raw = String(input);
  const trimmed = raw.trim();
  if (!trimmed) return raw as T;

  const lower = trimmed.toLocaleLowerCase(LOCALE);
  // Match the first non-whitespace char of the string and the first
  // non-whitespace char after `.`, `!`, or `?` followed by whitespace.
  // We use [^\s] (instead of \p{L}) so accented letters like "é" still
  // get capitalized without needing Unicode property escapes, which the
  // current TS target does not support.
  const cased = lower.replace(
    /(^|[.!?]\s+)([^\s])/g,
    (_match, sep: string, ch: string) => sep + ch.toLocaleUpperCase(LOCALE),
  );
  return cased as T;
}

/**
 * In-place normalization of the standard devis-level text fields.
 * Returns the same reference so callers can use it inline.
 */
export function normalizeDevisText<T extends { descriptionFr?: unknown; descriptionUk?: unknown }>(body: T): T {
  if (typeof body?.descriptionFr === "string") {
    body.descriptionFr = toSentenceCase(body.descriptionFr) as typeof body.descriptionFr;
  }
  if (typeof body?.descriptionUk === "string") {
    body.descriptionUk = toSentenceCase(body.descriptionUk) as typeof body.descriptionUk;
  }
  return body;
}

export function normalizeLineItemText<T extends { description?: unknown }>(body: T): T {
  if (typeof body?.description === "string") {
    body.description = toSentenceCase(body.description) as typeof body.description;
  }
  return body;
}
