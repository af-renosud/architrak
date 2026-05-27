/**
 * IBAN / BIC validators for the contractor banking gate (Task #225).
 *
 * - normaliseIban / normaliseBic strip whitespace and upper-case.
 * - validateIban runs the ISO 13616 mod-97 checksum after a shape check
 *   (2-letter country, 2-digit checksum, 11..30 BBAN of [A-Z0-9]).
 * - validateBic enforces the SWIFT 8/11-char shape (6 letters + 2
 *   alphanumeric + optional 3 alphanumeric).
 *
 * Both validators return a discriminated result `{ valid, normalised,
 * reason? }` so callers can surface a specific French message ("IBAN
 * invalide : checksum") without re-running the regex.
 *
 * Pure module: no DB, no I/O, no env reads. Safe to import in both the
 * client and the server.
 */

export type IbanValidationReason = "empty" | "length" | "format" | "checksum";
export type BicValidationReason = "empty" | "length" | "format";

export interface IbanValidationResult {
  valid: boolean;
  normalised: string;
  reason?: IbanValidationReason;
}

export interface BicValidationResult {
  valid: boolean;
  normalised: string;
  reason?: BicValidationReason;
}

export function normaliseIban(raw: string | null | undefined): string {
  if (raw == null) return "";
  return String(raw).replace(/\s+/g, "").toUpperCase();
}

export function normaliseBic(raw: string | null | undefined): string {
  if (raw == null) return "";
  return String(raw).replace(/\s+/g, "").toUpperCase();
}

export function validateIban(raw: string | null | undefined): IbanValidationResult {
  const normalised = normaliseIban(raw);
  if (normalised.length === 0) return { valid: false, normalised, reason: "empty" };
  // ISO 13616: total length 15..34 (4-char header + 11..30 BBAN).
  if (normalised.length < 15 || normalised.length > 34) {
    return { valid: false, normalised, reason: "length" };
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalised)) {
    return { valid: false, normalised, reason: "format" };
  }
  // mod-97 checksum: move first 4 chars to the end, replace letters with
  // their 10..35 numeric codes, reduce modulo 97. Must equal 1.
  const rearranged = normalised.slice(4) + normalised.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digit = code >= 65 ? code - 55 : code - 48; // 'A'=65→10; '0'=48→0
    const stride = digit >= 10 ? 100 : 10;
    remainder = (remainder * stride + digit) % 97;
  }
  if (remainder !== 1) return { valid: false, normalised, reason: "checksum" };
  return { valid: true, normalised };
}

export function validateBic(raw: string | null | undefined): BicValidationResult {
  const normalised = normaliseBic(raw);
  if (normalised.length === 0) return { valid: false, normalised, reason: "empty" };
  if (normalised.length !== 8 && normalised.length !== 11) {
    return { valid: false, normalised, reason: "length" };
  }
  // SWIFT BIC: 4-letter bank + 2-letter country + 2 alphanumeric location
  // + optional 3 alphanumeric branch.
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(normalised)) {
    return { valid: false, normalised, reason: "format" };
  }
  return { valid: true, normalised };
}

/**
 * Two IBANs are "the same" iff they normalise to the same string. We
 * compare on normalised form (whitespace-insensitive, case-insensitive)
 * to avoid false-positive mismatches from cosmetic formatting on the
 * supplier doc vs. the ArchiDoc record.
 */
export function ibansMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normaliseIban(a);
  const nb = normaliseIban(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb;
}

/**
 * Helper used by the gmail/devis/invoice ingestion services: takes the
 * verbatim IBAN/BIC the AI extracted from the supplier document and
 * returns the normalised form for storage in extracted_iban/bic — but
 * only when the value passes its checksum/shape check. Invalid values
 * are dropped to NULL on purpose: a stored value here is later compared
 * against contractor.iban, and a garbage value would either cause noisy
 * false-positive mismatches or be impossible to tell apart from a real
 * fraudulent IBAN. The validators are the perimeter.
 */
export function safeExtractIban(raw: string | null | undefined): string | null {
  if (raw == null || String(raw).trim() === "") return null;
  const r = validateIban(raw);
  return r.valid ? r.normalised : null;
}

export function safeExtractBic(raw: string | null | undefined): string | null {
  if (raw == null || String(raw).trim() === "") return null;
  const r = validateBic(raw);
  return r.valid ? r.normalised : null;
}
