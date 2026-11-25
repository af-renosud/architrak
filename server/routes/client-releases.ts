import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import {
  getClientRelease,
  getLatestClientRelease,
  listClientReleasesForDevis,
  readClientContentVersion,
  streamReleaseOriginal,
  streamReleasePackage,
  type FrozenClientPayload,
} from "../services/client-quotation-release";
import { isQuotationClientVisible, updateClientCopy } from "../services/client-project-share";
import { db } from "../db";

/**
 * Architect access to the sealed client copies of a quotation: the history
 * of every version a client could see, and downloads of the exact bytes.
 * Mounted at the app root under /api (behind the authenticated perimeter).
 */
const router = Router();
const devisParams = z.object({ devisId: z.coerce.number().int().positive() });
const releaseParams = devisParams.extend({ releaseId: z.coerce.number().int().positive() });

router.get("/api/devis/:devisId/client-releases",
  validateRequest({ params: devisParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    const rows = await listClientReleasesForDevis(devisId);
    if (!devis && rows.length === 0) return res.status(404).json({ message: "Quotation not found" });
    const users = new Map<number, string>();
    for (const r of rows) {
      if (r.sealedByUserId && !users.has(r.sealedByUserId)) {
        const u = await storage.getUser(r.sealedByUserId);
        users.set(r.sealedByUserId, u ? (`${u.firstName ?? ""} ${u.lastName ?? ""}`.trim() || u.email) : "—");
      }
    }
    const currentVersion = devis ? await readClientContentVersion(db, devisId) : null;
    const latest = rows[0] ?? null;
    res.json({
      clientVisible: devis ? await isQuotationClientVisible(devisId) : false,
      outdated: !!latest && currentVersion !== latest.contentVersion,
      releases: rows.map((r, i) => ({
        id: r.id,
        reason: r.reason,
        sealedAt: r.sealedAt,
        sealedBy: r.sealedByUserId ? users.get(r.sealedByUserId) ?? "—" : null,
        current: i === 0,
        hasPackage: !!r.packageStorageKey,
        packageSha256: r.packageSha256,
        packageBytes: r.packageBytes,
        hasOriginal: !!r.originalStorageKey,
        originalSha256: r.originalSha256,
        translationShown: !!(r.payload as FrozenClientPayload).packageAvailable,
      })),
    });
  });

router.get("/api/devis/:devisId/client-releases/:releaseId/package.pdf",
  validateRequest({ params: releaseParams }),
  async (req, res) => {
    const release = await getClientRelease(Number(req.params.devisId), Number(req.params.releaseId));
    if (!release) return res.status(404).json({ message: "Sealed copy not found" });
    await streamReleasePackage(release, res, req.query.download !== "1");
  });

router.get("/api/devis/:devisId/client-releases/:releaseId/original.pdf",
  validateRequest({ params: releaseParams }),
  async (req, res) => {
    const release = await getClientRelease(Number(req.params.devisId), Number(req.params.releaseId));
    if (!release) return res.status(404).json({ message: "Sealed copy not found" });
    await streamReleaseOriginal(release, res);
  });

router.post("/api/devis/:devisId/client-releases/update",
  validateRequest({ params: devisParams }),
  async (req, res) => {
    const devisId = Number(req.params.devisId);
    const devis = await storage.getDevis(devisId);
    if (!devis) return res.status(404).json({ message: "Quotation not found" });
    const userId = req.session?.userId ? Number(req.session.userId) : null;
    const result = await updateClientCopy(devisId, userId);
    if (!result.ok) return res.status(409).json(result);
    const latest = await getLatestClientRelease(devisId);
    res.json({ ok: true, releaseId: latest?.id ?? result.releaseId, unchanged: result.unchanged });
  });

export default router;
