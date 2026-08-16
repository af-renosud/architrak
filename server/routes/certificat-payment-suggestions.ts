import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { confirmPaymentSuggestionSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";

/**
 * Task #466 — review flow for client "paid" reply suggestions.
 *
 * Suggestions are created ONLY by the Gmail reply-scan; these routes let
 * the architect confirm (optionally overriding amount/date/method — writes
 * a source='email' ledger entry inside the atomic payment transaction) or
 * dismiss. Confirm/dismiss are one-shot: an already-reviewed suggestion
 * answers 409 SUGGESTION_ALREADY_REVIEWED.
 */
const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });

// Ledger/audit attribution comes from the SESSION, never the request body —
// an authenticated operator must not be able to sign as someone else. The
// body `reviewedBy` is only a fallback when no session identity exists.
async function resolveActor(req: { session?: { userId?: unknown }; body?: { reviewedBy?: string } }): Promise<string | null> {
  const userId = req.session?.userId ? Number(req.session.userId) : null;
  if (userId) {
    const user = await storage.getUser(userId);
    if (user?.email) return user.email;
    return String(userId);
  }
  return req.body?.reviewedBy ?? null;
}

router.get("/api/certificats/:id/payment-suggestions", validateRequest({ params: idParams }), async (req, res) => {
  res.json(await storage.getCertificatPaymentSuggestions(Number(req.params.id)));
});

// Open (pending_review + ambiguous) suggestions across all projects, with
// certificat/project context — the communications-hub review surface.
router.get("/api/certificat-payment-suggestions", async (_req, res) => {
  res.json(await storage.getOpenPaymentSuggestionsWithContext());
});

router.post(
  "/api/certificat-payment-suggestions/:id/confirm",
  validateRequest({ params: idParams, body: confirmPaymentSuggestionSchema }),
  async (req, res) => {
    const suggestion = await storage.getCertificatPaymentSuggestion(Number(req.params.id));
    if (!suggestion) return res.status(404).json({ message: "Suggestion introuvable" });

    const actor = await resolveActor(req);
    const result = await storage.confirmCertificatPaymentSuggestionAtomic(
      suggestion.id,
      {
        datePaid: req.body.datePaid ?? suggestion.suggestedDate,
        amount: req.body.amount ?? suggestion.suggestedAmount,
        method: req.body.method ?? "virement",
        reference:
          req.body.reference ??
          (suggestion.kind === "contractor_received"
            ? `Confirmation entreprise du ${suggestion.suggestedDate}`
            : `Confirmation client du ${suggestion.suggestedDate}`),
        loggedBy: actor,
      },
      actor,
    );

    switch (result.outcome) {
      case "not_found":
        return res.status(404).json({ message: "Suggestion introuvable" });
      case "already_reviewed":
        return res.status(409).json({ code: "SUGGESTION_ALREADY_REVIEWED", message: "Cette suggestion a déjà été traitée." });
      case "superseded":
        return res.status(409).json({ code: "CERTIFICAT_SUPERSEDED", message: `Le certificat ${result.cert.certificateRef} a été remplacé par une réédition.` });
      case "draft":
        return res.status(409).json({ code: "CERTIFICAT_DRAFT", message: `Le certificat ${result.cert.certificateRef} est encore un brouillon.` });
      case "locked":
        return res.status(409).json({ code: "PAYMENTS_LOCKED", message: `Le certificat ${result.cert.certificateRef} est déjà intégralement payé.` });
      case "ok":
        return res.json({ suggestion: result.suggestion, payment: result.payment, ...result.state });
    }
  },
);

router.post(
  "/api/certificat-payment-suggestions/:id/dismiss",
  validateRequest({ params: idParams, body: z.object({ reviewedBy: z.string().trim().max(200).optional() }).optional() }),
  async (req, res) => {
    const row = await storage.dismissCertificatPaymentSuggestion(Number(req.params.id), await resolveActor(req));
    if (!row) {
      const exists = await storage.getCertificatPaymentSuggestion(Number(req.params.id));
      if (!exists) return res.status(404).json({ message: "Suggestion introuvable" });
      return res.status(409).json({ code: "SUGGESTION_ALREADY_REVIEWED", message: "Cette suggestion a déjà été traitée." });
    }
    res.json(row);
  },
);

// Task #529 — archived (reviewed) suggestions with context, for the hub's
// Archives view.
router.get("/api/certificat-payment-suggestions/archived", async (_req, res) => {
  res.json(await storage.getArchivedPaymentSuggestionsWithContext());
});

// Task #529 — visibility-only archive of a REVIEWED suggestion (confirmed
// or dismissed). Open suggestions cannot be archived: they are pending
// money decisions and must stay in the review queue.
router.post(
  "/api/certificat-payment-suggestions/:id/archive",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const row = await storage.setPaymentSuggestionArchived(Number(req.params.id), true);
    if (!row) {
      const exists = await storage.getCertificatPaymentSuggestion(Number(req.params.id));
      if (!exists) return res.status(404).json({ message: "Suggestion introuvable" });
      return res.status(409).json({ code: "SUGGESTION_OPEN", message: "Une suggestion en attente de revue ne peut pas être archivée." });
    }
    res.json(row);
  },
);

router.post(
  "/api/certificat-payment-suggestions/:id/unarchive",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const row = await storage.setPaymentSuggestionArchived(Number(req.params.id), false);
    if (!row) return res.status(404).json({ message: "Suggestion introuvable" });
    res.json(row);
  },
);

export default router;
