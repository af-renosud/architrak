import { Router, type Request } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { rateLimit } from "../middleware/rate-limit";
import {
  hashToken,
  resolveClientCheckToken,
  computeTokenExpiry,
} from "../services/client-checks";
import type { ClientCheckToken, Devis, ClientCheck, DevisTranslationLine, DevisTranslationHeader } from "@shared/schema";
import { getDocumentStream } from "../storage/object-storage";
import {
  loadLineContextRenders,
  generateCombinedPdf,
  getValidatedCachedPdfKey,
} from "../communications/devis-translation-generator";
import { renderCostAnalysisHtml } from "../communications/cost-analysis-renderer";
import { getConfirmedCostAnalysisDocument } from "../services/devis-cost-analysis";
import {
  renderClientInvalid,
  renderClientExpired,
  renderClientPortalShell,
} from "./client-portal-shell";

// Re-exported so existing imports (client-checks.ts architect preview) keep
// working after the Task #389 modularization of the shell template.
export { renderClientPortalShell };

/**
 * Shape returned by both the live (token-authed) and preview (architect-authed)
 * portal data endpoints. Mirrors the contractor portal's PortalDataPayload but
 * scoped to client_check_* rows. Includes the devis snapshot, the project
 * meta, and the chronological list of open + resolved client checks with
 * their message threads.
 *
 * Task #389 — the payload now carries the full bilingual quotation: per-line
 * English translations (finalised translations only), per-line contextual
 * notes as pre-rendered safe HTML, the confirmed non-stale cost analysis as
 * pre-rendered safe HTML, and a flag for the complete-package download.
 *
 * Note: unlike the contractor portal we DO show resolved checks, because the
 * client view doubles as a dialogue log.
 */
export interface ClientPortalDataPayload {
  devis: {
    ref: string;
    description: string | null;
    /** English description (descriptionUk) shown beneath the FR label
     *  when present — Renosud's clients are routinely bilingual. */
    descriptionEn: string | null;
    hasPdf: boolean;
    amountHt: string | null;
  };
  project: { name: string } | null;
  client: { name: string | null; email: string };
  /** Finalised translation header (EN scope description), or null. */
  translationHeaderEn: string | null;
  /** Finalised translation document overview (EN summary), or null. */
  translationSummary: string | null;
  /** True when the combined EN+FR package PDF can be downloaded. */
  packageAvailable: boolean;
  /**
   * Confirmed, non-stale cost analysis as pre-rendered safe HTML from the
   * whitelisting serializer (cost-analysis-renderer.ts), or null. ONLY
   * status=confirmed with a matching quotationFingerprint goes outbound.
   */
  analysisHtml: string | null;
  /** Devis line items, ordered by lineNumber so the client can review the
   *  itemised breakdown without having to scroll the PDF. Decimal amounts
   *  arrive as strings (Postgres `numeric`) — the shell renders them
   *  unchanged. */
  lineItems: Array<{
    id: number;
    lineNumber: number | null;
    description: string | null;
    /** English translation of the line (finalised translations only). */
    translationEn: string | null;
    /**
     * Architect-authored contextual note, pre-rendered into safe HTML by
     * the whitelisting serializer (context-doc-renderer.ts) with owned
     * image assets inlined as base64 data URIs. Null when absent.
     */
    contextHtml: string | null;
    quantity: string | null;
    unit: string | null;
    unitPrice: string | null;
    totalHt: string | null;
  }>;
  /** True after the client signalled an agreement via the retired verdict
   *  buttons (historical rows only — the endpoints are retired). */
  agreed: boolean;
  /** True after the client signalled a rejection (historical rows only). */
  rejected: boolean;
  checks: Array<{
    id: number;
    status: string;
    query: string;
    originSource: string;
    /** Line item the question is anchored to ("Ask about this"), or null. */
    devisLineItemId: number | null;
    openedAt: Date | string;
    resolvedAt: Date | string | null;
    /** Synthetic verdict tag on historical rows minted by the retired
     *  Agree/Reject buttons. UI renders those as audit badges. */
    verdict: "agree" | "reject" | null;
    messages: Array<{
      id: number;
      authorType: string;
      authorName: string | null;
      body: string;
      createdAt: Date | string;
    }>;
  }>;
}

/**
 * Stable queryText markers for the verdict rows minted by the RETIRED
 * Agree/Reject buttons (Task #389 removed the endpoints — agreement now
 * happens through dialogue plus the e-signature workflow; the
 * `client_agreed` / `client_rejected` SIGN_OFF_STAGES remain reachable via
 * the architect's manual sign-off flow, devis-manual-signoff.ts).
 *
 * The markers and classifier are kept so that:
 *   1. historical verdict rows still render as audit badges in the portal
 *      and still compute the `agreed`/`rejected` summary flags;
 *   2. `stripClientVerdictMarker` keeps sanitising free text — no writer
 *      may EVER mint a new row that classifies as a verdict.
 */
export const CLIENT_VERDICT_AGREE_MARKER = "[VERDICT:AGREE]";
export const CLIENT_VERDICT_REJECT_MARKER = "[VERDICT:REJECT]";

/**
 * Strip a leading verdict marker from user-supplied free text so a malicious
 * client cannot inject a fake verdict via `/queries` or `/messages`. Tolerant
 * of leading whitespace and a trailing space after the marker. Idempotent.
 */
export function stripClientVerdictMarker(body: string): string {
  const re = /^\s*\[VERDICT:(?:AGREE|REJECT)\]\s*/i;
  return body.replace(re, "");
}

export function classifyVerdict(
  c: Pick<ClientCheck, "queryText" | "originSource" | "resolvedBySource" | "status">,
): "agree" | "reject" | null {
  // The (retired) agree endpoint produced: status='resolved',
  // originSource='architrak_internal', resolvedBySource='external'. Refuse
  // to classify rows that don't match the exact shape, so no current or
  // future writer can spoof a verdict even if it slips a marker into
  // queryText.
  if (
    c.queryText.startsWith(CLIENT_VERDICT_AGREE_MARKER) &&
    c.originSource === "architrak_internal" &&
    c.resolvedBySource === "external" &&
    c.status === "resolved"
  ) {
    return "agree";
  }
  // The (retired) reject endpoint produced: status='open',
  // originSource='architrak_internal', resolvedBySource=null.
  if (
    c.queryText.startsWith(CLIENT_VERDICT_REJECT_MARKER) &&
    c.originSource === "architrak_internal" &&
    c.resolvedBySource === null
  ) {
    return "reject";
  }
  return null;
}

/**
 * Loads the outbound-eligible cost analysis for the portal. Delegates the
 * eligibility decision to getConfirmedCostAnalysisDocument — the single
 * outbound gate (confirmed + fingerprint-fresh + schema-valid) shared with
 * the translated/combined PDF generators, so the portal JSON and the
 * downloadable package can never diverge on what the client may see.
 */
async function loadOutboundAnalysisHtml(devisId: number): Promise<string | null> {
  const doc = await getConfirmedCostAnalysisDocument(devisId);
  return doc ? renderCostAnalysisHtml(doc) : null;
}

/**
 * Build the client portal payload for a devis. Shared by the live token
 * portal and the architect's preview endpoint so both render identical
 * content.
 *
 * `tokenContext` carries the token's client identity so we can render the
 * portal header with the actual recipient's name. In preview mode it is
 * omitted and we surface a placeholder.
 */
export async function buildClientPortalPayload(
  devis: Devis,
  tokenContext: { clientName: string | null; clientEmail: string } | null,
): Promise<ClientPortalDataPayload | null> {
  const project = await storage.getProject(devis.projectId);
  const checks = await storage.listClientChecks(devis.id);
  const lineItems = await storage.getDevisLineItems(devis.id);

  // Finalised translations only: the portal is an outbound client surface,
  // so draft/edited translations (still under architect review) stay
  // internal. Mirrors the "finalised devis translation rows" contract.
  const translation = await storage.getDevisTranslation(devis.id);
  const translationFinalised = translation?.status === "finalised";
  const byLineNumber = new Map<number, DevisTranslationLine>();
  if (translationFinalised) {
    for (const t of (translation!.lineTranslations as DevisTranslationLine[] | null) ?? []) {
      byLineNumber.set(t.lineNumber, t);
    }
  }
  const header: DevisTranslationHeader = translationFinalised
    ? ((translation!.headerTranslated as DevisTranslationHeader) ?? {})
    : {};

  // Contextual notes ride along with the finalised translation — they are
  // authored for, and rendered into, the same client-facing package.
  const contexts = translationFinalised
    ? await loadLineContextRenders(devis.id)
    : new Map<number, { html: string }>();

  const analysisHtml = translationFinalised
    ? await loadOutboundAnalysisHtml(devis.id)
    : null;

  const packageAvailable = translationFinalised && !!devis.pdfStorageKey;

  // Latest verdict markers determine the agreed/rejected summary flags.
  // Historical only — the verdict endpoints are retired (Task #389).
  let agreed = false;
  let rejected = false;
  const sortedByCreated = [...checks].sort((a, b) => {
    const aT = new Date(a.createdAt).getTime();
    const bT = new Date(b.createdAt).getTime();
    return bT - aT;
  });
  for (const c of sortedByCreated) {
    const v = classifyVerdict(c);
    if (v === "agree") { agreed = true; break; }
    if (v === "reject") { rejected = true; break; }
  }

  const enriched = await Promise.all(
    checks.map(async (c) => {
      const verdict = classifyVerdict(c);
      const displayQuery = verdict
        ? c.queryText.replace(verdict === "agree" ? CLIENT_VERDICT_AGREE_MARKER : CLIENT_VERDICT_REJECT_MARKER, "").trim()
        : c.queryText;
      return {
        id: c.id,
        status: c.status,
        query: displayQuery,
        originSource: c.originSource,
        devisLineItemId: c.devisLineItemId ?? null,
        openedAt: c.openedAt,
        resolvedAt: c.resolvedAt,
        verdict,
        messages: (await storage.listClientCheckMessages(c.id)).map((m) => ({
          id: m.id,
          authorType: m.authorType,
          authorName: m.authorName,
          body: m.body,
          createdAt: m.createdAt,
        })),
      };
    }),
  );

  return {
    devis: {
      ref: devis.devisNumber || devis.devisCode,
      description: devis.descriptionFr,
      descriptionEn: devis.descriptionUk ?? null,
      hasPdf: !!devis.pdfStorageKey,
      amountHt: devis.amountHt ?? null,
    },
    project: project ? { name: project.name } : null,
    client: {
      name: tokenContext?.clientName ?? null,
      email: tokenContext?.clientEmail ?? "",
    },
    translationHeaderEn: header.description ?? null,
    translationSummary: header.summary ?? null,
    packageAvailable,
    analysisHtml,
    lineItems: lineItems.map((li) => ({
      id: li.id,
      lineNumber: li.lineNumber ?? null,
      description: li.description ?? null,
      translationEn: byLineNumber.get(li.lineNumber)?.translation ?? null,
      contextHtml: contexts.get(li.id)?.html ?? null,
      quantity: li.quantity ?? null,
      unit: li.unit ?? null,
      unitPrice: li.unitPriceHt ?? null,
      totalHt: li.totalHt ?? null,
    })),
    agreed,
    rejected,
    checks: enriched,
  };
}

/**
 * Client identity + target devis for the shared write helpers below. Both
 * the per-devis token portal and the project-share detail view resolve
 * their own token flavour, then delegate the actual writes here so the two
 * surfaces stay behaviourally identical (sanitisation, verdict shapes,
 * system messages).
 */
export interface ClientWriteContext {
  devisId: number;
  clientEmail: string;
  clientName: string | null;
}

export async function performClientReply(
  ctx: ClientWriteContext,
  checkId: number,
  body: string,
): Promise<{ status: number; json: { message: string } | { id: number } }> {
  const check = await storage.getClientCheck(checkId);
  if (!check || check.devisId !== ctx.devisId) {
    return { status: 404, json: { message: "Question not found" } };
  }
  if (check.status === "resolved" || check.status === "cancelled") {
    return { status: 409, json: { message: "This question is closed" } };
  }
  // Sanitise: never let user-supplied free text masquerade as a verdict
  // marker. The marker is a dedicated channel reserved for /agree and
  // /reject — see CLIENT_VERDICT_*_MARKER docs above.
  const sanitisedBody = stripClientVerdictMarker(body);
  const msg = await storage.createClientCheckMessage({
    checkId: check.id,
    authorType: "client",
    authorEmail: ctx.clientEmail,
    authorName: ctx.clientName ?? null,
    body: sanitisedBody,
    channel: "portal",
  });
  // Bump updatedAt so the architect sees movement on the thread.
  await storage.updateClientCheck(check.id, {});
  return { status: 201, json: { id: msg.id } };
}

export async function performClientQuery(
  ctx: ClientWriteContext,
  body: string,
  devisLineItemId: number | null = null,
): Promise<{ status: number; json: { message: string } | { id: number } }> {
  // Optional "Ask about this" anchor — the line MUST belong to this devis.
  if (devisLineItemId != null) {
    const lines = await storage.getDevisLineItems(ctx.devisId);
    if (!lines.some((l) => l.id === devisLineItemId)) {
      return { status: 400, json: { message: "This quotation line does not exist on this devis" } };
    }
  }
  // Sanitise: never let user-supplied free text masquerade as a verdict
  // marker. The marker is a dedicated channel reserved for /agree and
  // /reject — see CLIENT_VERDICT_*_MARKER docs above.
  const sanitisedBody = stripClientVerdictMarker(body);
  const check = await storage.createClientCheck({
    devisId: ctx.devisId,
    status: "open",
    queryText: sanitisedBody,
    originSource: "architrak_internal",
    devisLineItemId,
  });
  // Seed the thread with a system-channel row carrying the client's
  // identity so the architect inbox can attribute the question without
  // having to join through the token table.
  await storage.createClientCheckMessage({
    checkId: check.id,
    authorType: "client",
    authorEmail: ctx.clientEmail,
    authorName: ctx.clientName ?? null,
    body: sanitisedBody,
    channel: "portal",
  });
  return { status: 201, json: { id: check.id } };
}

const router = Router();

const tokenParams = z.object({ token: z.string().min(20).max(200) });
const replySchema = z.object({
  checkId: z.number().int().positive(),
  body: z.string().min(1).max(5000),
}).strict();
const newQuerySchema = z.object({
  body: z.string().min(1).max(5000),
  /** Optional "Ask about this" anchor — must be a line of THIS devis. */
  devisLineItemId: z.number().int().positive().optional(),
}).strict();

function tokenFromReq(req: Request): string {
  const raw = req.params.token;
  return typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
}

const ipKeyer = (req: Request) => `ip:${req.ip || req.socket.remoteAddress || "anon"}`;
// Hash the raw token for the bucket key so the limiter store never persists
// raw token material at rest — same pattern as the contractor portal.
const tokenOnlyKeyer = (req: Request) => {
  const raw = tokenFromReq(req);
  return raw ? `ctokh:${hashToken(raw)}` : "ctokh:anon";
};

const portalReadIpLimiter = rateLimit({
  name: "client-portal-read-ip",
  windowMs: 60_000,
  max: 240,
  keyer: ipKeyer,
  message: "Too many requests. Please try again in a minute.",
});
const portalReadTokenLimiter = rateLimit({
  name: "client-portal-read-tok",
  windowMs: 60_000,
  max: 60,
  keyer: tokenOnlyKeyer,
  message: "Too many requests. Please try again in a minute.",
});
const portalWriteIpLimiter = rateLimit({
  name: "client-portal-write-ip",
  windowMs: 60_000,
  max: 30,
  keyer: ipKeyer,
  message: "Too many requests. Please try again in a minute.",
});
const portalWriteTokenLimiter = rateLimit({
  name: "client-portal-write-tok",
  windowMs: 60_000,
  max: 10,
  keyer: tokenOnlyKeyer,
  message: "Too many requests. Please try again in a minute.",
});

async function touchToken(token: ClientCheckToken): Promise<void> {
  await storage.touchClientCheckTokenUsed(token.id, computeTokenExpiry());
}

/** HTML shell — vanilla JS, English labels (clients are English speakers), draggable PDF iframe. */
router.get(
  "/p/client/:token",
  portalReadIpLimiter, portalReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      if (lookup.reason === "expired") {
        res.status(410).type("html").send(renderClientExpired());
      } else {
        res.status(404).type("html").send(renderClientInvalid());
      }
      return;
    }
    res.type("html").send(renderClientPortalShell({ mode: "live", token: tokenFromReq(req) }));
  },
);

/** JSON state for the portal. */
router.get(
  "/p/client/:token/data",
  portalReadIpLimiter, portalReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    await touchToken(t);

    const devis = await storage.getDevis(t.devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    const payload = await buildClientPortalPayload(devis, {
      clientName: t.clientName,
      clientEmail: t.clientEmail,
    });
    if (!payload) return res.status(404).json({ message: "Devis not found" });
    res.json(payload);
  },
);

/** Client posts a reply on an existing check thread. */
router.post(
  "/p/client/:token/messages",
  portalWriteIpLimiter, portalWriteTokenLimiter,
  validateRequest({ params: tokenParams, body: replySchema }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const result = await performClientReply(
      { devisId: t.devisId, clientEmail: t.clientEmail, clientName: t.clientName ?? null },
      req.body.checkId,
      req.body.body,
    );
    if (result.status < 400) await touchToken(t);
    res.status(result.status).json(result.json);
  },
);

/**
 * Client opens a brand-new query on this devis (architrak_internal source).
 * Task #389 — may carry a devisLineItemId anchor ("Ask about this" on a
 * specific quotation line); the line MUST belong to this devis.
 */
router.post(
  "/p/client/:token/queries",
  portalWriteIpLimiter, portalWriteTokenLimiter,
  validateRequest({ params: tokenParams, body: newQuerySchema }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const result = await performClientQuery(
      { devisId: t.devisId, clientEmail: t.clientEmail, clientName: t.clientName ?? null },
      req.body.body,
      req.body.devisLineItemId ?? null,
    );
    await touchToken(t);
    res.status(result.status).json(result.json);
  },
);

/**
 * RETIRED verdict endpoints (Task #389, user decision). The portal no longer
 * carries Approve/Decline cards: agreement happens through dialogue plus the
 * e-signature workflow, and the `client_agreed` / `client_rejected`
 * SIGN_OFF_STAGES remain reachable through the architect's manual sign-off
 * flow (devis-manual-signoff.ts), which carries its own audit trail.
 *
 * They answer 410 Gone (not 404) deliberately: a client on a cached copy of
 * the old portal gets an explanatory message rather than a dead click, and
 * the routes remain occupied so nothing else can squat on the paths and
 * mint marker rows. Historical verdict rows remain rendered as audit badges.
 */
export const retiredVerdictHandler = (_req: Request, res: import("express").Response) => {
  res.status(410).json({
    message:
      "Approving or declining through this page has been retired. Please discuss the quotation in the dialogue below — the formal approval happens through the electronic signing workflow.",
  });
};
router.post("/p/client/:token/agree", portalWriteIpLimiter, portalWriteTokenLimiter, retiredVerdictHandler);
router.post("/p/client/:token/reject", portalWriteIpLimiter, portalWriteTokenLimiter, retiredVerdictHandler);

/** Stream the devis PDF inline. */
router.get(
  "/p/client/:token/pdf",
  portalReadIpLimiter, portalReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const devis = await storage.getDevis(t.devisId);
    if (!devis?.pdfStorageKey) return res.status(404).json({ message: "PDF unavailable" });
    try {
      const doc = await getDocumentStream(devis.pdfStorageKey);
      res.setHeader("Content-Type", doc.contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="devis-${devis.devisCode}.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      await touchToken(t);
      doc.stream.pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "PDF read error";
      res.status(500).json({ message: msg });
    }
  },
);

/**
 * Serve the combined "complete package" PDF: the English translation with
 * contextual notes and the confirmed cost analysis, followed by the
 * original French devis. Shared logic with the Archisign public download —
 * fingerprint-validated cache read, regenerate on miss.
 *
 * Gated on a FINALISED translation (same rule as the inline portal
 * content): the package is an outbound client artifact.
 */
export async function streamCombinedPackagePdf(
  devis: Devis,
  res: import("express").Response,
): Promise<void> {
  const translation = await storage.getDevisTranslation(devis.id);
  if (translation?.status !== "finalised" || !devis.pdfStorageKey) {
    res.status(404).json({ message: "The complete package is not available yet." });
    return;
  }
  let storageKey = await getValidatedCachedPdfKey(devis.id, "combined");
  if (!storageKey) {
    try {
      storageKey = (await generateCombinedPdf(devis.id, { includeExplanations: false })).storageKey;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ message: `Package generation failed: ${message}` });
      return;
    }
  }
  try {
    const doc = await getDocumentStream(storageKey);
    res.setHeader("Content-Type", doc.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="DEVIS-${devis.devisCode}-COMPLETE.pdf"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    doc.stream.pipe(res);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "PDF read error";
    res.status(500).json({ message: msg });
  }
}

router.get(
  "/p/client/:token/package.pdf",
  portalReadIpLimiter, portalReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const devis = await storage.getDevis(t.devisId);
    if (!devis) return res.status(404).json({ message: "Devis not found" });
    await touchToken(t);
    await streamCombinedPackagePdf(devis, res);
  },
);

export default router;
