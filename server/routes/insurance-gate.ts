/**
 * Insurance gate routes (AT3, contract §1.3 + §2.1.4).
 *
 *   - GET  /api/devis/:id/insurance-verdict   — fetch live + mirror decision
 *                                               (architect-blocking, 5s budget)
 *   - GET  /api/devis/:id/insurance-overrides — list audit-trail rows
 *   - POST /api/devis/:id/insurance-overrides — record an override
 *
 * Lifecycle gate enforcement (`approved_for_signing → sent_to_client`)
 * lives in `server/routes/devis.ts` and re-uses `evaluateInsuranceGate`
 * + `getLatestInsuranceOverrideForDevis` directly so the architect-side
 * UX (this router) and the lifecycle handler stay in lock-step.
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth/middleware";
import { evaluateInsuranceGate, type GateDecision } from "../services/insurance-verdict";

const router = Router();

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const overrideBodySchema = z.object({
  overrideReason: z
    .string()
    .trim()
    .min(10, "Le motif d'override doit comporter au moins 10 caractères.")
    .max(2000),
  // The architect's UI also POSTs the snapshot it just saw, but we
  // intentionally ignore those fields and re-derive them server-side
  // from a fresh `evaluateInsuranceGate()` call so the audit row
  // cannot be tampered with from the wire.
}).passthrough();

function decisionToWire(d: GateDecision) {
  return {
    arm: d.arm,
    proceed: d.proceed,
    overridable: d.overridable,
    reason: d.reason,
    liveVerdictHttpStatus: d.liveVerdictHttpStatus,
    liveVerdictCanProceed: d.liveVerdictCanProceed,
    liveVerdictResponse: d.liveVerdictResponse,
    mirrorStatus: d.mirrorStatus,
    mirrorSyncedAt: d.mirrorSyncedAt.toISOString(),
    liveAttempted: d.liveAttempted,
  };
}

// GET — fresh verdict for the override modal + UI banner
router.get("/api/devis/:id/insurance-verdict", requireAuth, async (req, res) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ message: "Invalid devis id" });
  const decision = await evaluateInsuranceGate(params.data.id);
  if ("error" in decision) return res.status(404).json({ message: "Devis not found" });
  return res.json(decisionToWire(decision));
});

// GET — full audit list (for the Insurance section history view)
router.get("/api/devis/:id/insurance-overrides", requireAuth, async (req, res) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ message: "Invalid devis id" });
  const devis = await storage.getDevis(params.data.id);
  if (!devis) return res.status(404).json({ message: "Devis not found" });
  const rows = await storage.listInsuranceOverridesForDevis(params.data.id);
  return res.json(rows);
});

// POST — record a new override row (immutable audit per §1.3)
router.post("/api/devis/:id/insurance-overrides", requireAuth, async (req, res) => {
  const params = idParamSchema.safeParse(req.params);
  if (!params.success) return res.status(400).json({ message: "Invalid devis id" });
  const userId = (req.session as { userId?: number } | undefined)?.userId;
  if (!userId) return res.status(401).json({ message: "Authentication required" });
  const user = await storage.getUser(Number(userId));
  if (!user) return res.status(401).json({ message: "Authentication required" });

  const body = overrideBodySchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ message: "Invalid override payload", errors: body.error.flatten() });
  }

  const devis = await storage.getDevis(params.data.id);
  if (!devis) return res.status(404).json({ message: "Devis not found" });

  // Re-evaluate live verdict server-side: if it now reports green
  // (canProceed:true) OR red-not-found (non-overridable), reject the
  // override so the audit log doesn't accumulate spurious rows.
  const fresh = await evaluateInsuranceGate(params.data.id);
  if ("error" in fresh) return res.status(404).json({ message: "Devis not found" });
  if (fresh.proceed) {
    return res.status(409).json({
      message: "L'assurance est désormais valide — aucun override nécessaire.",
      decision: decisionToWire(fresh),
    });
  }
  if (!fresh.overridable) {
    return res.status(409).json({
      message:
        "Cette situation n'est pas surchargeable depuis Architrak (ex. 404 Archidoc) — corriger l'affectation côté Archidoc.",
      decision: decisionToWire(fresh),
    });
  }

  // Snapshot the audit row from the SERVER-side fresh verdict — never
  // trust client-supplied values. This guarantees the audit log
  // reflects the verdict that was actually in effect at the moment
  // the override was minted.
  const row = await storage.createInsuranceOverride({
    devisId: params.data.id,
    userId: user.id,
    overrideReason: body.data.overrideReason,
    mirrorStatusAtOverride: fresh.mirrorStatus,
    mirrorSyncedAtAtOverride: fresh.mirrorSyncedAt,
    liveVerdictHttpStatus: fresh.liveVerdictHttpStatus,
    liveVerdictCanProceed: fresh.liveVerdictCanProceed,
    liveVerdictResponse: (fresh.liveVerdictResponse ?? null) as never,
    overriddenByUserEmail: user.email,
  });

  return res.status(201).json(row);
});

export default router;
