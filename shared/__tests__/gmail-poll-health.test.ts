import { describe, it, expect } from "vitest";
import {
  classifyGmailPollHealth,
  formatPollAge,
  GMAIL_POLL_STALE_THRESHOLD_MS,
} from "@shared/gmail-poll-health";

const NOW = new Date("2026-08-06T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("classifyGmailPollHealth", () => {
  it("is ok when linked and scanned recently with success", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(12),
      lastPollStatus: "completed",
      now: NOW,
    });
    expect(h.level).toBe("ok");
    expect(h.message).toBeNull();
    expect(h.ageMs).toBe(12 * 60_000);
  });

  it("accepts ISO-string timestamps", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(30).toISOString(),
      lastPollStatus: "completed",
      now: NOW,
    });
    expect(h.level).toBe("ok");
  });

  it("flags stale when the last scan is older than the threshold", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(121),
      lastPollStatus: "completed",
      now: NOW,
    });
    expect(h.level).toBe("stale");
    expect(h.message).toMatch(/last scanned 2 hours ago/i);
    expect(h.message).toMatch(/capture may be down/i);
  });

  it("flags the real production incident shape: completed status but 69 days old", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: new Date("2026-05-29T06:00:00Z"),
      lastPollStatus: "completed",
      now: NOW,
    });
    expect(h.level).toBe("stale");
    expect(h.message).toMatch(/69 days ago/);
  });

  it("is exactly at the threshold boundary — not yet stale", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: new Date(NOW.getTime() - GMAIL_POLL_STALE_THRESHOLD_MS),
      lastPollStatus: "completed",
      now: NOW,
    });
    expect(h.level).toBe("ok");
  });

  it("auth_revoked wins over staleness and carries the reconnect message", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(60 * 24 * 10),
      lastPollStatus: "auth_revoked",
      now: NOW,
    });
    expect(h.level).toBe("auth_revoked");
    expect(h.message).toMatch(/reconnect Gmail/i);
  });

  it("reports never-scanned when linked but no poll has run", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: null,
      lastPollStatus: null,
      now: NOW,
    });
    expect(h.level).toBe("never");
    expect(h.ageMs).toBeNull();
    expect(h.message).toMatch(/never been scanned/i);
  });

  it("reports not_linked regardless of poll columns", () => {
    const h = classifyGmailPollHealth({
      linked: false,
      lastPollAt: null,
      lastPollStatus: null,
      now: NOW,
    });
    expect(h.level).toBe("not_linked");
    expect(h.message).toMatch(/no gmail inbox is linked/i);
  });

  it("recent errored scan is 'error' (will retry), not stale", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(20),
      lastPollStatus: "error",
      now: NOW,
    });
    expect(h.level).toBe("error");
    expect(h.message).toMatch(/retry automatically/i);
  });

  it("errored AND stale classifies as stale (the louder problem)", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(300),
      lastPollStatus: "error",
      now: NOW,
    });
    expect(h.level).toBe("stale");
  });

  it("treats an invalid date string like never-scanned", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: "not-a-date",
      lastPollStatus: "completed",
      now: NOW,
    });
    expect(h.level).toBe("never");
  });

  it("honours a custom threshold", () => {
    const h = classifyGmailPollHealth({
      linked: true,
      lastPollAt: minutesAgo(10),
      lastPollStatus: "completed",
      now: NOW,
      staleThresholdMs: 5 * 60_000,
    });
    expect(h.level).toBe("stale");
  });
});

describe("formatPollAge", () => {
  it("formats minutes, hours, and days with pluralisation", () => {
    expect(formatPollAge(60_000)).toBe("1 minute");
    expect(formatPollAge(45 * 60_000)).toBe("45 minutes");
    expect(formatPollAge(3 * 3_600_000)).toBe("3 hours");
    expect(formatPollAge(47 * 3_600_000)).toBe("47 hours");
    expect(formatPollAge(69 * 24 * 3_600_000)).toBe("69 days");
  });
});
