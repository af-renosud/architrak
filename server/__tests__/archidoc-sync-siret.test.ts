import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../archidoc/sync-client", () => ({
  isArchidocConfigured: () => false,
  fetchProjects: vi.fn(),
  fetchContractors: vi.fn(),
  fetchTrades: vi.fn(),
  fetchProposalFees: vi.fn(),
}));

import { normaliseMirrorSiret } from "../archidoc/sync-service";

describe("normaliseMirrorSiret", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnSpy.mockClear();
  });

  it("returns null for null/undefined/empty without logging", () => {
    expect(normaliseMirrorSiret(null, { archidocId: "a" })).toBeNull();
    expect(normaliseMirrorSiret(undefined, { archidocId: "a" })).toBeNull();
    expect(normaliseMirrorSiret("", { archidocId: "a" })).toBeNull();
    expect(normaliseMirrorSiret("   ", { archidocId: "a" })).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("strips formatting and accepts canonical 14-digit values", () => {
    expect(normaliseMirrorSiret("820 466 761 00021", { archidocId: "a" })).toBe(
      "82046676100021",
    );
    expect(normaliseMirrorSiret("82046676100021", { archidocId: "a" })).toBe(
      "82046676100021",
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("coerces malformed values to null and logs a warning", () => {
    expect(
      normaliseMirrorSiret("not-a-siret", { archidocId: "ad-9", name: "ACME" }),
    ).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0][0]);
    expect(message).toContain("ad-9");
    expect(message).toContain("ACME");
    expect(message).toContain("not-a-siret");
  });

  it("coerces too-short digit strings to null and logs", () => {
    expect(normaliseMirrorSiret("123", { archidocId: "ad-1" })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
