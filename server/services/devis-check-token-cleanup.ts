import { storage } from "../storage";

let cleanupInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Periodically revoke devis-check portal tokens whose expiry is in the past.
 * Modeled on the payment scheduler: a single interval timer per process,
 * with an early kick-off so freshly booted instances do the first sweep
 * within a minute instead of waiting a full interval.
 */
export function startDevisCheckTokenCleanup(intervalMs: number = 6 * 60 * 60 * 1000): void {
  if (cleanupInterval) return;
  console.log(`[DevisCheckTokens] Starting cleanup, every ${intervalMs / 1000}s`);
  cleanupInterval = setInterval(() => runCleanup().catch(console.error), intervalMs);
  setTimeout(() => runCleanup().catch(console.error), 30_000);
}

export function stopDevisCheckTokenCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

export async function runCleanup(): Promise<number> {
  try {
    // Two passes: (1) the idle-ceiling sweep retires tokens past their
    // sliding-window expiry; (2) the lifecycle sweep retires tokens whose
    // devis is now fully invoiced. Both are single-statement UPDATEs.
    // The lifecycle pass is a safety net — every invoice/devis mutation
    // path also calls revokeDevisCheckTokenIfFullyInvoiced inline, so this
    // bulk pass should normally find nothing.
    const revokedExpired = await storage.revokeExpiredDevisCheckTokens();
    const revokedFullyInvoiced = await storage.revokeDevisCheckTokensForFullyInvoicedDevis();
    const total = revokedExpired + revokedFullyInvoiced;
    if (total > 0) {
      console.log(
        `[DevisCheckTokens] Revoked ${revokedExpired} expired + ${revokedFullyInvoiced} fully-invoiced token(s)`,
      );
    }
    return total;
  } catch (err) {
    console.error("[DevisCheckTokens] Cleanup failed:", err);
    return 0;
  }
}
