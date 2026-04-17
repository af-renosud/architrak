import { describe, it, expect } from "vitest";
import { createHash } from "crypto";

// Mirror of the same logic used in webhook.service.ts so we have a stable
// contract test against the idempotency-key derivation rules.
function computeEventId(payload: { eventId?: string; event: string; timestamp: string; data?: any }) {
  if (payload.eventId) return payload.eventId;
  const hash = createHash("sha256")
    .update(`${payload.event}|${payload.timestamp}|${JSON.stringify(payload.data ?? {})}`)
    .digest("hex");
  return `derived:${hash}`;
}

describe("webhook event id derivation", () => {
  it("uses explicit eventId when provided", () => {
    expect(computeEventId({ eventId: "evt_123", event: "project.updated", timestamp: "t" })).toBe("evt_123");
  });

  it("derives a deterministic id from event+timestamp+data when no eventId given", () => {
    const a = computeEventId({ event: "project.updated", timestamp: "2026-04-17T10:00:00Z", data: { id: "p1" } });
    const b = computeEventId({ event: "project.updated", timestamp: "2026-04-17T10:00:00Z", data: { id: "p1" } });
    expect(a).toBe(b);
    expect(a.startsWith("derived:")).toBe(true);
  });

  it("produces different ids for different payloads", () => {
    const a = computeEventId({ event: "project.updated", timestamp: "t1", data: { id: "p1" } });
    const b = computeEventId({ event: "project.updated", timestamp: "t1", data: { id: "p2" } });
    expect(a).not.toBe(b);
  });

  it("produces different ids for different events with same data", () => {
    const a = computeEventId({ event: "project.updated", timestamp: "t1", data: {} });
    const b = computeEventId({ event: "project.deleted", timestamp: "t1", data: {} });
    expect(a).not.toBe(b);
  });
});
