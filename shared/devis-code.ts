// Pure helpers for the structured devis-code (Task #176). Shared between
// the server (validation + composition + DB lookups) and the client (live
// preview + reverse-parse of legacy stored codes).

export const DEVIS_CODE_MAX_LOT_REF = 16;
export const DEVIS_CODE_MAX_DESCRIPTION = 200;
export const DEVIS_CODE_MAX_NUMBER = 9999;

export interface DevisCodeParts {
  lotRef: string;
  lotSequence: number;
  description: string;
}

export interface DevisCodeValidationError {
  field: "lotRef" | "lotSequence" | "description";
  message: string;
}

export function validateDevisCodeParts(parts: Partial<DevisCodeParts>): DevisCodeValidationError[] {
  const errors: DevisCodeValidationError[] = [];
  const lotRef = (parts.lotRef ?? "").trim();
  if (!lotRef) {
    errors.push({ field: "lotRef", message: "Lot reference is required" });
  } else {
    if (lotRef.includes(".")) errors.push({ field: "lotRef", message: "Lot reference cannot contain a dot" });
    if (lotRef.length > DEVIS_CODE_MAX_LOT_REF) {
      errors.push({ field: "lotRef", message: `Lot reference must be ${DEVIS_CODE_MAX_LOT_REF} characters or less` });
    }
  }
  const seq = parts.lotSequence;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || seq > DEVIS_CODE_MAX_NUMBER) {
    errors.push({ field: "lotSequence", message: `Number must be a positive integer (1–${DEVIS_CODE_MAX_NUMBER})` });
  }
  const description = (parts.description ?? "").trim();
  if (!description) {
    errors.push({ field: "description", message: "Description is required" });
  } else if (description.length > DEVIS_CODE_MAX_DESCRIPTION) {
    errors.push({ field: "description", message: `Description must be ${DEVIS_CODE_MAX_DESCRIPTION} characters or less` });
  }
  return errors;
}

export function composeDevisCode(parts: DevisCodeParts): string {
  return `${parts.lotRef.trim().toUpperCase()}.${parts.lotSequence}.${parts.description.trim()}`;
}

/**
 * Best-effort split of a stored devisCode into its three parts. Returns
 * null when the string doesn't match the structured shape (legacy
 * free-text codes). Description allows internal dots.
 */
export function tryParseDevisCode(code: string | null | undefined): DevisCodeParts | null {
  if (!code) return null;
  const first = code.indexOf(".");
  if (first <= 0) return null;
  const second = code.indexOf(".", first + 1);
  if (second <= first + 1) return null;
  const lotRef = code.slice(0, first);
  const numberStr = code.slice(first + 1, second);
  const description = code.slice(second + 1);
  if (lotRef.includes(".")) return null;
  const seq = Number(numberStr);
  if (!Number.isInteger(seq) || seq < 1) return null;
  if (!description.trim()) return null;
  return { lotRef, lotSequence: seq, description };
}
