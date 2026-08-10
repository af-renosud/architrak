import { Router } from "express";
import {
  verifyArchidocLookupSignature,
  lookupClientShareLinkForArchidoc,
} from "../services/archidoc-link-lookup";

/**
 * Task #409 — public (non-session) server-to-server endpoint for ArchiDoc.
 *
 * Mounted BEFORE the /api session perimeter (it lives under /integrations,
 * not /api). The HMAC verifier is the only auth wall; see the service for
 * the signature contract. Router stays thin — all business logic lives in
 * server/services/archidoc-link-lookup.ts.
 */
const router = Router();

router.get("/integrations/archidoc/projects/:archidocProjectId/client-share-link", async (req, res) => {
  const auth = verifyArchidocLookupSignature({
    timestampHeader: req.header("x-archidoc-timestamp"),
    signatureHeader: req.header("x-archidoc-signature"),
    method: req.method,
    // originalUrl minus the query string — the exact path ArchiDoc signed.
    path: req.originalUrl.split("?")[0],
  });
  if (!auth.ok) {
    return res.status(auth.status).json({ message: auth.message });
  }

  const archidocProjectId = String(req.params.archidocProjectId ?? "").trim();
  if (!archidocProjectId || archidocProjectId.length > 255) {
    return res.status(400).json({ message: "Invalid ArchiDoc project id." });
  }

  const result = await lookupClientShareLinkForArchidoc(archidocProjectId);
  res.json(result);
});

export default router;
