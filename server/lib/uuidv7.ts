import { randomBytes } from "crypto";

/**
 * UUIDv7 — RFC 9562 §5.7. Time-ordered, 48-bit unix-millisecond
 * prefix + 4-bit version + 12-bit random + 2-bit variant + 62-bit random.
 *
 * Used by AT5 outbound webhook deliveries (G6 in
 * docs/STEP4_IMPLEMENTATION_BREAKDOWN.md): receivers (Archidoc) dedup on
 * the eventId via UNIQUE-violation, and the time prefix means duplicate
 * deliveries from a retry burst land in the same row chronologically and
 * make incident timelines easy to read.
 *
 * Reproducible from `(Date.now(), randomBytes)` only — no global state,
 * safe to call concurrently. Strict 36-character canonical hyphenated
 * lowercase form: `xxxxxxxx-xxxx-7xxx-Vxxx-xxxxxxxxxxxx` where the first
 * digit of the third group is `7` (version) and the first digit of the
 * fourth group is `8`/`9`/`a`/`b` (RFC 4122 variant).
 */
export function uuidv7(now: number = Date.now()): string {
  // Use Math floor/division on Number for the 48-bit timestamp split:
  // a JS Number can hold integers up to 2^53 - 1 exactly, and a 48-bit
  // Unix-millis value (max 2^48 ≈ year 10889) fits comfortably. This
  // avoids the BigInt literal syntax (which the local TS target
  // rejects) without needing to widen the project's compilerOptions.
  const ms = Math.max(0, Math.floor(now));
  const rand = randomBytes(10);

  // Layout: 6 bytes time + 2 bytes (version + rand_a) + 8 bytes (variant + rand_b)
  const buf = Buffer.alloc(16);
  // Big-endian 48-bit timestamp. We split into a high 16-bit half and
  // a low 32-bit half so the latter can be done with bitwise ops; the
  // high half stays in floating point (Math.floor of a divide).
  const high16 = Math.floor(ms / 0x100000000);  // upper 16 bits (ms >> 32)
  const low32 = ms - high16 * 0x100000000;       // lower 32 bits (ms & 0xffffffff)
  buf[0] = (high16 >>> 8) & 0xff;
  buf[1] = high16 & 0xff;
  buf[2] = (low32 >>> 24) & 0xff;
  buf[3] = (low32 >>> 16) & 0xff;
  buf[4] = (low32 >>> 8) & 0xff;
  buf[5] = low32 & 0xff;
  // 4-bit version (7) in the high nibble of byte 6, rest random.
  buf[6] = 0x70 | (rand[0] & 0x0f);
  buf[7] = rand[1];
  // 2-bit variant (10) in the top of byte 8, rest random.
  buf[8] = 0x80 | (rand[2] & 0x3f);
  buf[9] = rand[3];
  buf[10] = rand[4];
  buf[11] = rand[5];
  buf[12] = rand[6];
  buf[13] = rand[7];
  buf[14] = rand[8];
  buf[15] = rand[9];

  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
