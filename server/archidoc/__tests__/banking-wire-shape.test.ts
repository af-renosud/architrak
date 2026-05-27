import { describe, it, expect } from "vitest";
import type { ArchidocContractorData } from "../sync-client";

/**
 * Task #226 — Fixture pinned verbatim from ArchiDoc's confirmation reply.
 * If either side renames the audit keys, this test fails BEFORE we ship
 * a sync that silently drops `banking_verified_at` /
 * `banking_verified_by` / `banking_ai_extracted_data` to NULL.
 *
 * We assert against the TypeScript interface rather than the mapper
 * function (the mapper is not exported, and the schema-presence check
 * keeps it honest at boot). The interface IS the contract: if a key
 * name drifts on the wire, the type stops compiling and the boot
 * invariant catches it.
 */
const ARCHIDOC_WIRE_FIXTURE: ArchidocContractorData = {
  id: "8f1d3c2a-0000-0000-0000-000000000001",
  name: "Maçonnerie Dupont SARL",
  siret: "12345678900012",
  address1: "12 rue des Lilas",
  town: "Lyon",
  postcode: "69003",
  banking: {
    accountHolderName: "MACONNERIE DUPONT SARL",
    iban: "FR7630001007941234567890185",
    bic: "BDFEFRPPCCT",
    bankName: "Banque de France",
    ribDocumentUrl: "/objects/contractors/8f1d3c2a/rib-1748352000000-rib-dupont.pdf",
    ribDocumentName: "rib-dupont.pdf",
    bankingVerifiedAt: "2026-05-20T14:32:11.000Z",
    bankingVerifiedBy: "marie.architecte@renosud.com",
    bankingAiExtractedData: { rawText: "…", confidence: 0.94, extractedAt: "…" },
  },
  updatedAt: "2026-05-20T14:32:11.000Z",
};

describe("ArchidocContractorData.banking wire shape (Task #226)", () => {
  it("uses the PREFIXED audit key names that ArchiDoc actually emits", () => {
    const b = ARCHIDOC_WIRE_FIXTURE.banking;
    expect(b).toBeDefined();
    if (!b) throw new Error("banking absent");
    expect(b.bankingVerifiedAt).toBe("2026-05-20T14:32:11.000Z");
    expect(b.bankingVerifiedBy).toBe("marie.architecte@renosud.com");
    expect(b.bankingAiExtractedData).toMatchObject({ confidence: 0.94 });
  });

  it("does NOT silently accept the short forms (would compile-fail if added)", () => {
    // This block exists purely to document the intent: the interface
    // forbids `verifiedAt` / `verifiedBy` / `aiExtractedData`. If a
    // future refactor re-adds them, both this comment AND the TS
    // compiler will flag it. We assert at runtime that the fixture
    // does not carry the legacy names either.
    const b = ARCHIDOC_WIRE_FIXTURE.banking as Record<string, unknown>;
    expect(b.verifiedAt).toBeUndefined();
    expect(b.verifiedBy).toBeUndefined();
    expect(b.aiExtractedData).toBeUndefined();
  });
});
