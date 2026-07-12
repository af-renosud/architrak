import { describe, it, expect, vi } from "vitest";

// Task #267 — regression guard for the English client-facing copy that
// Task #266 introduced. The client portal shell, the certificat client
// email, and the Pennylane fee invoice email are all read by Renosud's
// clients (not contractors), so they must stay in English. This test
// renders each surface and asserts:
//
//   1) key English strings are present ("Approval recorded",
//      "Rejection recorded", the expired-link message, "Dear Client,").
//   2) no French markers ("enregistré", "Veuillez", …) sneak back in.
//
// The contractor portal (server/routes/public-checks.ts) is explicitly
// NOT covered — it stays French by design (see replit.md user prefs).

vi.mock("../storage", () => ({ storage: {} }));
vi.mock("../services/client-checks", () => ({
  hashToken: (s: string) => s,
  resolveClientCheckToken: vi.fn(),
  computeTokenExpiry: () => new Date(),
}));
vi.mock("../storage/object-storage", () => ({
  getDocumentStream: vi.fn(),
  getDocumentBuffer: vi.fn(),
  uploadDocument: vi.fn(),
  uploadDocumentAtKey: vi.fn(),
  buildPennylaneInvoiceObjectName: vi.fn(),
}));
vi.mock("../services/docraptor", () => ({ convertHtmlToPdf: vi.fn() }));
vi.mock("../services/drive/upload-queue.service", () => ({ enqueueDriveUpload: vi.fn() }));
vi.mock("../services/pennylane/client", () => ({
  isPennylaneConfigured: () => false,
  isPennylaneDryRun: () => false,
  isPennylanePushEnabled: () => false,
  isProjectWhitelisted: () => false,
  iteratePages: vi.fn(),
  PennylaneApiError: class extends Error {},
  pennylaneRequest: vi.fn(),
}));
vi.mock("../gmail/client", () => ({
  getUncachableGmailClient: vi.fn(),
  isGmailConfigured: () => false,
}));

import type { Certificat, Project, Contractor, FeeEntry } from "@shared/schema";

/**
 * French words/fragments that appeared in the pre-Task-#266 copy, plus
 * common French connective words that are very unlikely to appear in
 * intentional English copy. French *domain* terms (Devis, Certificat,
 * Honoraires, TTC, …) are allowed per the user preferences, so they are
 * deliberately NOT in this list.
 */
const FRENCH_MARKERS = [
  "enregistré",
  "enregistrée",
  "Veuillez",
  "veuillez",
  "Merci de",
  "Cordialement",
  "Bonjour",
  "Cher client",
  "Chère cliente",
  "ci-joint",
  "expiré",
  "n'hésitez pas",
  // Task #269 — the Archisign signing-invitation subject used to be
  // "Signature électronique — …"; "électronique" never appears in
  // intentional English copy.
  "électronique",
  "Nous avons",
  "concernant votre",
] as const;

function expectNoFrenchMarkers(text: string, surface: string) {
  for (const marker of FRENCH_MARKERS) {
    expect(text, `${surface} must not contain French marker "${marker}"`).not.toContain(marker);
  }
}

describe("client portal shell (public-client-checks) stays English", () => {
  it("live shell carries the English verdict + expired-link copy and no French markers", async () => {
    const { renderClientPortalShell } = await import("../routes/public-client-checks");
    const html = renderClientPortalShell({ mode: "live", token: "tok-english-check" });

    // Key verdict confirmations shown after the client acts.
    expect(html).toContain("Approval recorded");
    expect(html).toContain("Rejection recorded");
    // Expired-link message rendered when the token has lapsed.
    expect(html).toContain("This link has expired. Please contact your Renosud representative.");
    // The shell declares itself as English.
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Client portal — Renosud");

    expectNoFrenchMarkers(html, "client portal shell (live)");
  });

  it("architect preview shell uses the same English copy", async () => {
    const { renderClientPortalShell } = await import("../routes/public-client-checks");
    const html = renderClientPortalShell({ mode: "preview", devisId: 42 });

    expect(html).toContain("Approval recorded");
    expect(html).toContain("Rejection recorded");
    expect(html).toContain("Architect preview — actions will not be sent.");

    expectNoFrenchMarkers(html, "client portal shell (preview)");
  });
});

describe("certificat client email body stays English", () => {
  it("addresses the client in English with no French markers", async () => {
    const { buildCertificatEmailBody } = await import("../communications/certificat-generator");
    const body = buildCertificatEmailBody({
      certificat: {
        certificateRef: "CERT-2026-001",
        netToPayTtc: "12345.67",
      } as unknown as Certificat,
      project: { name: "Villa Test", code: "VT-01" } as unknown as Project,
      contractor: { name: "Test Contractor SARL" } as unknown as Contractor,
    });

    expect(body).toContain("Dear Client,");
    expect(body).toContain("Please find attached Certificat de Paiement no. CERT-2026-001");
    expect(body).toContain('project "Villa Test" (VT-01)');
    expect(body).toContain("Test Contractor SARL");
    expect(body).toContain("Kind regards,");

    expectNoFrenchMarkers(body, "certificat client email body");
  });
});

describe("Pennylane fee invoice email body stays English", () => {
  it("greets a named contact in English with no French markers", async () => {
    const { buildClientEmailBody } = await import("../services/pennylane/push-queue.service");
    const body = buildClientEmailBody(
      { name: "Villa Test", code: "VT-01", clientContactName: "Jane Doe" } as unknown as Project,
      { feeAmount: "1500.5" } as unknown as FeeEntry,
    );

    expect(body).toContain("Dear Jane Doe,");
    expect(body).toContain("architect's fee invoice (Honoraires)");
    expect(body).toContain('project "Villa Test" (VT-01)');
    expect(body).toContain("Amount: 1500.50 € HT");
    expect(body).toContain("Kind regards,");

    expectNoFrenchMarkers(body, "Pennylane fee invoice email (named contact)");
  });

  it("falls back to the English generic greeting when no contact name exists", async () => {
    const { buildClientEmailBody } = await import("../services/pennylane/push-queue.service");
    const body = buildClientEmailBody(
      { name: "Villa Test", code: "VT-01", clientContactName: null } as unknown as Project,
      { feeAmount: "200" } as unknown as FeeEntry,
    );

    expect(body).toContain("Dear Client,");
    expectNoFrenchMarkers(body, "Pennylane fee invoice email (generic greeting)");
  });

  it("subject is English (Honoraires is an allowed domain term)", async () => {
    const { buildClientEmailSubject } = await import("../services/pennylane/push-queue.service");
    const subject = buildClientEmailSubject(
      { name: "Villa Test", code: "VT-01" } as unknown as Project,
    );

    expect(subject).toBe("Architect fee invoice (Honoraires) — Villa Test (VT-01)");
    expectNoFrenchMarkers(subject, "Pennylane fee invoice email subject");
  });
});

// Task #269 — remaining client-facing outbound email surfaces.

describe("Archisign signing-invitation subject stays English", () => {
  it("renders the English subject with no French markers", async () => {
    const { buildArchisignEnvelopeSubject } = await import("../services/archisign");
    const subject = buildArchisignEnvelopeSubject("DVT0000941");

    expect(subject).toBe("Electronic signature request — devis DVT0000941");
    expectNoFrenchMarkers(subject, "Archisign signing-invitation subject");
  });
});

describe("devis signature-context client email stays English", () => {
  it("subject is English with the devis ref and project name", async () => {
    const { buildDevisContextEmailSubject } = await import("../communications/email-sender");
    const subject = buildDevisContextEmailSubject({
      refLabel: "DVT0000941",
      projectName: "Villa Test",
    });

    expect(subject).toBe("Devis DVT0000941 — Villa Test: electronic signature to follow");
    expectNoFrenchMarkers(subject, "devis signature-context email subject");
  });

  it("fixed footer announcing the Archisign email is English", async () => {
    const { buildDevisContextEmailBody } = await import("../communications/email-sender");
    const body = buildDevisContextEmailBody({
      architectMessage: "Here is the devis for your approval.",
      refLabel: "DVT0000941",
      projectName: "Villa Test",
    });

    expect(body).toContain("You will shortly receive a separate email from Archisign");
    expect(body).toContain('devis DVT0000941 (project "Villa Test")');
    expectNoFrenchMarkers(body, "devis signature-context email body (fixed footer)");
  });
});

describe("certificat client email subject stays English", () => {
  it("keeps only the allowed domain term Certificat de Paiement", async () => {
    const { buildCertificatEmailSubject } = await import("../communications/email-sender");
    const subject = buildCertificatEmailSubject({
      certificateRef: "CERT-2026-001",
      projectName: "Villa Test",
    });

    expect(subject).toBe("Certificat de Paiement CERT-2026-001 - Villa Test");
    expectNoFrenchMarkers(subject, "certificat client email subject");
  });
});

describe("payment chase reminder emails stay English", () => {
  const reminderTypes = ["first", "second", "final", "overdue"] as const;

  it.each(reminderTypes)("%s reminder subject + body are English", async (reminderType) => {
    const { buildPaymentChaseTemplate } = await import("../communications/email-sender");
    const { subject, body } = buildPaymentChaseTemplate(reminderType, "Villa Test");

    expect(body).toContain("Dear Client,");
    expect(body).toContain('project "Villa Test"');
    expect(body).toContain("Kind regards,");
    expectNoFrenchMarkers(subject, `payment chase subject (${reminderType})`);
    expectNoFrenchMarkers(body, `payment chase body (${reminderType})`);
  });

  it("unknown reminder types fall back to the English first-reminder template", async () => {
    const { buildPaymentChaseTemplate } = await import("../communications/email-sender");
    const { subject, body } = buildPaymentChaseTemplate("mystery", "Villa Test");

    expect(subject).toBe("Payment Reminder - Villa Test");
    expectNoFrenchMarkers(body, "payment chase body (fallback)");
  });
});

// Task #280 — the pre-filled client message the architect sees in the
// SigningPanel "send for signature" dialog. It is sent verbatim to the
// client inside the devis context email, so it must stay English. The
// builder lives in shared/ precisely so this server-side test can guard it.
describe("SigningPanel pre-filled client message template stays English", () => {
  it("greets a named contact and describes the devis in English", async () => {
    const { buildClientSignatureMessageTemplate } = await import(
      "@shared/signature-message-template"
    );
    const template = buildClientSignatureMessageTemplate({
      refLabel: "DVT0000941",
      descriptionFr: "Encastrer un sarco béton s22",
      amountTtcLabel: "9 435,84",
      projectName: "SMITH (SAINT PONS DE MAUCHIENS) 1304",
      clientContactName: "Jane Smith",
    });

    expect(template).toContain("Dear Jane Smith,");
    expect(template).toContain(
      'Devis DVT0000941 (Encastrer un sarco béton s22) for 9 435,84 € TTC on project "SMITH (SAINT PONS DE MAUCHIENS) 1304" is ready for electronic signature.',
    );
    expect(template).toContain("You will shortly receive a separate email from Archisign");
    expect(template).toContain("Kind regards,");

    // descriptionFr is a French *domain value* (the devis' lot description)
    // interpolated as-is — strip it before running the marker check so we
    // only guard the template's own copy.
    expectNoFrenchMarkers(
      template.replace("Encastrer un sarco béton s22", ""),
      "SigningPanel client message template (named contact)",
    );
  });

  it("falls back to an English generic greeting and omits empty parts", async () => {
    const { buildClientSignatureMessageTemplate } = await import(
      "@shared/signature-message-template"
    );
    const template = buildClientSignatureMessageTemplate({
      refLabel: "DVT0000941",
      descriptionFr: null,
      amountTtcLabel: null,
      projectName: null,
      clientContactName: "   ",
    });

    expect(template).toContain("Dear Sir or Madam,");
    expect(template).toContain("Devis DVT0000941 is ready for electronic signature.");
    expectNoFrenchMarkers(template, "SigningPanel client message template (generic)");
  });
});

// Contractor-facing emails are explicitly EXCLUDED from the English guard —
// they stay French by design (replit.md user prefs):
//   - queueDevisCheckBundle / formatCheckHead ("Questions sur le devis …",
//     "Bonjour …", "Cordialement") in server/communications/email-sender.ts
//   - the contractor portal (server/routes/public-checks.ts)
// Internal/operator digests (outstanding-fees digest, design-contract
// milestone digest, ops alerts) are architect-facing, not client-facing,
// so they are also out of scope here.
describe("contractor-facing bundle email is intentionally French (sanity anchor)", () => {
  it("formatCheckHead keeps its French copy", async () => {
    const { formatCheckHead } = await import("../communications/email-sender");
    expect(
      formatCheckHead({ lineDescription: null, lineNumber: null, totalHt: null }),
    ).toBe("Question générale");
  });
});
