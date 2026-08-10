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
import {
  generateCombinedPdf,
  generateDevisTranslationPdf,
  getValidatedCachedPdfKey,
} from "../communications/devis-translation-generator";

const router = Router();

router.get("/api/public/devis-pdf/:token", async (req, res) => {
  const token = String(req.params.token);
  const verified = verifyPdfFetchToken(token);
  if (!verified) {
    return res.status(401).json({ message: "Invalid or expired PDF fetch token" });
  }
  const { devisId, pinnedStorageKey } = verified;

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

  // Task #378 — v2 tokens carry the EXACT storage key pinned at send time,
  // HMAC-bound inside the token itself. Each envelope's fetch URL therefore
  // resolves to its own immutable snapshot: a later re-send (which pins a
  // new key on the devis) cannot change what an earlier still-valid token
  // serves, and post-send translation/context/analysis edits can never
  // change the bytes the signer receives. FAIL CLOSED if the pinned object
  // is missing — regenerating from current state would silently violate the
  // snapshot guarantee.
  if (pinnedStorageKey) {
    try {
      const { stream, contentType, size } = await getDocumentStream(pinnedStorageKey);
      res.setHeader("Content-Type", contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="DEVIS-${d.devisCode}.pdf"`);
      if (size) res.setHeader("Content-Length", String(size));
      res.setHeader("Cache-Control", "no-store, max-age=0");
      stream.pipe(res);
      return;
    } catch (err) {
      console.error(
        `[ArchisignPublic] Pinned PDF ${pinnedStorageKey} for devis ${devisId} unavailable — failing closed (no regeneration):`,
        err instanceof Error ? err.message : err,
      );
      return res.status(410).json({
        message:
          "The exact PDF snapshot pinned for this signature envelope is no longer available. Re-send the devis for signature to issue a fresh envelope.",
        code: "pinned_pdf_unavailable",
      });
    }
  }

  // Legacy v1 tokens (minted before per-envelope pinning): keep the prior
  // resolution order so envelopes already in flight continue to work.
  if (d.archisignPinnedPdfStorageKey) {
    try {
      const { stream, contentType, size } = await getDocumentStream(d.archisignPinnedPdfStorageKey);
      res.setHeader("Content-Type", contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="DEVIS-${d.devisCode}.pdf"`);
      if (size) res.setHeader("Content-Length", String(size));
      res.setHeader("Cache-Control", "no-store, max-age=0");
      stream.pipe(res);
      return;
    } catch (err) {
      console.error(
        `[ArchisignPublic] Devis-level pinned PDF ${d.archisignPinnedPdfStorageKey} for devis ${devisId} unavailable (legacy token) — falling back to regeneration:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Fingerprint-validated cache reads — a per-line context save racing this
  // request must force regeneration rather than serving a stale PDF.
  let storageKey = await getValidatedCachedPdfKey(devisId, "combined");
  if (!storageKey) {
    try {
      const merged = await generateCombinedPdf(devisId, { includeExplanations: false });
      storageKey = merged.storageKey;
    } catch {
      // Fall through to translation-only variant.
    }
  }
  if (!storageKey) {
    storageKey = await getValidatedCachedPdfKey(devisId, "translated");
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
