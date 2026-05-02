/**
 * §5.3.2.1 canonical ISO-8601 timestamp normalizer (sender-side, v1.1).
 *
 * Mirrors the contract's reference normalizer at
 * docs/INTER_APP_CONTRACT_v1.0.md §5.3.2.1 (line ~744). Applied at every
 * Architrak → Archidoc wire boundary that emits one of the three
 * timestamp fields participating in the §5.3.2 byte-equality correlation
 * rule:
 *
 *   - §5.3.1 work_authorised: top-level `signedAt`
 *   - §5.3.1 work_authorised: `identityVerification.signedAt`
 *   - §5.3.2 signed_pdf_retention_breach: `originalSignedAt`
 *
 * Why this exists. Receiver storage layers (notably Postgres `timestamptz`)
 * normalize a seconds-only wire value `...:00Z` to `...:00.000Z` on
 * insert. If Architrak emits the seconds-only form on §5.3.1 and the
 * seconds-only form again on §5.3.2, the receiver's byte-equality check
 * (`work_authorisations.signed_at == signed_pdf_retention_breaches.original_signed_at`)
 * fails despite logical equality. Mandating the `.SSSZ` form at the wire
 * boundary keeps the equality rule a simple byte-comparison. See the
 * 2026-05-02 joint live E2E test postmortem in §5.3.2.1's "Motivating
 * incident summary" for the incident that prompted the v1.1 amendment.
 *
 * Behaviour:
 *   - Idempotent on canonical input (`...000Z` → `...000Z`).
 *   - Seconds-only `...Z` → `...000Z`.
 *   - Offset `...+00:00` → `...Z`.
 *   - Sub-millisecond precision `...123456Z` → truncated to ms.
 *   - Accepts `Date` objects (returned as their ISO form).
 *   - Throws on invalid input — non-conformant senders fail fast at
 *     emission rather than silently relaying garbage downstream.
 */
export function canonicalizeTimestamp(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) {
    throw new Error(`canonicalizeTimestamp: invalid input ${JSON.stringify(input)}`);
  }
  return d.toISOString();
}
