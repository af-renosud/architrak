import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { insertMarcheSchema, type InsertMarche } from "@shared/schema";
import { validateRequest } from "../middleware/validate";
import { requireAuth } from "../auth/middleware";

const router = Router();
const idParams = z.object({ id: z.coerce.number().int().positive() });
const projectIdParams = z.object({ projectId: z.coerce.number().int().positive() });

// Task #566 — the PV de réception lifecycle is server-managed: its fields
// are written only by the dedicated /pv endpoints below (draft) and the
// approve endpoint (approval stamps). Omitting them here makes Zod strip
// them from the generic create/PATCH bodies, so no client can flip a PV to
// "approved" (and unlock the final-payment gate) through a plain PATCH.
const pvServerManagedFields = {
  pvReceptionStatus: true,
  pvDocumentStorageKey: true,
  pvDocumentFileName: true,
  pvAttestationNote: true,
  pvApprovedByUserId: true,
  pvApprovedAt: true,
} as const;

const createMarcheBodySchema = insertMarcheSchema.omit({ projectId: true, ...pvServerManagedFields });
const updateMarcheSchema = insertMarcheSchema.omit(pvServerManagedFields).partial();

// Task #566 — draft PV de réception: the reception date plus EITHER an
// uploaded PV document OR a manual attestation note (legacy paper PV).
const pvBodySchema = z
  .object({
    receptionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "receptionDate must be YYYY-MM-DD"),
    documentStorageKey: z.string().trim().min(1).optional(),
    documentFileName: z.string().trim().min(1).max(300).optional(),
    attestationNote: z.string().trim().min(1).max(1000).optional(),
  })
  .refine((b) => b.documentStorageKey != null || b.attestationNote != null, {
    message: "Un PV de réception exige un document téléversé ou une attestation manuelle.",
  })
  .refine((b) => (b.documentStorageKey == null) === (b.documentFileName == null), {
    message: "documentStorageKey et documentFileName vont ensemble.",
  });

router.get("/api/projects/:projectId/marches", async (req, res) => {
  const marches = await storage.getMarchesByProject(Number(req.params.projectId));
  res.json(marches);
});

router.post(
  "/api/projects/:projectId/marches",
  requireAuth,
  validateRequest({ params: projectIdParams, body: createMarcheBodySchema }),
  async (req, res) => {
    const marche = await storage.createMarche({ ...req.body, projectId: Number(req.params.projectId) });
    res.status(201).json(marche);
  },
);

router.get("/api/marches/:id", async (req, res) => {
  const marche = await storage.getMarche(Number(req.params.id));
  if (!marche) return res.status(404).json({ message: "Marche not found" });
  res.json(marche);
});

router.patch(
  "/api/marches/:id",
  requireAuth,
  validateRequest({ params: idParams, body: updateMarcheSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const existing = await storage.getMarche(id);
    if (!existing) return res.status(404).json({ message: "Marche not found" });
    // Task #566 — once the PV is approved, `receptionDate` is the approved
    // PV's date: the GPA/RG timing and the final-payment gate both read it,
    // so a free-form edit would silently diverge from the approval. Changes
    // require re-recording the PV (out of scope: PVs are not un-approvable
    // through the generic API).
    const body = req.body as Partial<InsertMarche>;
    // The lock is enforced inside the UPDATE's WHERE predicate (race-safe vs
    // a concurrent /pv/approve): a zero-row update on an existing marché
    // means the approved-date lock rejected the write.
    const marche = await storage.updateMarcheWithPvDateGuard(id, body);
    if (!marche) {
      return res.status(409).json({
        code: "PV_APPROVED_DATE_LOCKED",
        message:
          "La date de réception est verrouillée par le PV de réception approuvé — elle ne peut plus être modifiée via le formulaire du marché.",
      });
    }
    res.json(marche);
  },
);

// Task #566 — record (or re-record) the draft PV de réception. Writes the
// reception date into `marches.receptionDate` in the SAME row update, so the
// GPA/RG timing and the PV can never disagree. Refused once approved.
router.post(
  "/api/marches/:id/pv",
  requireAuth,
  validateRequest({ params: idParams, body: pvBodySchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const existing = await storage.getMarche(id);
    if (!existing) return res.status(404).json({ message: "Marche not found" });
    const { receptionDate, documentStorageKey, documentFileName, attestationNote } = req.body;
    // Race-safe: the UPDATE only fires while the PV is unrecorded or draft,
    // so a concurrent approval can never be demoted back to draft.
    const marche = await storage.recordMarchePvDraft(id, {
      receptionDate,
      pvDocumentStorageKey: documentStorageKey ?? null,
      pvDocumentFileName: documentFileName ?? null,
      pvAttestationNote: attestationNote ?? null,
    });
    if (!marche) {
      return res.status(409).json({
        code: "PV_ALREADY_APPROVED",
        message: "Le PV de réception de ce marché est déjà approuvé et ne peut plus être modifié.",
      });
    }
    res.json(marche);
  },
);

// Task #566 — approve the draft PV. Single-row update: the approved status,
// the approver stamps and the (already recorded) reception date commit
// together. Approval is what unlocks the final-payment (solde) gate.
router.post(
  "/api/marches/:id/pv/approve",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const id = Number(req.params.id);
    const user = await storage.getUser(Number(req.session.userId));
    if (!user) return res.status(401).json({ message: "Authentication required" });
    // Race-safe: the draft→approved transition (and the reception-date
    // requirement) live inside the UPDATE predicate. A zero-row update is
    // then disambiguated with a fresh read.
    const marche = await storage.approveMarchePv(id, user.id);
    if (marche) return res.json(marche);
    const existing = await storage.getMarche(id);
    if (!existing) return res.status(404).json({ message: "Marche not found" });
    if (existing.pvReceptionStatus === "approved") return res.json(existing); // idempotent
    if (existing.pvReceptionStatus !== "draft") {
      return res.status(409).json({
        code: "PV_NOT_RECORDED",
        message: "Aucun PV de réception enregistré pour ce marché — enregistrez-le avant de l'approuver.",
      });
    }
    return res.status(409).json({
      code: "PV_RECEPTION_DATE_MISSING",
      message: "Le PV de réception n'a pas de date de réception — enregistrez-la avant l'approbation.",
    });
  },
);

export default router;
