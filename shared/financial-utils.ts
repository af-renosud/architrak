export function roundCurrency(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
}

export function calculateTva(amountHt: number, tvaRate: number): number {
  return roundCurrency(amountHt * tvaRate / 100);
}

export function calculateTtc(amountHt: number, tvaRate: number): number {
  return roundCurrency(amountHt * (1 + tvaRate / 100));
}

export function calculateHtFromTtc(amountTtc: number, tvaRate: number): number {
  return roundCurrency(amountTtc / (1 + tvaRate / 100));
}

export function calculateAdjustedAmount(originalHt: number, pvTotal: number, mvTotal: number): number {
  return roundCurrency(originalHt + pvTotal - mvTotal);
}

export function calculateResteARealiser(adjustedHt: number, certifiedHt: number): number {
  return roundCurrency(adjustedHt - certifiedHt);
}

export function calculateFeeAmount(invoiceHt: number, feeRate: number): number {
  return roundCurrency(invoiceHt * feeRate / 100);
}

export function calculateFeeTtc(feeAmountHt: number, tvaRate: number): number {
  return roundCurrency(feeAmountHt * (1 + tvaRate / 100));
}

export function formatCurrencyEur(value: number): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value);
}

export function formatCurrencyNoSymbol(value: number): string {
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + " \u20AC";
}

export function numberToFrenchWords(n: number): string {
  if (n === 0) return "Z\u00C9RO EUROS";

  const units = ["", "UN", "DEUX", "TROIS", "QUATRE", "CINQ", "SIX", "SEPT", "HUIT", "NEUF",
    "DIX", "ONZE", "DOUZE", "TREIZE", "QUATORZE", "QUINZE", "SEIZE", "DIX-SEPT", "DIX-HUIT", "DIX-NEUF"];
  const tens = ["", "", "VINGT", "TRENTE", "QUARANTE", "CINQUANTE", "SOIXANTE", "SOIXANTE", "QUATRE-VINGT", "QUATRE-VINGT"];

  function chunk(num: number): string {
    if (num === 0) return "";
    if (num < 20) return units[num];
    if (num < 70) {
      const t = Math.floor(num / 10);
      const u = num % 10;
      if (u === 0) return tens[t];
      if (u === 1 && t !== 8) return `${tens[t]} ET UN`;
      return `${tens[t]}-${units[u]}`;
    }
    if (num < 80) {
      const u = num - 60;
      if (u === 11) return "SOIXANTE ET ONZE";
      return `SOIXANTE-${units[u]}`;
    }
    if (num < 100) {
      const u = num - 80;
      if (u === 0) return "QUATRE-VINGTS";
      return `QUATRE-VINGT-${units[u]}`;
    }
    if (num < 200) {
      const r = num - 100;
      if (r === 0) return "CENT";
      return `CENT ${chunk(r)}`;
    }
    if (num < 1000) {
      const h = Math.floor(num / 100);
      const r = num % 100;
      if (r === 0) return `${units[h]} CENTS`;
      return `${units[h]} CENT ${chunk(r)}`;
    }
    return "";
  }

  const rounded = roundCurrency(n);
  let euros = Math.floor(rounded);
  let cents = Math.round((rounded - euros) * 100);

  if (cents >= 100) {
    euros += 1;
    cents -= 100;
  }

  let result = "";

  if (euros >= 1000000) {
    const millions = Math.floor(euros / 1000000);
    const remainder = euros % 1000000;
    result += millions === 1 ? "UN MILLION" : `${chunk(millions)} MILLIONS`;
    if (remainder > 0) result += " " + buildThousands(remainder);
  } else if (euros > 0) {
    result = buildThousands(euros);
  } else {
    result = "Z\u00C9RO";
  }

  function buildThousands(num: number): string {
    if (num === 0) return "";
    if (num < 1000) return chunk(num);
    const thousands = Math.floor(num / 1000);
    const remainder = num % 1000;
    let prefix = chunk(thousands);
    prefix = prefix.replace(/CENTS$/, "CENT").replace(/VINGTS$/, "VINGT");
    let s = thousands === 1 ? "MILLE" : `${prefix} MILLE`;
    if (remainder > 0) s += " " + chunk(remainder);
    return s;
  }

  result += " EURO" + (euros !== 1 ? "S" : "");
  if (cents > 0) {
    result += ` ET ${chunk(cents)} CENTIME${cents !== 1 ? "S" : ""}`;
  }

  return result.trim();
}
