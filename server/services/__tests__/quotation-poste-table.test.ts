import { describe, expect, it } from "vitest";
import { recoverPosteTable } from "../quotation-poste-table";

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
