/** Strict euro input parsing. Never discard unknown characters or round cents. */
export type MoneyInputResult =
  | { kind: "valid"; value: string }
  | { kind: "ambiguous"; candidate: string; message: string }
  | { kind: "invalid"; message: string };

export function parseMoneyInput(raw: string): MoneyInputResult {
  const invalid = (message = "Paste one euro amount with no more than two decimal places."): MoneyInputResult => ({ kind: "invalid", message });
  if (raw.length > 120) return invalid();
  let text = raw.trim().replace(/[\u00a0\u202f]/g, " ").replace(/\u2019/g, "'");
  // Currency is allowed once, at either edge; other currencies are not converted.
  if ((text.match(/€|EUR/gi) ?? []).length > 1) return invalid();
  text = text.replace(/^(?:€|EUR)\s*/i, "").replace(/\s*(?:€|EUR)$/i, "");
  if (!text || !/^[0-9., ']+$/.test(text)) return invalid();
  const canonical = (integer: string, fraction = ""): MoneyInputResult => {
    const digits = integer.replace(/^0+(?=\d)/, "");
    if (digits.length > 10) return invalid("Amount must not exceed 9999999999.99.");
    return { kind: "valid", value: `${digits}.${fraction.padEnd(2, "0")}` };
  };
  const integerDigits = (part: string): string | null => {
    if (/^\d+$/.test(part)) return part;
    // Require consistent, correctly placed groups rather than stripping separators blindly.
    const match = part.match(/^([1-9]\d{0,2})([ .,'])(\d{3}(?:[ .,']\d{3})*)$/);
    if (!match || part.split(match[2]).some((group, i) => i > 0 && !/^\d{3}$/.test(group))) return null;
    return part.split(match[2]).join("");
  };
  const decimal = text.match(/^(.*)[.,](\d{1,2})$/);
  if (decimal) {
    const separator = text[text.length - decimal[2].length - 1];
    if (decimal[1].includes(separator)) return invalid("Check the grouping and decimal separators.");
    const integer = integerDigits(decimal[1]);
    return integer === null ? invalid("Check the thousands grouping.") : canonical(integer, decimal[2]);
  }
  const integer = integerDigits(text);
  if (integer === null) return invalid();
  const result = canonical(integer);
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(text) && result.kind === "valid") {
    return { kind: "ambiguous", candidate: result.value, message: "This could be thousands grouping or three decimal places. Confirm the whole-number amount below; three-decimal amounts cannot be saved without changing their value." };
  }
  return result;
}

export function normalizeMoneyInput(raw: string): string {
  const result = parseMoneyInput(raw);
  if (result.kind !== "valid") throw new Error(result.message);
  return result.value;
}

export function displayMoneyInput(value: string): string {
  const [integer, cents] = value.split(".");
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f")},${cents} €`;
}
