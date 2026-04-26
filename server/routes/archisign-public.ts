/**
 * Public devis-PDF fetch endpoint that Archisign downloads from (AT4).
 *
 * GET /api/public/devis-pdf/:token
 *
 * Stateless verification via HMAC-signed token (see
 * server/services/archisign-pdf-token.ts). No session auth — must be
 * publicly reachable since Archisign fetches it server-side from a
 * different origin. Token TTL is 1h (set at mint time); this endpoint
 * fails closed if the token is expired or forged.
 *
 * Returns the COMBINED (FR + EN) translation PDF if available, falling
 * back to the translation-only variant. If neither is generated yet we
 * return 404 — the architect cannot send-to-signer without a translated
 * PDF in the first place, so this is defensive only.
 *
 * NOTE on auth bypass: this route is registered as a publicPath in
 * server/index.ts so it skips the session-auth wall.
 */

import { Router } from "express";
import { storage } from "../storage";
import { verifyPdfFetchToken } from "../services/archisign-pdf-token";
import { getDocumentStream } from "../storage/object-storage";
import { generateCombinedPdf, generateDevisTranslationPdf } from "../communications/devis-translation-generator";

const router = Router();

router.get("/api/public/devis-pdf/:token", async (req, res) => {
  const token = String(req.params.token);
  const verified = verifyPdfFetchToken(token);
  if (!verified) {
    return res.status(401).json({ message: "Invalid or expired PDF fetch token" });
  }
  const { devisId } = verified;

  const d = await storage.getDevis(devisId);
  if (!d) {
    return res.status(404).json({ message: "Devis not found" });
  }
  const translation = await storage.getDevisTranslation(devisId);
  if (!translation) {
    return res.status(404).json({ message: "Translation not generated" });
  }
  const ready = translation.status === "draft" || translation.status === "edited" || translation.status === "finalised";
  if (!ready) {
    return res.status(409).json({ message: "Translation not ready", status: translation.status });
  }

  let storageKey = translation.combinedPdfStorageKey;
  if (!storageKey) {
    try {
      const merged = await generateCombinedPdf(devisId, { includeExplanations: false });
      storageKey = merged.storageKey;
    } catch {
      // Fall through to translation-only variant.
    }
  }
  if (!storageKey) {
    storageKey = translation.translatedPdfStorageKey;
  }
  if (!storageKey) {
    try {
      const generated = await generateDevisTranslationPdf(devisId, { includeExplanations: false });
      storageKey = generated.storageKey;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ message: `PDF generation failed: ${message}` });
    }
  }
  if (!storageKey) {
    return res.status(404).json({ message: "Devis PDF not available" });
  }

  try {
    const { stream, contentType, size } = await getDocumentStream(storageKey);
    const fileName = `DEVIS-${d.devisCode}.pdf`;
    res.setHeader("Content-Type", contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    if (size) res.setHeader("Content-Length", String(size));
    // Archisign will fetch this once and store its own copy. Discourage
    // any caching layer in front of us from holding it (PII).
    res.setHeader("Cache-Control", "no-store, max-age=0");
    stream.pipe(res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ message: `PDF stream failed: ${message}` });
  }
});

export default router;
