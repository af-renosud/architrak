/**
 * Re-export of the shared signed/pending devis counters so existing client
 * imports keep working. Canonical implementation lives in shared/ so the
 * server dashboard summary uses the exact same semantics.
 */
export { TERMINAL_SIGN_OFF_STAGES, countDevisSignOff } from "@shared/devis-counters";
