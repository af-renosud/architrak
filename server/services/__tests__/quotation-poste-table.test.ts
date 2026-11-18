import { describe, expect, it } from "vitest";
import { recoverPosteTable } from "../quotation-poste-table";
import { recoverSourceVat } from "../quotation-vat-recovery";
import type { ArchitectCorrectionSnapshot } from "../../../shared/architect-quotation";

const header = "Description     Qté     P.U. HT     Montant HT     Montant TTC     TVA";
const zero = (text: string) => `${text}     0,00     0,00     0,00     0,00     0,00`;
const price = (text: string, amount = "100,00", ttc = "120,00") =>
  `${text}     1,00     ${amount}     ${amount}     ${ttc}     20,00`;
const totals = "Total HT     200,00\nTotal TTC     240,00";
const source = [
  `${header}\n${zero("LOT PS PISCINE")}\n${zero("PS.26 Diagnostic")}\n${price("TOTAL DU POSTE")}\n${zero("PS.27 Heat pump")}\n${zero("• Supply")}\nSiret : footer`,
  `${header}\n${zero("• Install and test")}\n${price("TOTAL DU POSTE")}\nSiret : footer`,
  `${header}\nDevis gratuit\n${totals}`,
];

describe("native terminating-price quotation tables", () => {
  it("retains equal-price items and joins a cross-page specification exactly once", () => {
    const result = recoverPosteTable(source)!;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1].description).toBe("PS.27 Heat pump\n• Supply\n• Install and test");
    expect(result.evidence[1].pages).toEqual([1, 2]);
    expect(result.amountHt).toBe(200);
    expect(result.amountTtc).toBe(240);
  });
  it("refuses missing or unreadable pages", () => {
    expect(recoverPosteTable([source[0], null, source[2]])).toBeNull();
  });
  it("refuses headerless specification-only continuation pages", () => {
    expect(recoverPosteTable([source[0], "Additional mandatory installation specifications", ...source.slice(1)])).toBeNull();
  });
  it("refuses nonzero LOT rows even when they cancel", () => {
    const pages = [...source];
    pages[1] = pages[1].replace("Siret", `${price("LOT fee", "10,00", "12,00")}\n${price("LOT discount", "-10,00", "-12,00")}\nSiret`);
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it.each(["10,00", "10", "10 EUR", "10.00 €"])("refuses cancelling incomplete columns under LOT headings (%s)", value => {
    const pages = [...source];
    pages[0] = pages[0].replace(zero("LOT PS PISCINE"), `${zero("LOT PS PISCINE")}\nFee     ${value}\nCredit     -${value}`);
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it.each(["Fee 10,00\nCredit -10,00", "Fee 10.00\nCredit (10.00)", "Fee +10,00\nCredit −10,00"])("refuses monetary text without full column spacing: %s", charges => {
    expect(recoverPosteTable(source.map(page => page.replace(zero("LOT PS PISCINE"), `${zero("LOT PS PISCINE")}\n${charges}`)))).toBeNull();
  });
  it.each(["10,00 HT", "10,00 TTC", "10 HT", "10 TTC", "10,00 applicable", "10,00 EUR HT"])("refuses suffixed charges in every ignored region: %s", amount => {
    const charges = `Frais     ${amount}\nAvoir     -${amount}`;
    const underLot = source.map(page => page.replace(zero("LOT PS PISCINE"), `${zero("LOT PS PISCINE")}\n${charges}`));
    const beforeHeader = [`${charges}\n${source[0]}`, ...source.slice(1)];
    const afterFooter = [source[0], `${source[1]}\n${charges}`, source[2]];
    for (const pages of [underLot, beforeHeader, afterFooter]) expect(recoverPosteTable(pages)).toBeNull();
  });
  it.each(["10 €", "€10", "EUR 10", "10,00 HT", "10,00 TTC"])("rejects description charges with misleading zero columns: %s", amount => {
    const charges = `${zero(`Frais ${amount}`)}\n${zero(`Avoir -${amount}`)}`;
    expect(recoverPosteTable(source.map(page => page.replace(zero("LOT PS PISCINE"), `${zero("LOT PS PISCINE")}\n${charges}`)))).toBeNull();
    expect(recoverPosteTable(source.map(page => page.replace(zero("LOT PS PISCINE"), zero(`LOT Frais ${amount}`))))).toBeNull();
    expect(recoverPosteTable(source.map(page => page.replace(zero("• Supply"), zero(`• Supply ${amount}`))))).toBeNull();
  });
  it.each(["before-header", "after-footer", "stop-marker"])("refuses charges in ignored regions: %s", region => {
    const pages = [...source];
    const charges = "Fee     10,00\nCredit     -10,00";
    if (region === "before-header") pages[0] = `${charges}\n${pages[0]}`;
    if (region === "after-footer") pages[1] += `\n${charges}`;
    if (region === "stop-marker") pages[2] = pages[2].replace("Devis gratuit", "Devis gratuit     10,00\nCredit     -10,00");
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it("allows only verified tax-summary shapes, not labelled charges beside them", () => {
    const pages = [...source];
    pages[2] = `${header}\nDevis gratuit\nTaux     Base HT     Montant TVA\n20,00     200,00     40,00\n${totals}`;
    expect(recoverPosteTable(pages)).not.toBeNull();
    pages[2] += "\nFee     10,00\nCredit     -10,00";
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it("does not mistake extra numeric rows for legitimate tax metadata", () => {
    const pages = [...source.slice(0, 2), `${header}\nDevis gratuit\nTaux     Base HT     Montant TVA\n20,00     200,00     40,00\n10,00     10,00     1,00\n${totals}`];
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it("retains source-backed VAT suggestions without changing content and refuses polluted sources", () => {
    const snapshot = { version: "v1", baseline: { ttc: "240.00" }, draft: { discountHt: "0.00", lines: [
      { clientKey: "diagnostic", kind: "priced", included: true, descriptionFr: "PS.26 Architect wording", descriptionEn: "Reviewed translation", totalHt: "100.00", vatRate: "" },
      { clientKey: "pump", kind: "priced", included: true, descriptionFr: "PS.27 Architect wording", totalHt: "100.00", vatRate: "" },
    ] } } as ArchitectCorrectionSnapshot;
    const before = JSON.stringify(snapshot);
    expect(recoverSourceVat(source, snapshot).rates.map(row => row.vatRate)).toEqual(["20.00", "20.00"]);
    expect(JSON.stringify(snapshot)).toBe(before);
    const polluted = [...source];
    polluted[0] = polluted[0].replace(zero("LOT PS PISCINE"), `${zero("LOT PS PISCINE")}\nFee     10,00\nCredit     -10,00`);
    expect(() => recoverSourceVat(polluted, snapshot)).toThrow("could not be verified");
    for (const charges of ["Frais     10,00 HT\nAvoir     -10,00 HT", `${zero("Frais 10 €")}\n${zero("Avoir -10 €")}`]) {
      const pages = source.map(page => page.replace(zero("LOT PS PISCINE"), `${zero("LOT PS PISCINE")}\n${charges}`));
      expect(() => recoverSourceVat(pages, snapshot)).toThrow("could not be verified");
    }
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("accepts a labelled net total beside bank-section heading, not arbitrary monetary content", () => {
    expect(recoverPosteTable([...source.slice(0, 2), `${source[2]}\nCoordonnées bancaires société :     Net à payer     240,00 €`])).not.toBeNull();
    expect(recoverPosteTable([...source.slice(0, 2), `${source[2]}\nCoordonnées bancaires société :     Fee     10,00 €\nCredit     -10,00 €`])).toBeNull();
    expect(recoverPosteTable(source.map(page => page.replace(header, `${header}     10,00`)))).toBeNull();
  });
  it("refuses unsupported non-zero rows even when their amounts cancel", () => {
    const pages = [...source];
    pages[1] = pages[1].replace("Siret", `${price("Fee", "10,00", "12,00")}\nAdjustment     -10,00\nSiret`);
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it("refuses printed-total mismatch rather than inventing balancing items", () => {
    expect(recoverPosteTable([...source.slice(0, 2), source[2].replace("200,00", "300,00")])).toBeNull();
  });
  it("does not guess when a new reference interrupts an unpriced specification", () => {
    const pages = [...source];
    pages[1] = pages[1].replace("• Install", "PS.28 Install");
    expect(recoverPosteTable(pages)).toBeNull();
  });
  it("does not accept duplicate printed totals", () => {
    expect(recoverPosteTable([...source, totals])).toBeNull();
  });
  it("refuses conflicting row tax arithmetic", () => {
    expect(recoverPosteTable(source.map(page => page.replace("120,00", "130,00")))).toBeNull();
  });
});
