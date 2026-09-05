import { describe, expect, it, vi } from "vitest";

vi.mock("../../env", () => ({
  env: { DEVIS_CHECK_TOKEN_TTL_DAYS: 90 },
}));
vi.mock("../../storage", () => ({ storage: {} }));
vi.mock("../../db", () => ({ db: {} }));

import {
  buildClientLinkEmail,
  canReuseClientLinkDelivery,
  clientLinkDeliveryDedupeKey,
} from "../client-checks";

describe("client link email helpers", () => {
  it("does not reuse an expired or revoked token delivery", () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    expect(canReuseClientLinkDelivery({
      revokedAt: null,
      expiresAt: new Date("2026-09-05T09:59:59.000Z"),
    }, now)).toBe(false);
    expect(canReuseClientLinkDelivery({
      revokedAt: new Date("2026-09-05T09:00:00.000Z"),
      expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    }, now)).toBe(false);
    expect(canReuseClientLinkDelivery({
      revokedAt: null,
      expiresAt: new Date("2026-09-05T10:00:01.000Z"),
    }, now)).toBe(true);
  });

  it("builds a stable association and keeps untrusted line breaks out of headers", () => {
    expect(clientLinkDeliveryDedupeKey(71)).toBe("devis-client-link:71");
    const email = buildClientLinkEmail({
      projectName: "Maison\r\nBcc: attacker@example.test",
      devisRef: "D-1\r\nX-Bad: yes",
      clientName: "Marie",
      message: "  Please review this quotation.  ",
      portalUrl: "https://architrak.test/p/client/secret",
    });
    expect(email.subject).toBe("Quotation D-1 X-Bad: yes — Maison Bcc: attacker@example.test");
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.body).toContain("Hello Marie,");
    expect(email.body).toContain("Please review this quotation.");
    expect(email.body).toContain("You can review the quotation and send us your comments using this secure link:");
    expect(email.body).toContain("Kind regards,\nThe Renosud team");
    expect(email.body).toContain("https://architrak.test/p/client/secret");
    expect(email.body).not.toMatch(/\b(Bonjour|Vous pouvez|Cordialement|Devis)\b/);
  });
});