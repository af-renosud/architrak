import { describe, it, expect } from "vitest";
import {
  detectPaidConfirmation,
  detectReceivedConfirmation,
  stripQuotedReply,
  extractAddress,
  extractPlainText,
} from "../certificat-payment-suggestions.service";
import {
  buildContractorNoticeEmailSubject,
  buildContractorNoticeEmailBody,
  isValidRecipientEmail,
} from "../../communications/email-sender";

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

/**
 * Task #519 — contractor receipt detection pins. Same closed-set philosophy:
 * "waiting for the transfer" must not match, and the outbound notice's own
 * example phrase ("Paiement bien reçu le JJ/MM/AAAA") must never trigger
 * from the quoted history.
 */
describe("detectReceivedConfirmation", () => {
  it.each([
    "Paiement bien reçu le 14/08/2026, merci.",
    "Bonjour, virement reçu ce matin.",
    "Nous confirmons que le règlement a été bien reçu.",
    "Somme bien reçue sur notre compte.",
    "Fonds reçus, merci.",
    "Bien reçu le virement, cordialement.",
    "Le chèque a été encaissé hier.",
    "Payment received this morning, thank you.",
    "We have received the payment.",
    "Funds received on our account.",
  ])("matches receipt: %s", (text) => {
    const r = detectReceivedConfirmation(text);
    expect(r.matched).toBe(true);
    expect(r.excerpt).toBeTruthy();
  });

  it.each([
    "Nous attendons toujours le virement.",
    "Merci de nous confirmer la date de paiement.",
    "Le client doit-il régler sous 30 jours ?",
    "We are still waiting for the payment.",
    "Will the transfer arrive this week?",
    // Client-style "we paid" phrasing is NOT a contractor receipt.
    "Virement effectué ce jour.",
  ])("does NOT match non-receipt: %s", (text) => {
    expect(detectReceivedConfirmation(text).matched).toBe(false);
  });

  it("never matches the outbound notice's example phrase inside the quoted history", () => {
    const reply = [
      "Merci pour l'information.",
      "",
      "Le 14 août 2026 à 10:00, SAS Architects-France a écrit :",
      "> nous vous remercions de répondre simplement à cet e-mail dès réception",
      "> du paiement (par exemple : « Paiement bien reçu le JJ/MM/AAAA »).",
    ].join("\n");
    expect(detectReceivedConfirmation(reply).matched).toBe(false);
  });
});

describe("contractor notice email template (Task #519)", () => {
  it("subject carries the ref, project and framing", () => {
    expect(
      buildContractorNoticeEmailSubject({ certificateRef: "C3", projectName: "VERFEUIL" }),
    ).toBe("Certificat de Paiement C3 – VERFEUIL – Paiement demandé au client");
  });

  it("body states the TTC amount (fr-FR formatted) and asks for a reply on receipt", () => {
    const body = buildContractorNoticeEmailBody({
      contractorName: "SARL Dupont",
      certificateRef: "C3",
      projectName: "VERFEUIL",
      netToPayTtc: "12345.60",
    });
    expect(body).toContain("Bonjour SARL Dupont");
    expect(body).toContain("certificat de paiement C3");
    expect(body).toContain("« VERFEUIL »");
    expect(body).toContain("€ TTC");
    expect(body).toContain("12\u202f345,60");
    expect(body).toContain("répondre simplement à cet e-mail dès réception du paiement");
    expect(body).toContain("SAS Architects-France");
  });
});

describe("isValidRecipientEmail (Task #519)", () => {
  it.each(["a@b.fr", "jean.dupont@renosud.com", "x_y-z@sub.domain.co"])("accepts %s", (a) => {
    expect(isValidRecipientEmail(a)).toBe(true);
  });
  it.each([
    "",
    "no-at-sign",
    "two@@b.fr",
    "a@b",
    "a b@c.fr",
    "a@b.fr\r\nBcc: evil@x.com", // header injection
    "a@b.fr,second@c.fr",
    "Jean <a@b.fr>",
  ])("rejects %j", (a) => {
    expect(isValidRecipientEmail(a)).toBe(false);
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
