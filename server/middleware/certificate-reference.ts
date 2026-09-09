import type { RequestHandler } from "express";

export const CERTIFICATE_REFERENCE_SERVER_MANAGED =
  "CERTIFICATE_REFERENCE_SERVER_MANAGED";

/**
 * Certificate references are legal/audit identifiers allocated by the
 * application. Reject (rather than silently strip) any client attempt to set
 * one so every HTTP creation and mutation boundary is unambiguous.
 */
export const rejectClientCertificateReference: RequestHandler = (
  req,
  res,
  next,
) => {
  if (
    req.body != null &&
    typeof req.body === "object" &&
    Object.prototype.hasOwnProperty.call(req.body, "certificateRef")
  ) {
    return res.status(400).json({
      code: CERTIFICATE_REFERENCE_SERVER_MANAGED,
      message:
        "Certificate numbers are assigned automatically by the application and cannot be supplied or changed.",
    });
  }
  next();
};