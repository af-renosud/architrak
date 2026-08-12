import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertSituationSchema } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import { evaluateAcompteGate, gateInputsFromDevis } from "../services/acompte.service";
import { getDocumentStream } from "../storage/object-storage";
import { roundCurrency } from "@shared/financial-utils";
import {
  SituationReviewError,
  confirmSituation,
  getBaseline,
  getSituationReview,
  recomputeDraftSituation,
} from "../services/situation-review.service";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const devisIdParams = z.object({ devisId: z.coerce.number().int().positive() });
const situationIdParams = z.object({ situationId: z.coerce.number().int().positive() });

// Task #450 — seal the state machine + provenance: `status`, `confirmedAt`
// and source-PDF/audit columns must never be settable through the generic
// create/update endpoints (state moves only via /confirm; provenance is set
// only by the intake pipeline). Omitted from the SCHEMA, not just guarded,
// so a crafted body can't move money without an audit trail.
// (Task #449's source-PDF provenance columns are already omitted from
// insertSituationSchema itself, so they can never appear here.)
const sealedSituationFields = {
  status: true,
  confirmedAt: true,
  aiExtractedData: true,
} as const;
// Review follow-up — financial header totals are server-computed from the
// lines (recomputeDraftSituation / confirmSituation). They may be supplied
// at CREATE time (legacy manual header entry, before any lines exist) but
// must never be patchable afterwards, or a crafted PATCH could inject
// money into a draft header that the UI then displays as authoritative.
const sealedSituationMoneyFields = {
  cumulativeHt: true,
  previousHt: true,
  netHt: true,
  retenueGarantie: true,
  netToPayHt: true,
  tvaAmount: true,
  netToPayTtc: true,
} as const;
const createSituationBodySchema = insertSituationSchema
  .omit({ devisId: true })
  .omit(sealedSituationFields);
const updateSituationSchema = insertSituationSchema
  .omit(sealedSituationFields)
  .omit(sealedSituationMoneyFields)
  .partial();
// Task #450 — generic line creation is draft-only and accepts ONLY the
// devis line reference and the approved %. All money (cumulative /
// previous / net) and review fields (claimedPercent, checkStatus,
// checkNotes) are server-computed or server-owned — sealed by schema.
const createLineBodySchema = z
  .object({
    devisLineItemId: z.coerce.number().int().positive(),
    percentComplete: z.coerce.number().min(0).max(100),
  })
  .strict();

function handleReviewError(err: unknown, res: import("express").Response) {
  if (err instanceof SituationReviewError) {
    return res.status(err.status).json({ message: err.message });
  }
  throw err;
}

router.get("/api/devis/:devisId/situations", async (req, res) => {
  const sits = await storage.getSituationsByDevis(Number(req.params.devisId));
  res.json(sits);
});

router.post(
  "/api/devis/:devisId/situations",
  validateRequest({ params: devisIdParams, body: createSituationBodySchema }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    // Task #215 — block progress invoicing while a required acompte
    // is still pending/invoiced (override: allowProgressBeforeAcompte).
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const decision = evaluateAcompteGate(gateInputsFromDevis(devis));
    if (decision.blocked) {
      return res.status(409).json({
        message: decision.message,
        code: decision.code,
        acompteState: decision.state,
      });
    }
    const situation = await storage.createSituation({ ...req.body, devisId });
    res.status(201).json(situation);
  },
);

router.get("/api/situations/:id", async (req, res) => {
  const situation = await storage.getSituation(Number(req.params.id));
  if (!situation) return res.status(404).json({ message: "Situation not found" });
  res.json(situation);
});

router.patch(
  "/api/situations/:id",
  validateRequest({ params: idParams, body: updateSituationSchema }),
  async (req, res) => {
    const existing = await storage.getSituation(Number(req.params.id));
    if (!existing) return res.status(404).json({ message: "Situation not found" });
    // Confirmed situations are the baseline for later ones — immutable.
    if (existing.status !== "draft") {
      return res.status(409).json({ message: "Confirmed situations cannot be edited" });
    }
    // Task #449/#450 — sealed fields are omitted from the Zod schema, but
    // delete them from the body outright (belt-and-braces — see the devis
    // state-machine seal).
    const body = { ...req.body };
    for (const k of [...Object.keys(sealedSituationFields), ...Object.keys(sealedSituationMoneyFields)]) {
      delete (body as Record<string, unknown>)[k];
    }
    const situation = await storage.updateSituation(Number(req.params.id), body);
    res.json(situation);
  },
);

// Task #449 — operator confirmation of an auto-attached source PDF
// (draft→confirm). Reviewed attachments made through the intake attach
// flow are confirmed at attach time and don't need this.
router.post(
  "/api/situations/:id/confirm-source",
  validateRequest({ params: idParams, body: z.object({ confirmedBy: z.string().optional() }) }),
  async (req, res) => {
    const id = Number(req.params.id);
    const situation = await storage.getSituation(id);
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    if (!situation.sourceStorageKey) {
      return res.status(409).json({ message: "This situation has no source PDF attached." });
    }
    if (situation.sourceConfirmedAt) return res.json(situation);
    const updated = await storage.confirmSituationSourcePdf(id, req.body.confirmedBy ?? "operator");
    res.json(updated);
  },
);

// Task #449 — download the retained signed source PDF.
router.get(
  "/api/situations/:id/source",
  validateRequest({ params: idParams }),
  async (req, res) => {
    const situation = await storage.getSituation(Number(req.params.id));
    if (!situation) return res.status(404).json({ message: "Situation not found" });
    if (!situation.sourceStorageKey) {
      return res.status(404).json({ message: "This situation has no source PDF attached." });
    }
    try {
      const { stream, contentType, size } = await getDocumentStream(situation.sourceStorageKey);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${situation.sourceFileName ?? `situation-${situation.id}.pdf`}"`);
      if (size) res.setHeader("Content-Length", String(size));
      stream.pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Download failed: ${message}` });
    }
  },
);

/** Task #450 — full review payload: situation + lines joined with devis
 *  line metadata, previous validated %, claimed %, approved %, and
 *  advisory flags (regression / jump / claim_on_rejected). */
router.get(
  "/api/situations/:id/review",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const review = await getSituationReview(Number(req.params.id));
      res.json(review);
    } catch (err) {
      handleReviewError(err, res);
    }
  },
);

router.get("/api/situations/:situationId/lines", async (req, res) => {
  const lines = await storage.getSituationLines(Number(req.params.situationId));
  res.json(lines);
});

/** Generic line creation — draft-only; money computed server-side from the
 *  confirmed baseline (never trusted from the client). */
router.post(
  "/api/situations/:situationId/lines",
  validateRequest({ params: situationIdParams, body: createLineBodySchema }),
  async (req, res) => {
    try {
      const situationId = Number(req.params.situationId);
      const situation = await storage.getSituation(situationId);
      if (!situation) return res.status(404).json({ message: "Situation not found" });
      if (situation.status !== "draft") {
        return res.status(409).json({ message: "Lines can only be added to a draft situation" });
      }
      const devisLine = (await storage.getDevisLineItems(situation.devisId)).find(
        (dl) => dl.id === req.body.devisLineItemId,
      );
      if (!devisLine) {
        return res.status(422).json({ message: "devisLineItemId does not belong to this situation's devis" });
      }
      const existingLines = await storage.getSituationLines(situationId);
      if (existingLines.some((l) => l.devisLineItemId === devisLine.id)) {
        return res.status(409).json({ message: "This devis line already has a line on this situation" });
      }

      const { byLineItem: baseline } = await getBaseline(situation.devisId);
      const previousAmount = baseline.get(devisLine.id)?.cumulativeAmount ?? 0;
      const approved = Number(req.body.percentComplete);
      const cumulativeAmount = roundCurrency((parseFloat(devisLine.totalHt) * approved) / 100);
      const netAmount = roundCurrency(cumulativeAmount - previousAmount);

      let created;
      try {
        created = await storage.createSituationLine({
          situationId,
          devisLineItemId: devisLine.id,
          percentComplete: approved.toFixed(2),
          cumulativeAmount: cumulativeAmount.toFixed(2),
          previousAmount: previousAmount.toFixed(2),
          netAmount: netAmount.toFixed(2),
          claimedPercent: null,
          checkStatus: "unchecked",
          checkNotes: null,
        });
      } catch (e: unknown) {
        // Unique (situation_id, devis_line_item_id) — migration 0077. A
        // concurrent request won the race; surface as the same 409 the
        // check above produces.
        if (typeof e === "object" && e !== null && (e as { code?: string }).code === "23505") {
          return res.status(409).json({ message: "This devis line already has a line on this situation" });
        }
        throw e;
      }
      await recomputeDraftSituation(situationId);
      res.status(201).json(created);
    } catch (err) {
      handleReviewError(err, res);
    }
  },
);

const situationLineReviewSchema = z
  .object({
    percentComplete: z.coerce.number().min(0).max(100).optional(),
    checkStatus: z.enum(["unchecked", "green", "amber", "red"]).optional(),
    checkNotes: z.string().max(2000).nullable().optional(),
  })
  .strict();

/** Per-line review edit (approved %, traffic-light status, notes).
 *  Only while the parent situation is a draft; all money is recomputed
 *  server-side (roundCurrency) after a % change. */
router.patch(
  "/api/situation-lines/:id",
  validateRequest({ params: idParams, body: situationLineReviewSchema }),
  async (req, res) => {
    try {
      const line = await storage.getSituationLine(Number(req.params.id));
      if (!line) return res.status(404).json({ message: "Situation line not found" });
      const situation = await storage.getSituation(line.situationId);
      if (!situation) return res.status(404).json({ message: "Situation not found" });
      if (situation.status !== "draft") {
        return res.status(409).json({ message: "Lines of a confirmed situation cannot be edited" });
      }
      const patch: Record<string, unknown> = {};
      if (req.body.percentComplete !== undefined) {
        patch.percentComplete = Number(req.body.percentComplete).toFixed(2);
      }
      if (req.body.checkStatus !== undefined) patch.checkStatus = req.body.checkStatus;
      if (req.body.checkNotes !== undefined) patch.checkNotes = req.body.checkNotes;
      const updated = await storage.updateSituationLine(line.id, patch);
      if (req.body.percentComplete !== undefined) {
        await recomputeDraftSituation(situation.id);
        const fresh = await storage.getSituationLine(line.id);
        return res.json(fresh ?? updated);
      }
      res.json(updated);
    } catch (err) {
      handleReviewError(err, res);
    }
  },
);

/** Draft → confirmed. Requires every line resolved (non-unchecked);
 *  recomputes all money server-side before flipping status. */
router.post(
  "/api/situations/:id/confirm",
  validateRequest({ params: idParams }),
  async (req, res) => {
    try {
      const situation = await confirmSituation(Number(req.params.id));
      res.json(situation);
    } catch (err) {
      handleReviewError(err, res);
    }
  },
);

export default router;
