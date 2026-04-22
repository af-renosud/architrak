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
    const revoked = await storage.revokeExpiredDevisCheckTokens();
    if (revoked > 0) {
      console.log(`[DevisCheckTokens] Revoked ${revoked} expired token(s)`);
    }
    return revoked;
  } catch (err) {
    console.error("[DevisCheckTokens] Cleanup failed:", err);
    return 0;
  }
}
