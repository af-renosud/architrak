import { describe, it, expect } from "vitest";
import {
  detectPaidConfirmation,
  stripQuotedReply,
  extractAddress,
  extractPlainText,
} from "../certificat-payment-suggestions.service";

/**
 * Task #466 — deterministic "paid" detection pins.
 * The phrase set is CLOSED: future-tense promises must not match, and the
 * quoted original certificat email must never trigger against itself.
 */

describe("detectPaidConfirmation", () => {
  it.each([
    "Bonjour, le certificat a été payé ce matin.",
    "Facture réglée hier, cordialement.",
    "Le virement effectué ce jour couvre le solde.",
    "Règlement effectué par notre comptabilité.",
    "Hi, this invoice was paid yesterday.",
    "Payment sent this morning, thanks.",
    "Transfer completed on our side.",
  ])("matches confirmation: %s", (text) => {
    const r = detectPaidConfirmation(text);
    expect(r.matched).toBe(true);
    expect(r.excerpt).toBeTruthy();
  });

  it.each([
    "Nous allons procéder au virement la semaine prochaine.",
    "Merci pour le certificat, nous vérifions les montants.",
    "Pouvez-vous renvoyer le RIB ?",
    "We will process the payment next week.",
    "Question about the retenue de garantie.",
  ])("does NOT match non-confirmation: %s", (text) => {
    expect(detectPaidConfirmation(text).matched).toBe(false);
  });

  it("never matches keywords inside the quoted original email", () => {
    const reply = [
      "Merci, bien reçu.",
      "",
      "Le 12 août 2026 à 10:00, SAS Architects-France a écrit :",
      "> Veuillez trouver le certificat de paiement. Montant payé à ce jour: ...",
    ].join("\n");
    expect(detectPaidConfirmation(reply).matched).toBe(false);
  });

  it("excerpt contains the matched phrase with context", () => {
    const r = detectPaidConfirmation("Bonjour,\nLe virement effectué ce jour, réf VIR-123.\nCordialement");
    expect(r.excerpt).toContain("virement effectué");
  });
});

describe("stripQuotedReply", () => {
  it("cuts at '>' quotes, FR and EN quote headers", () => {
    expect(stripQuotedReply("top\n> quoted payé")).toBe("top");
    expect(stripQuotedReply("top\nLe 12 août 2026, X a écrit :\npayé")).toBe("top");
    expect(stripQuotedReply("top\nOn Aug 12, 2026, X wrote:\npaid")).toBe("top");
  });
});

describe("extractAddress", () => {
  it("parses display-name headers and normalizes case", () => {
    expect(extractAddress("Jean Client <Jean.Client@Example.COM>")).toBe("jean.client@example.com");
    expect(extractAddress("client@example.com")).toBe("client@example.com");
  });
});

describe("extractPlainText", () => {
  it("prefers decoded text/plain parts, falls back to snippet", () => {
    const b64 = Buffer.from("virement effectué", "utf-8").toString("base64url");
    expect(
      extractPlainText({ payload: { parts: [{ mimeType: "text/plain", body: { data: b64 } }] } } as any),
    ).toContain("virement effectué");
    expect(extractPlainText({ snippet: "fallback text" } as any)).toBe("fallback text");
  });
});
