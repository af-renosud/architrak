/**
 * Signed/Pending counters for devis, shared by the project Devis tab and the
 * dashboard summary so both surfaces always agree.
 *
 * Signed = the terminal success stage `client_signed_off` (NB: there is no
 * "signed" stage in the canonical SIGN_OFF_STAGES enum — a prior version
 * compared against it and could never count anything).
 *
 * Pending = active devis still moving through the signature workflow —
 * terminal stages (client_signed_off, client_rejected, void) are excluded,
 * so a rejected or voided devis is neither pending nor signed.
 */
export const TERMINAL_SIGN_OFF_STAGES: ReadonlyArray<string> = [
  "client_signed_off",
  "client_rejected",
  "void",
];

export function countDevisSignOff(
  activeDevis: ReadonlyArray<{ signOffStage: string }>,
): { pendingDevisCount: number; signedDevisCount: number } {
  return {
    pendingDevisCount: activeDevis.filter(
      d => !TERMINAL_SIGN_OFF_STAGES.includes(d.signOffStage),
    ).length,
    signedDevisCount: activeDevis.filter(
      d => d.signOffStage === "client_signed_off",
    ).length,
  };
}
