import { describe, it, expect } from "vitest";
import { deriveDevisReadiness, type DeriveReadinessInput } from "../devis-readiness";

function base(overrides?: {
  devis?: Partial<DeriveReadinessInput["devis"]>;
  input?: Partial<Omit<DeriveReadinessInput, "devis">>;
}): DeriveReadinessInput {
  return {
    devis: {
      id: 1,
      status: "pending",
      signOffStage: "approved_for_signing",
      invoicingMode: "mode_b",
      lotId: 5,
      lotRefText: "01.02",
      descriptionUk: "Demolition works",
      archisignEnvelopeId: null,
      archisignEnvelopeStatus: null,
      ...(overrides?.devis ?? {}),
    } as DeriveReadinessInput["devis"],
    translationStatus: "finalised",
    openContractorChecks: 0,
    openClientChecks: 0,
    clientContactPresent: true,
    insurance: { ok: true, reason: "Mirror local : assurance valide." },
    insuranceOverridden: false,
    ...(overrides?.input ?? {}),
  };
}

describe("deriveDevisReadiness", () => {
  it("is ready when every predicate holds (mode B, finalised translation)", () => {
    const r = deriveDevisReadiness(base());
    expect(r.readyToSend).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.signature).toBe("not_sent");
    expect(r.sent).toBe(false);
  });

  it("blocks on wrong stage", () => {
    const r = deriveDevisReadiness(base({ devis: { signOffStage: "received" } }));
    expect(r.readyToSend).toBe(false);
    expect(r.blockers.some((b) => b.includes("Approved for signing"))).toBe(true);
  });

  it("blocks on open contractor checks with count-aware wording", () => {
    const one = deriveDevisReadiness(base({ input: { openContractorChecks: 1 } }));
    expect(one.blockers).toContain("1 contractor check is still open");
    const three = deriveDevisReadiness(base({ input: { openContractorChecks: 3 } }));
    expect(three.blockers).toContain("3 contractor checks are still open");
    expect(three.readyToSend).toBe(false);
  });

  it("mode B requires a FINALISED translation — draft/edited are not enough", () => {
    for (const status of ["draft", "edited"]) {
      const r = deriveDevisReadiness(base({ input: { translationStatus: status } }));
      expect(r.readyToSend).toBe(false);
      expect(r.blockers.some((b) => b.startsWith("Translation not finalised"))).toBe(true);
    }
  });

  it("both modes require a translated PDF (send route sends the translation)", () => {
    for (const mode of ["mode_a", "mode_b"]) {
      for (const status of ["pending", "processing", "failed", null]) {
        const r = deriveDevisReadiness(
          base({ devis: { invoicingMode: mode }, input: { translationStatus: status } }),
        );
        expect(r.readyToSend).toBe(false);
        expect(r.blockers.some((b) => b.startsWith("Translated PDF not generated"))).toBe(true);
      }
    }
  });

  it("missing translation reports status 'missing'", () => {
    const r = deriveDevisReadiness(base({ input: { translationStatus: null } }));
    expect(r.translationStatus).toBe("missing");
  });

  it("mode A is ready with a draft translation (finalisation not required)", () => {
    const r = deriveDevisReadiness(
      base({ devis: { invoicingMode: "mode_a" }, input: { translationStatus: "draft" } }),
    );
    expect(r.translationStatus).toBe("draft");
    expect(r.readyToSend).toBe(true);
  });

  it("blocks on missing lot / english description / client contact", () => {
    const r = deriveDevisReadiness(
      base({
        devis: { lotId: null, lotRefText: "  ", descriptionUk: "" },
        input: { clientContactPresent: false },
      }),
    );
    expect(r.blockers).toContain("Lot reference missing");
    expect(r.blockers).toContain("English description missing");
    expect(r.blockers).toContain("Client contact name/email missing on the project");
  });

  it("free-text lot ref counts as a lot", () => {
    const r = deriveDevisReadiness(base({ devis: { lotId: null, lotRefText: "GO-01" } }));
    expect(r.blockers).not.toContain("Lot reference missing");
  });

  it("insurance blocks unless overridden", () => {
    const blocked = deriveDevisReadiness(
      base({ input: { insurance: { ok: false, reason: "statut « expired »" } } }),
    );
    expect(blocked.readyToSend).toBe(false);
    expect(blocked.insuranceOk).toBe(false);
    expect(blocked.blockers).toContain("Insurance: statut « expired »");

    const overridden = deriveDevisReadiness(
      base({
        input: {
          insurance: { ok: false, reason: "statut « expired »" },
          insuranceOverridden: true,
        },
      }),
    );
    expect(overridden.readyToSend).toBe(true);
    expect(overridden.insuranceOk).toBe(true);
    expect(overridden.insuranceOverridden).toBe(true);
  });

  it("derives signature from the envelope status when present", () => {
    for (const env of ["sent", "viewed", "queried", "signed", "declined", "expired"] as const) {
      const r = deriveDevisReadiness(
        base({
          devis: {
            signOffStage: "sent_to_client",
            archisignEnvelopeId: "env_1",
            archisignEnvelopeStatus: env,
          },
        }),
      );
      expect(r.signature).toBe(env);
      expect(r.sent).toBe(true);
      expect(r.readyToSend).toBe(false);
    }
  });

  it("derives signature from the stage when no envelope status exists", () => {
    expect(
      deriveDevisReadiness(base({ devis: { signOffStage: "sent_to_client" } })).signature,
    ).toBe("sent");
    expect(
      deriveDevisReadiness(base({ devis: { signOffStage: "client_signed_off" } })).signature,
    ).toBe("signed");
    expect(
      deriveDevisReadiness(base({ devis: { signOffStage: "client_rejected" } })).signature,
    ).toBe("declined");
  });

  it("void devis always shows Void, even with an envelope status", () => {
    const r = deriveDevisReadiness(
      base({ devis: { status: "void", archisignEnvelopeStatus: "sent" } }),
    );
    expect(r.signature).toBe("void");
    const stageVoid = deriveDevisReadiness(base({ devis: { signOffStage: "void" } }));
    expect(stageVoid.signature).toBe("void");
  });

  it("ignores unknown envelope statuses and falls back to the stage", () => {
    const r = deriveDevisReadiness(
      base({ devis: { signOffStage: "sent_to_client", archisignEnvelopeStatus: "banana" } }),
    );
    expect(r.signature).toBe("sent");
  });
});
