import type { NextFunction, Request, Response } from "express";

const CLIENT_FORBIDDEN_TVA_FIELDS = new Set([
  "tvaRateOverride",
  "tvaRatePercent",
  "tvaRateSource",
  "tvaEvidenceKind",
  "tvaAutoliquidation",
  "tvaAmount",
  "netToPayHt",
  "netToPayTtc",
  "totalWorksTtc",
]);

/**
 * Tax decisions and their derived totals are never caller-controlled.
 * Reject rather than silently strip so stale clients and forged requests fail
 * visibly instead of appearing to save a value the server ignored.
 */
export function rejectClientCertificateTva(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const blockedFields = Object.keys(body).filter((key) =>
    CLIENT_FORBIDDEN_TVA_FIELDS.has(key),
  );
  if (blockedFields.length > 0) {
    return res.status(400).json({
      code: "CERTIFICATE_TVA_SERVER_MANAGED",
      message:
        "La TVA et les totaux HT/TTC du certificat sont calculés automatiquement à partir des justificatifs et de la configuration fiscale.",
      blockedFields,
    });
  }
  next();
}