/**
 * Task #257 — seal the manual sign-off-stage bypass.
 *
 * Production audit of devis DVT0000941 proved an architect can (could)
 * click "Sent to Client" on the workflow stepper and the generic
 * `PATCH /api/devis/:id` would record `sent_to_client` WITHOUT creating an
 * Archisign envelope, without any email, and without any client
 * notification — the system merely *recorded* "sent" while the client
 * received nothing.
 *
 * This module is the single authority on which manual (generic-PATCH)
 * signOffStage transitions are allowed:
 *
 *   - FORWARD moves into `sent_to_client` are sealed — the ONLY path in is
 *     the signing orchestration (`POST /api/devis/:id/send-to-signer`),
 *     which calls `storage.updateDevis` directly and therefore never
 *     passes through this guard.
 *   - FORWARD moves into `client_signed_off` are sealed — that stage is
 *     driven exclusively by the `envelope.signed` Archisign webhook.
 *   - BACKWARD moves (e.g. correcting a stage, reverting `sent_to_client`
 *     back to `approved_for_signing`) remain allowed so operators can fix
 *     mistakes.
 *
 * The guard intentionally does NOT condition on the *current* stage being
 * inside the linear 5-stage stepper order: a devis sitting in one of the
 * non-linear stages (`client_rejected`, `void`, …) must not be jumpable
 * into `sent_to_client` either, so an unknown/non-linear current stage is
 * treated as "before" the sealed stages (i.e. the move is forward and
 * therefore rejected).
 */

/**
 * Linear stepper order used for forward/backward classification. Mirrors
 * the STAGE_ORDER used by the PATCH gates in `server/routes/devis.ts` and
 * the FE stepper in DevisTab — the non-linear contract stages
 * (`client_review_in_progress`, `client_agreed`, `client_rejected`,
 * `void`) deliberately have no index here.
 */
export const LINEAR_STAGE_ORDER = [
  "received",
  "checked_internal",
  "approved_for_signing",
  "sent_to_client",
  "client_signed_off",
] as const;

/** Stages that can only be entered by the signing orchestration/webhooks. */
export const SEALED_FORWARD_STAGES = new Set<string>([
  "sent_to_client",
  "client_signed_off",
]);

export interface StageSealViolation {
  /** Architect-facing English message pointing at the correct flow. */
  message: string;
  /** Stable machine-readable code for the 409 payload. */
  code: "manual_send_sealed" | "manual_signoff_sealed";
}

/**
 * Returns `null` when the manual transition is allowed, or a violation
 * descriptor (message + code) when the generic PATCH must reject it
 * with a 409.
 */
export function evaluateManualStageTransition(
  currentStage: string,
  nextStage: string,
): StageSealViolation | null {
  if (!SEALED_FORWARD_STAGES.has(nextStage)) return null;
  if (nextStage === currentStage) return null; // no-op write — harmless

  const prevIdx = LINEAR_STAGE_ORDER.indexOf(
    currentStage as (typeof LINEAR_STAGE_ORDER)[number],
  );
  const nextIdx = LINEAR_STAGE_ORDER.indexOf(
    nextStage as (typeof LINEAR_STAGE_ORDER)[number],
  );

  // Backward move (e.g. client_signed_off → sent_to_client correction by
  // an operator) stays allowed. A current stage outside the linear order
  // has prevIdx === -1 and is treated as "before" — i.e. forward — so it
  // cannot be used to sneak into a sealed stage.
  const isBackward = prevIdx !== -1 && nextIdx < prevIdx;
  if (isBackward) return null;

  if (nextStage === "sent_to_client") {
    return {
      code: "manual_send_sealed",
      message:
        "This devis cannot be marked as \"Sent to Client\" manually. " +
        "Use the \"Signature électronique\" panel (\"Send for signature\" button): " +
        "it creates the Archisign envelope, sends the signing link to the client and " +
        "delivers your accompanying message.",
    };
  }
  return {
    code: "manual_signoff_sealed",
    message:
      "This devis cannot be marked as \"Signed by client\" from the stepper. " +
      "It is recorded automatically when the client signs via Archisign — or, if the devis " +
      "was signed outside that flow, use \"Record signed copy\" in the Electronic signature " +
      "panel to upload the signed PDF with an audit note.",
  };
}
