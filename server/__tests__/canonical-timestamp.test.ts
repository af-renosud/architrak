import { describe, it, expect } from "vitest";
import { canonicalizeTimestamp } from "../lib/canonical-timestamp";

describe("canonicalizeTimestamp — §5.3.2.1 sender-side ISO-8601 normalizer (v1.1)", () => {
  it("is idempotent on the canonical .SSSZ form", () => {
    const canonical = "2026-04-25T10:30:00.000Z";
    expect(canonicalizeTimestamp(canonical)).toBe(canonical);
  });

  it("normalises the seconds-only Z form to .000Z (the motivating-incident shape)", () => {
    expect(canonicalizeTimestamp("2026-04-25T10:30:00Z")).toBe("2026-04-25T10:30:00.000Z");
  });

  it("normalises the +00:00 offset form to literal Z", () => {
    expect(canonicalizeTimestamp("2026-04-25T10:30:00.000+00:00"))
      .toBe("2026-04-25T10:30:00.000Z");
    expect(canonicalizeTimestamp("2026-04-25T10:30:00+00:00"))
      .toBe("2026-04-25T10:30:00.000Z");
  });

  it("truncates sub-millisecond precision to 3 digits", () => {
    // Per the §5.3.2.1 conformance table row "Sub-millisecond precision".
    // Node's Date parser keeps the first 3 fractional digits.
    expect(canonicalizeTimestamp("2026-04-25T10:30:00.123456Z"))
      .toBe("2026-04-25T10:30:00.123Z");
  });

  it("accepts a Date object and returns its canonical ISO form", () => {
    const d = new Date(Date.UTC(2026, 3, 25, 10, 30, 0, 0));
    expect(canonicalizeTimestamp(d)).toBe("2026-04-25T10:30:00.000Z");
  });

  it("preserves a non-zero millisecond component", () => {
    expect(canonicalizeTimestamp("2026-04-25T10:30:00.123Z"))
      .toBe("2026-04-25T10:30:00.123Z");
  });

  it("normalises a non-UTC offset to its Z equivalent (instant-preserving)", () => {
    // 12:30 +02:00 is the same instant as 10:30 Z. Sender canonicalization
    // collapses offset notation to literal Z so the wire form is uniform
    // regardless of the upstream's chosen representation.
    expect(canonicalizeTimestamp("2026-04-25T12:30:00+02:00"))
      .toBe("2026-04-25T10:30:00.000Z");
  });

  it("throws on an unparseable string (fail-fast, no silent garbage relay)", () => {
    expect(() => canonicalizeTimestamp("not-a-date")).toThrow(/invalid input/);
    expect(() => canonicalizeTimestamp("")).toThrow(/invalid input/);
  });

  it("throws on an Invalid Date object", () => {
    expect(() => canonicalizeTimestamp(new Date("not-a-date"))).toThrow(/invalid input/);
  });
});
