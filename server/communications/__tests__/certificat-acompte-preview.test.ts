import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * Task #536 — Confirm the certificat PDF preview renders correctly for an
 * acompte certificat after the Task #535 reorder (parties → works →
 * financials → amount-in-words → banking → footers).
 *
 * We call `buildCertificatPreviewHtml({ isAcompte: true })` which uses the
 * same stub data as the regular preview but sets `isAcompte: true` and
 * `acompteDevisId` on the sample certificat.  Storage logo loading is
 * swallowed by loadLogoAsBase64's own try/catch so the test works
 * without a live DB.
 */

// loadLogoAsBase64 calls storage.getTemplateAssetByType; mock it out so the
// test is fully hermetic.
vi.mock("../../storage", () => ({
  storage: {
    getTemplateAssetByType: vi.fn().mockResolvedValue(null),
  },
}));

import { buildCertificatPreviewHtml } from "../certificat-generator";

describe("certificat preview — acompte variant (post-#535 reorder)", () => {
  let html: string;

  // Render once; all assertions share the same output.
  beforeAll(async () => {
    html = await buildCertificatPreviewHtml({ isAcompte: true });
  });

  // ── structural order ────────────────────────────────────────────────────
  // Required sequence: parties → works → financials → amount-in-words →
  //                    banking → explain → footer

  it("parties-grid appears before works-table", () => {
    const partiesPos = html.indexOf('class="parties-grid"');
    const worksPos = html.indexOf('class="works-table"');
    expect(partiesPos).toBeGreaterThanOrEqual(0);
    expect(worksPos).toBeGreaterThanOrEqual(0);
    expect(partiesPos).toBeLessThan(worksPos);
  });

  it("works-table appears before cert-grid (financials)", () => {
    const worksPos = html.indexOf('class="works-table"');
    const certGridPos = html.indexOf('class="cert-grid"');
    expect(worksPos).toBeGreaterThanOrEqual(0);
    expect(certGridPos).toBeGreaterThanOrEqual(0);
    expect(worksPos).toBeLessThan(certGridPos);
  });

  it("cert-grid appears before amount-in-words", () => {
    const certGridPos = html.indexOf('class="cert-grid"');
    const amountWordsPos = html.indexOf('class="payment-amount-words"');
    expect(certGridPos).toBeGreaterThanOrEqual(0);
    expect(amountWordsPos).toBeGreaterThanOrEqual(0);
    expect(certGridPos).toBeLessThan(amountWordsPos);
  });

  it("amount-in-words appears before banking-card", () => {
    const amountWordsPos = html.indexOf('class="payment-amount-words"');
    const bankingPos = html.indexOf('class="banking-card"');
    expect(amountWordsPos).toBeGreaterThanOrEqual(0);
    expect(bankingPos).toBeGreaterThanOrEqual(0);
    expect(amountWordsPos).toBeLessThan(bankingPos);
  });

  it("banking-card appears before explain-section", () => {
    const bankingPos = html.indexOf('class="banking-card"');
    const explainPos = html.indexOf('class="explain-section"');
    expect(bankingPos).toBeGreaterThanOrEqual(0);
    expect(explainPos).toBeGreaterThanOrEqual(0);
    expect(bankingPos).toBeLessThan(explainPos);
  });

  it("explain-section appears before doc-footer", () => {
    const explainPos = html.indexOf('class="explain-section"');
    const footerPos = html.indexOf('class="doc-footer"');
    expect(explainPos).toBeGreaterThanOrEqual(0);
    expect(footerPos).toBeGreaterThanOrEqual(0);
    expect(explainPos).toBeLessThan(footerPos);
  });

  // ── IBAN / BIC rendered in red: CSS rule-block scoped assertions ────────

  it("IBAN value CSS rule block specifically sets color to #B23A48", () => {
    // The style block contains:
    //   .banking-key-iban .banking-key-value { ... color: #B23A48; ... }
    // Extract just that rule block and assert the colour is present there.
    const ibanRuleMatch = html.match(
      /\.banking-key-iban\s+\.banking-key-value\s*\{([^}]*)\}/
    );
    expect(ibanRuleMatch).not.toBeNull();
    expect(ibanRuleMatch![1]).toContain("#B23A48");
  });

  it("BIC value CSS rule block specifically sets color to #B23A48", () => {
    const bicRuleMatch = html.match(
      /\.banking-key-bic\s+\.banking-key-value\s*\{([^}]*)\}/
    );
    expect(bicRuleMatch).not.toBeNull();
    expect(bicRuleMatch![1]).toContain("#B23A48");
  });

  it("IBAN printed value (FR76…) is rendered inside the banking-card block", () => {
    // Sample contractor: IBAN FR7630006000011234567890189 → grouped "FR76 3000 …"
    const bankingStart = html.indexOf('class="banking-card"');
    const bankingEnd = html.indexOf('class="explain-section"');
    expect(bankingStart).toBeGreaterThanOrEqual(0);
    expect(bankingEnd).toBeGreaterThan(bankingStart);
    const bankingBlock = html.slice(bankingStart, bankingEnd);
    expect(bankingBlock).toContain("FR76");
  });

  it("BIC value (BNPAFRPP) is rendered inside the banking-card block", () => {
    const bankingStart = html.indexOf('class="banking-card"');
    const bankingEnd = html.indexOf('class="explain-section"');
    const bankingBlock = html.slice(bankingStart, bankingEnd);
    expect(bankingBlock).toContain("BNPAFRPP");
  });

  // ── acompte-specific content ────────────────────────────────────────────

  it("header labels the document as an acompte", () => {
    expect(html).toContain("Certificat de Paiement \u2014 Acompte");
    expect(html).toContain("Opening / Deposit Payment");
  });

  it("explain section shows the acompte card with deposit-recovery text", () => {
    expect(html).toContain("Acompte (opening / deposit payment)");
    expect(html).toContain("deducted from the next certificat");
  });

  it("explain section omits the Retenue de Garantie card", () => {
    expect(html).not.toContain("Retenue de Garantie (retention)");
  });

  it("explain section omits the Compte Prorata card", () => {
    expect(html).not.toContain("Compte Prorata (shared site costs)");
  });

  // ── sanity: non-acompte preview is unchanged ────────────────────────────

  it("non-acompte preview still shows retenue and prorata cards", async () => {
    const regularHtml = await buildCertificatPreviewHtml();
    expect(regularHtml).toContain("Retenue de Garantie (retention)");
    expect(regularHtml).toContain("Compte Prorata (shared site costs)");
    expect(regularHtml).not.toContain("Certificat de Paiement \u2014 Acompte");
  });
});
