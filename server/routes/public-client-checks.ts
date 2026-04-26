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
import type { ClientCheckToken, Devis, ClientCheck } from "@shared/schema";
import { getDocumentStream } from "../storage/object-storage";

/**
 * Shape returned by both the live (token-authed) and preview (architect-authed)
 * portal data endpoints. Mirrors the contractor portal's PortalDataPayload but
 * scoped to client_check_* rows. Includes the devis snapshot, the project
 * meta, and the chronological list of open + resolved client checks with
 * their message threads.
 *
 * Note: unlike the contractor portal we DO show resolved checks, because the
 * client view doubles as a verdict log — once the client has agreed/rejected
 * the resolved row needs to remain visible so they can see what they have
 * already signalled.
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
  /** Devis line items, ordered by lineNumber so the client can review the
   *  itemised breakdown without having to scroll the PDF. Decimal amounts
   *  arrive as strings (Postgres `numeric`) — the shell renders them
   *  unchanged. */
  lineItems: Array<{
    id: number;
    lineNumber: number | null;
    description: string | null;
    quantity: string | null;
    unit: string | null;
    unitPrice: string | null;
    totalHt: string | null;
  }>;
  /** True after the client has signalled an agreement on this devis. */
  agreed: boolean;
  /** True after the client has signalled a rejection on this devis. */
  rejected: boolean;
  checks: Array<{
    id: number;
    status: string;
    query: string;
    originSource: string;
    openedAt: Date | string;
    resolvedAt: Date | string | null;
    /** Synthetic verdict tag set on the rows minted by the Agree/Reject
     *  buttons. UI uses it to render those rows differently from regular
     *  questions (badge instead of query bubble). */
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
 * Stable queryText markers for the verdict rows minted by the Agree/Reject
 * buttons. The portal uses these markers to render the rows as verdict
 * badges, and the architect's read of the data uses them to compute the
 * `agreed` / `rejected` summary flags.
 *
 * Integrity model: the only writers that may produce a row whose `queryText`
 * starts with one of these markers are the `/agree` and `/reject` endpoints.
 * Every user-supplied free-text body (`/queries`, `/messages`) is funnelled
 * through `stripClientVerdictMarker` before persistence, so a malicious
 * client cannot spoof a verdict by posting a question that begins with the
 * marker string. Combined with the marker check, the most-recent verdict
 * row therefore reliably reflects an actual click on Approve / Reject.
 *
 * Defence-in-depth: if a future writer is ever added that bypasses this
 * sanitiser, `classifyVerdict` ALSO requires the row's `resolvedBySource`
 * (for agree) / `originSource` (for both) to match the shape produced by
 * the verdict endpoints. The marker alone is not sufficient.
 *
 * They live here (not in @shared) because nothing client-side currently
 * needs them — the architect UI consumes the same data endpoint and reads
 * the precomputed `agreed`/`rejected` flags.
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
  // The agree endpoint produces: status='resolved', originSource='architrak_internal',
  // resolvedBySource='external'. Refuse to classify rows that don't match the
  // exact shape, so a hypothetical future writer can't spoof a verdict by
  // accident even if it manages to slip a marker into queryText.
  if (
    c.queryText.startsWith(CLIENT_VERDICT_AGREE_MARKER) &&
    c.originSource === "architrak_internal" &&
    c.resolvedBySource === "external" &&
    c.status === "resolved"
  ) {
    return "agree";
  }
  // The reject endpoint produces: status='open', originSource='architrak_internal',
  // resolvedBySource=null (architect must react to close).
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

  // Latest verdict markers determine the agreed/rejected summary flags.
  // We scan all checks (resolved + open) — the markers identify verdict
  // rows regardless of their downstream status. Most-recent wins so the
  // client can change their mind by clicking the other button later.
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
    lineItems: lineItems.map((li) => ({
      id: li.id,
      lineNumber: li.lineNumber ?? null,
      description: li.description ?? null,
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

const router = Router();

const tokenParams = z.object({ token: z.string().min(20).max(200) });
const replySchema = z.object({
  checkId: z.number().int().positive(),
  body: z.string().min(1).max(5000),
}).strict();
const newQuerySchema = z.object({
  body: z.string().min(1).max(5000),
}).strict();
const verdictSchema = z.object({
  note: z.string().max(5000).optional(),
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
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});
const portalReadTokenLimiter = rateLimit({
  name: "client-portal-read-tok",
  windowMs: 60_000,
  max: 60,
  keyer: tokenOnlyKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});
const portalWriteIpLimiter = rateLimit({
  name: "client-portal-write-ip",
  windowMs: 60_000,
  max: 30,
  keyer: ipKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});
const portalWriteTokenLimiter = rateLimit({
  name: "client-portal-write-tok",
  windowMs: 60_000,
  max: 10,
  keyer: tokenOnlyKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});

async function touchToken(token: ClientCheckToken): Promise<void> {
  await storage.touchClientCheckTokenUsed(token.id, computeTokenExpiry());
}

/** HTML shell — vanilla JS, French labels, draggable PDF iframe. */
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
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    await touchToken(t);

    const devis = await storage.getDevis(t.devisId);
    if (!devis) return res.status(404).json({ message: "Devis introuvable" });
    const payload = await buildClientPortalPayload(devis, {
      clientName: t.clientName,
      clientEmail: t.clientEmail,
    });
    if (!payload) return res.status(404).json({ message: "Devis introuvable" });
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
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const check = await storage.getClientCheck(req.body.checkId);
    if (!check || check.devisId !== t.devisId) {
      return res.status(404).json({ message: "Question introuvable" });
    }
    if (check.status === "resolved" || check.status === "cancelled") {
      return res.status(409).json({ message: "Cette question est clôturée" });
    }
    // Sanitise: never let user-supplied free text masquerade as a verdict
    // marker. The marker is a dedicated channel reserved for /agree and
    // /reject — see CLIENT_VERDICT_*_MARKER docs above.
    const sanitisedBody = stripClientVerdictMarker(req.body.body);
    const msg = await storage.createClientCheckMessage({
      checkId: check.id,
      authorType: "client",
      authorEmail: t.clientEmail,
      authorName: t.clientName ?? null,
      body: sanitisedBody,
      channel: "portal",
    });
    // Bump updatedAt so the architect sees movement on the thread.
    await storage.updateClientCheck(check.id, {});
    await touchToken(t);
    res.status(201).json({ id: msg.id });
  },
);

/** Client opens a brand-new query on this devis (architrak_internal source). */
router.post(
  "/p/client/:token/queries",
  portalWriteIpLimiter, portalWriteTokenLimiter,
  validateRequest({ params: tokenParams, body: newQuerySchema }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    // Sanitise: never let user-supplied free text masquerade as a verdict
    // marker. The marker is a dedicated channel reserved for /agree and
    // /reject — see CLIENT_VERDICT_*_MARKER docs above.
    const sanitisedBody = stripClientVerdictMarker(req.body.body);
    const check = await storage.createClientCheck({
      devisId: t.devisId,
      status: "open",
      queryText: sanitisedBody,
      originSource: "architrak_internal",
    });
    // Seed the thread with a system-channel row carrying the client's
    // identity so the architect inbox can attribute the question without
    // having to join through the token table.
    await storage.createClientCheckMessage({
      checkId: check.id,
      authorType: "client",
      authorEmail: t.clientEmail,
      authorName: t.clientName ?? null,
      body: sanitisedBody,
      channel: "portal",
    });
    await touchToken(t);
    res.status(201).json({ id: check.id });
  },
);

/**
 * Verdict actions — the client signals approval or rejection of the devis
 * as a whole. Each click writes a NEW client_check row carrying the verdict
 * marker, so the architect sees an immutable audit trail of clicks rather
 * than mutating an earlier one. The most recent verdict marker wins for the
 * `agreed`/`rejected` summary flags.
 */
router.post(
  "/p/client/:token/agree",
  portalWriteIpLimiter, portalWriteTokenLimiter,
  validateRequest({ params: tokenParams, body: verdictSchema }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const note = (req.body.note ?? "").trim();
    const queryText = note
      ? `${CLIENT_VERDICT_AGREE_MARKER} ${note}`
      : CLIENT_VERDICT_AGREE_MARKER;
    const now = new Date();
    const check = await storage.createClientCheck({
      devisId: t.devisId,
      status: "resolved",
      queryText,
      originSource: "architrak_internal",
      resolvedBySource: "external",
      resolvedByUserEmail: t.clientEmail,
      resolutionNote: note || null,
      resolvedAt: now,
    });
    await storage.createClientCheckMessage({
      checkId: check.id,
      authorType: "system",
      body: `Le client (${t.clientName || t.clientEmail}) a confirmé son accord sur le devis.${note ? `\n\nNote : ${note}` : ""}`,
      channel: "system",
    });
    await touchToken(t);
    res.status(201).json({ id: check.id });
  },
);

router.post(
  "/p/client/:token/reject",
  portalWriteIpLimiter, portalWriteTokenLimiter,
  validateRequest({ params: tokenParams, body: verdictSchema }),
  async (req, res) => {
    const lookup = await resolveClientCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const note = (req.body.note ?? "").trim();
    const queryText = note
      ? `${CLIENT_VERDICT_REJECT_MARKER} ${note}`
      : CLIENT_VERDICT_REJECT_MARKER;
    // Reject lands as status='open' so it shows up in the architect's
    // pending queue — they need to react to it (clarify, revise the devis,
    // close the deal, etc.). Resolution is the architect's call.
    const check = await storage.createClientCheck({
      devisId: t.devisId,
      status: "open",
      queryText,
      originSource: "architrak_internal",
    });
    await storage.createClientCheckMessage({
      checkId: check.id,
      authorType: "system",
      body: `Le client (${t.clientName || t.clientEmail}) a indiqué un refus du devis.${note ? `\n\nMotif : ${note}` : ""}`,
      channel: "system",
    });
    await touchToken(t);
    res.status(201).json({ id: check.id });
  },
);

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
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const devis = await storage.getDevis(t.devisId);
    if (!devis?.pdfStorageKey) return res.status(404).json({ message: "PDF indisponible" });
    try {
      const doc = await getDocumentStream(devis.pdfStorageKey);
      res.setHeader("Content-Type", doc.contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="devis-${devis.devisCode}.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      await touchToken(t);
      doc.stream.pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lecture PDF";
      res.status(500).json({ message: msg });
    }
  },
);

function renderClientInvalid(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Lien invalide</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1f2937}</style>
</head><body data-testid="page-client-invalid"><h1>Lien invalide</h1>
<p>Ce lien n'est plus valable. Merci de contacter votre interlocuteur Renosud pour obtenir un nouveau lien.</p>
</body></html>`;
}

function renderClientExpired(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Lien expiré</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#0f172a;line-height:1.5}
h1{font-size:22px;margin:0 0 12px;color:#b45309}
.note{background:#fef3c7;border-left:3px solid #f59e0b;padding:12px 16px;border-radius:4px;margin:16px 0}
p{margin:8px 0}
</style>
</head><body data-testid="page-client-expired">
<h1>Lien expiré</h1>
<div class="note">Ce lien d'accès au portail de revue client a expiré pour des raisons de sécurité.</div>
<p>Pour reprendre la revue de ce devis, merci de contacter votre interlocuteur Renosud (l'architecte qui vous a transmis ce lien). Il pourra vous générer un nouveau lien d'accès.</p>
<p>Vos précédents messages et décisions sont conservés et restent accessibles à l'équipe Renosud.</p>
</body></html>`;
}

/**
 * Render the client portal HTML shell. Two modes share the same template:
 *   • live: token-authed client portal (writes enabled).
 *   • preview: architect-authed read-only preview, served inside an iframe
 *     in the architect UI. Reply/verdict forms are suppressed and a banner
 *     identifies it as a preview.
 *
 * Kept in this module (rather than reusing renderPortalShell) because the
 * client and contractor portals have distinct action sets (Agree/Reject +
 * "Pose une question" instead of just "Reply"), distinct French copy, and
 * distinct data shapes — sharing a template would push branching deep into
 * the rendering JS and obscure the contract between the two portals.
 */
export function renderClientPortalShell(opts:
  | { mode: "live"; token: string }
  | { mode: "preview"; devisId: number }
): string {
  const isPreview = opts.mode === "preview";
  const dataUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/client-checks/portal-preview/data`
    : `/p/client/${encodeURIComponent(opts.token)}/data`;
  const pdfUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/client-checks/portal-preview/pdf`
    : `/p/client/${encodeURIComponent(opts.token)}/pdf`;
  const messagesUrl = opts.mode === "preview" ? null : `/p/client/${encodeURIComponent(opts.token)}/messages`;
  const queriesUrl = opts.mode === "preview" ? null : `/p/client/${encodeURIComponent(opts.token)}/queries`;
  const agreeUrl = opts.mode === "preview" ? null : `/p/client/${encodeURIComponent(opts.token)}/agree`;
  const rejectUrl = opts.mode === "preview" ? null : `/p/client/${encodeURIComponent(opts.token)}/reject`;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${isPreview ? "Aperçu architecte — " : ""}Espace client — Renosud</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  .preview-banner { background: #fef3c7; color: #78350f; border-bottom: 2px solid #f59e0b; padding: 8px 16px; font-size: 12px; font-weight: 600; text-align: center; letter-spacing: 0.02em; }
  header { background: #0B2545; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; padding-bottom: 80px; }
  .devis-info { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .devis-info h3 { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: #0f172a; }
  .devis-desc { margin: 0 0 6px; font-size: 13px; color: #334155; line-height: 1.5; }
  .devis-desc-en { color: #64748b; }
  .devis-total { margin: 8px 0 12px; font-size: 13px; color: #0f172a; }
  .devis-lines { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .devis-lines th, .devis-lines td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; vertical-align: top; }
  .devis-lines th { background: #f1f5f9; font-weight: 600; color: #475569; }
  .devis-lines td:nth-child(3), .devis-lines td:nth-child(5), .devis-lines td:nth-child(6),
  .devis-lines th:nth-child(3), .devis-lines th:nth-child(5), .devis-lines th:nth-child(6) { text-align: right; white-space: nowrap; }
  .verdict-strip { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .verdict-card { flex: 1; min-width: 240px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; }
  .verdict-card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: #0f172a; }
  .verdict-card p { margin: 0 0 12px; font-size: 13px; color: #475569; line-height: 1.4; }
  .verdict-card.agreed { border-color: #059669; background: #ecfdf5; }
  .verdict-card.rejected { border-color: #dc2626; background: #fef2f2; }
  .verdict-status { font-size: 12px; font-weight: 600; margin-top: 6px; }
  .verdict-status.agreed { color: #047857; }
  .verdict-status.rejected { color: #b91c1c; }
  .check { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px; padding: 16px; }
  .check.verdict-agree { border-left: 4px solid #059669; }
  .check.verdict-reject { border-left: 4px solid #dc2626; }
  .check h3 { margin: 0 0 8px; font-size: 14px; color: #475569; font-weight: 600; }
  .query { background: #fef3c7; border-left: 3px solid #f59e0b; padding: 8px 12px; margin: 0 0 12px; font-size: 14px; }
  .verdict-tag { display: inline-block; padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px; }
  .verdict-tag.agree { background: #d1fae5; color: #065f46; }
  .verdict-tag.reject { background: #fee2e2; color: #991b1b; }
  .status { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; }
  .status-open { background: #fee2e2; color: #991b1b; }
  .status-resolved { background: #dcfce7; color: #166534; }
  .status-cancelled { background: #f1f5f9; color: #64748b; }
  .messages { margin: 12px 0; }
  .msg { padding: 8px 12px; margin: 6px 0; border-radius: 6px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; }
  .msg-architect { background: #f1f5f9; }
  .msg-client { background: #eff6ff; }
  .msg-system { background: #fefce8; color: #78350f; font-style: italic; font-size: 13px; }
  .msg-meta { font-size: 11px; color: #64748b; margin-bottom: 2px; font-style: normal; }
  textarea { width: 100%; min-height: 70px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; padding: 8px; font: inherit; resize: vertical; }
  button { background: #0B2545; color: #fff; border: 0; border-radius: 4px; padding: 8px 14px; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.btn-agree { background: #059669; }
  button.btn-reject { background: #dc2626; }
  button.btn-secondary { background: #fff; color: #0B2545; border: 1px solid #0B2545; }
  .ask-section { background: #fff; border: 1px dashed #94a3b8; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .ask-section h3 { margin: 0 0 8px; font-size: 14px; }
  .ask-section .hint { font-size: 12px; color: #64748b; margin: 0 0 8px; }
  .pdf-toggle { position: fixed; bottom: 20px; right: 20px; z-index: 9; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .pdf-panel { position: fixed; bottom: 80px; right: 20px; width: 480px; height: 640px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,0.2); display: none; flex-direction: column; z-index: 10; }
  .pdf-panel.open { display: flex; }
  .pdf-handle { padding: 8px 12px; background: #0B2545; color: #fff; cursor: move; user-select: none; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .pdf-handle button { background: transparent; padding: 2px 8px; }
  .pdf-frame { flex: 1; border: 0; border-radius: 0 0 8px 8px; }
  .pdf-resize { position: absolute; bottom: 2px; right: 2px; width: 14px; height: 14px; cursor: nwse-resize; opacity: 0.5; z-index: 2; }
  .empty { color: #64748b; font-style: italic; padding: 24px; text-align: center; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 6px; }
  dialog { border: 0; border-radius: 8px; padding: 0; box-shadow: 0 20px 50px rgba(0,0,0,0.3); max-width: 480px; width: 90%; }
  dialog::backdrop { background: rgba(15, 23, 42, 0.5); }
  .dlg-body { padding: 20px; }
  .dlg-body h3 { margin: 0 0 8px; font-size: 16px; }
  .dlg-body p { margin: 0 0 12px; font-size: 13px; color: #475569; line-height: 1.4; }
  .dlg-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
</style>
</head>
<body${isPreview ? ` data-preview="1"` : ""}>
${isPreview ? `<div class="preview-banner" data-testid="banner-client-preview">Aperçu architecte — les actions ne seront pas envoyées.</div>` : ""}
<header>
  <h1>Espace client — Renosud</h1>
  <div class="meta" id="meta">Chargement…</div>
</header>
<main id="root"><div class="empty">Chargement…</div></main>

<button class="pdf-toggle" id="pdfToggle" type="button" data-testid="button-client-pdf-toggle">Voir le devis (PDF)</button>
<div class="pdf-panel" id="pdfPanel">
  <div class="pdf-handle" id="pdfHandle">
    <span>Devis — PDF</span>
    <button id="pdfClose" type="button" aria-label="Fermer">×</button>
  </div>
  <iframe id="pdfFrame" class="pdf-frame" title="Devis PDF" src="about:blank" data-testid="iframe-client-pdf"></iframe>
  <div class="pdf-resize" id="pdfResize"></div>
</div>

<dialog id="verdictDialog" data-testid="dialog-verdict">
  <form method="dialog" class="dlg-body" id="verdictForm">
    <h3 id="verdictTitle"></h3>
    <p id="verdictBody"></p>
    <textarea id="verdictNote" placeholder="Note ou motif (optionnel)" maxlength="5000" data-testid="textarea-verdict-note"></textarea>
    <div class="err" id="verdictErr"></div>
    <div class="dlg-actions">
      <button type="button" class="btn-secondary" id="verdictCancel" data-testid="button-verdict-cancel">Annuler</button>
      <button type="button" id="verdictConfirm" data-testid="button-verdict-confirm">Confirmer</button>
    </div>
  </form>
</dialog>

<script>
const DATA_URL = ${JSON.stringify(dataUrl)};
const PDF_URL = ${JSON.stringify(pdfUrl)};
const MESSAGES_URL = ${messagesUrl === null ? "null" : JSON.stringify(messagesUrl)};
const QUERIES_URL = ${queriesUrl === null ? "null" : JSON.stringify(queriesUrl)};
const AGREE_URL = ${agreeUrl === null ? "null" : JSON.stringify(agreeUrl)};
const REJECT_URL = ${rejectUrl === null ? "null" : JSON.stringify(rejectUrl)};
const PREVIEW_MODE = ${isPreview ? "true" : "false"};
const STATUS_LABELS = {
  open: "Ouvert",
  resolved: "Clôturé",
  cancelled: "Annulé",
};

async function loadData() {
  const r = await fetch(DATA_URL);
  if (r.status === 410) {
    const j = await r.json().catch(() => ({}));
    document.getElementById("root").innerHTML =
      '<div class="empty" data-testid="text-client-expired">' +
      escapeHtml(j.message || "Lien expiré. Veuillez contacter votre interlocuteur Renosud.") +
      '</div>';
    return null;
  }
  if (!r.ok) {
    document.getElementById("root").innerHTML = '<div class="empty">Lien invalide ou expiré.</div>';
    return null;
  }
  return r.json();
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function render(data) {
  const meta = document.getElementById("meta");
  const subject = (data.project && data.project.name) ? (data.project.name + " — devis " + (data.devis.ref || "")) : ("devis " + (data.devis.ref || ""));
  meta.textContent = subject;
  const root = document.getElementById("root");

  const devisInfo = renderDevisInfo(data);
  const verdictStrip = renderVerdictStrip(data);
  const askBlock = PREVIEW_MODE ? renderAskBlockPreview() : renderAskBlock();
  const checksBlock = data.checks.length ? data.checks.map(renderCheck).join("") : '<div class="empty" data-testid="text-no-checks">Aucune question pour l\\'instant.</div>';

  root.innerHTML = devisInfo + verdictStrip + askBlock + checksBlock;

  if (!PREVIEW_MODE) {
    wireAskForm();
    wireReplyForms();
    wireVerdictButtons(data);
  }
}

function renderDevisInfo(data) {
  // Compact summary card so the client sees what they're being asked to
  // approve: project / ref, FR + EN descriptions, total HT, line items.
  const d = data.devis || {};
  const titleBits = [d.ref ? 'Devis ' + escapeHtml(d.ref) : null].filter(Boolean);
  const title = titleBits.length ? '<h3 data-testid="text-devis-ref">' + titleBits.join(' — ') + '</h3>' : '';
  const descFr = d.description ? '<p class="devis-desc" data-testid="text-devis-description-fr">' + escapeHtml(d.description) + '</p>' : '';
  const descEn = d.descriptionEn ? '<p class="devis-desc devis-desc-en" data-testid="text-devis-description-en"><em>' + escapeHtml(d.descriptionEn) + '</em></p>' : '';
  const total = d.amountHt ? '<p class="devis-total" data-testid="text-devis-amount-ht"><strong>Montant HT :</strong> ' + escapeHtml(d.amountHt) + ' €</p>' : '';
  const items = Array.isArray(data.lineItems) ? data.lineItems : [];
  const itemsBlock = items.length
    ? '<table class="devis-lines" data-testid="table-devis-line-items">'
      + '<thead><tr><th>N°</th><th>Description</th><th>Qté</th><th>Unité</th><th>PU HT</th><th>Total HT</th></tr></thead>'
      + '<tbody>'
      + items.map((li) => '<tr data-testid="row-line-item-' + li.id + '">'
          + '<td>' + escapeHtml(li.lineNumber || '') + '</td>'
          + '<td>' + escapeHtml(li.description || '') + '</td>'
          + '<td>' + escapeHtml(li.quantity || '') + '</td>'
          + '<td>' + escapeHtml(li.unit || '') + '</td>'
          + '<td>' + escapeHtml(li.unitPrice || '') + '</td>'
          + '<td>' + escapeHtml(li.totalHt || '') + '</td>'
          + '</tr>').join('')
      + '</tbody></table>'
    : '';
  const inner = title + descFr + descEn + total + itemsBlock;
  if (!inner) return '';
  return '<section class="devis-info" data-testid="section-devis-info">' + inner + '</section>';
}

function renderVerdictStrip(data) {
  const agreeStatus = data.agreed
    ? '<div class="verdict-status agreed" data-testid="status-agreed">✓ Accord enregistré</div>'
    : '';
  const rejectStatus = data.rejected
    ? '<div class="verdict-status rejected" data-testid="status-rejected">✗ Refus enregistré</div>'
    : '';
  const agreeBtn = PREVIEW_MODE
    ? '<button type="button" class="btn-agree" disabled data-testid="button-agree-disabled">Approuver le devis</button>'
    : '<button type="button" class="btn-agree" id="btnAgree" data-testid="button-agree">Approuver le devis</button>';
  const rejectBtn = PREVIEW_MODE
    ? '<button type="button" class="btn-reject" disabled data-testid="button-reject-disabled">Refuser le devis</button>'
    : '<button type="button" class="btn-reject" id="btnReject" data-testid="button-reject">Refuser le devis</button>';
  return '<div class="verdict-strip" data-testid="section-verdict-strip">'
    + '<div class="verdict-card ' + (data.agreed ? 'agreed' : '') + '">'
    + '<h3>Validation du devis</h3>'
    + '<p>Cliquez pour confirmer votre accord sur ce devis. Vous pouvez ajouter une note explicative.</p>'
    + agreeBtn + agreeStatus
    + '</div>'
    + '<div class="verdict-card ' + (data.rejected ? 'rejected' : '') + '">'
    + '<h3>Refus du devis</h3>'
    + '<p>Si vous souhaitez refuser ou demander une révision, signalez-le ici. Votre architecte sera notifié.</p>'
    + rejectBtn + rejectStatus
    + '</div>'
    + '</div>';
}

function renderAskBlock() {
  return '<div class="ask-section" data-testid="section-ask">'
    + '<h3>Poser une nouvelle question</h3>'
    + '<p class="hint">Votre architecte recevra votre question et y répondra dans le fil de discussion ci-dessous.</p>'
    + '<form id="askForm">'
    + '<textarea id="askBody" required maxlength="5000" placeholder="Votre question…" data-testid="textarea-new-query"></textarea>'
    + '<div style="margin-top:8px;display:flex;gap:8px;align-items:center;">'
    + '<button type="submit" data-testid="button-send-new-query">Envoyer la question</button>'
    + '<span class="err" id="askErr"></span>'
    + '</div>'
    + '</form>'
    + '</div>';
}

function renderAskBlockPreview() {
  return '<div class="ask-section">'
    + '<h3>Poser une nouvelle question</h3>'
    + '<p class="hint">Aperçu architecte — formulaire désactivé.</p>'
    + '<textarea disabled placeholder="Votre question…" data-testid="textarea-new-query-disabled"></textarea>'
    + '<div style="margin-top:8px"><button type="button" disabled data-testid="button-send-new-query-disabled">Envoyer la question</button></div>'
    + '</div>';
}

function renderCheck(c) {
  const verdictTag = c.verdict
    ? '<span class="verdict-tag ' + c.verdict + '" data-testid="tag-verdict-' + c.verdict + '-' + c.id + '">'
        + (c.verdict === 'agree' ? 'Accord client' : 'Refus client') + '</span>'
    : '';
  const head = c.verdict
    ? verdictTag
    : '<h3>Question<span class="status status-' + c.status + '">' + (STATUS_LABELS[c.status] || c.status) + '</span></h3>';
  // For verdict rows we only show the optional note (already stripped of
  // the marker); regular questions render the queryText as the prompt.
  const queryBlock = c.verdict
    ? (c.query ? '<p class="query">' + escapeHtml(c.query) + '</p>' : '')
    : '<p class="query">' + escapeHtml(c.query) + '</p>';
  const msgs = c.messages.map((m) => {
    let author;
    if (m.authorType === 'client') author = m.authorName || 'Vous';
    else if (m.authorType === 'system') author = 'Système';
    else author = 'Renosud';
    return '<div class="msg msg-' + m.authorType + '"><div class="msg-meta">' + escapeHtml(author) + '</div>' + escapeHtml(m.body) + '</div>';
  }).join('');
  const canReply = c.status === 'open' && !c.verdict && !PREVIEW_MODE;
  const replyForm = canReply
    ? '<form data-check="' + c.id + '" data-testid="form-reply-' + c.id + '"><textarea required maxlength="5000" data-testid="textarea-reply-' + c.id + '" placeholder="Votre réponse…"></textarea><div style="margin-top:8px;display:flex;gap:8px;align-items:center;"><button type="submit" data-testid="button-send-reply-' + c.id + '">Envoyer</button><span class="err" data-err="' + c.id + '"></span></div></form>'
    : '';
  const cls = c.verdict ? 'check verdict-' + c.verdict : 'check';
  return '<section class="' + cls + '" data-testid="check-' + c.id + '">' + head
    + queryBlock
    + '<div class="messages">' + msgs + '</div>' + replyForm + '</section>';
}

function wireAskForm() {
  const form = document.getElementById('askForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ta = document.getElementById('askBody');
    const err = document.getElementById('askErr');
    err.textContent = '';
    const body = (ta.value || '').trim();
    if (!body) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const r = await fetch(QUERIES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        err.textContent = j.message || 'Erreur lors de l\\'envoi.';
      } else {
        ta.value = '';
        await refresh();
      }
    } catch (_e) {
      err.textContent = 'Erreur réseau.';
    } finally {
      btn.disabled = false;
    }
  });
}

function wireReplyForms() {
  document.querySelectorAll('form[data-check]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const checkId = Number(form.getAttribute('data-check'));
      const ta = form.querySelector('textarea');
      const errEl = form.querySelector('[data-err="' + checkId + '"]');
      if (errEl) errEl.textContent = '';
      const body = (ta.value || '').trim();
      if (!body) return;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      try {
        const r = await fetch(MESSAGES_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkId, body }) });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          if (errEl) errEl.textContent = j.message || 'Erreur lors de l\\'envoi.';
        } else {
          ta.value = '';
          await refresh();
        }
      } catch (_e) {
        if (errEl) errEl.textContent = 'Erreur réseau.';
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function wireVerdictButtons(data) {
  const dialog = document.getElementById('verdictDialog');
  const titleEl = document.getElementById('verdictTitle');
  const bodyEl = document.getElementById('verdictBody');
  const noteEl = document.getElementById('verdictNote');
  const errEl = document.getElementById('verdictErr');
  const cancelBtn = document.getElementById('verdictCancel');
  const confirmBtn = document.getElementById('verdictConfirm');
  let pendingUrl = null;

  function open(kind) {
    pendingUrl = kind === 'agree' ? AGREE_URL : REJECT_URL;
    titleEl.textContent = kind === 'agree' ? 'Confirmer votre accord' : 'Confirmer votre refus';
    bodyEl.textContent = kind === 'agree'
      ? 'Vous allez signaler à votre architecte que vous approuvez ce devis. Une note est optionnelle.'
      : 'Vous allez signaler à votre architecte que vous refusez ou souhaitez modifier ce devis. Précisez le motif si possible.';
    noteEl.value = '';
    errEl.textContent = '';
    confirmBtn.classList.remove('btn-agree', 'btn-reject');
    confirmBtn.classList.add(kind === 'agree' ? 'btn-agree' : 'btn-reject');
    confirmBtn.textContent = kind === 'agree' ? 'Approuver' : 'Refuser';
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  cancelBtn.addEventListener('click', () => dialog.close());
  confirmBtn.addEventListener('click', async () => {
    if (!pendingUrl) return;
    confirmBtn.disabled = true;
    errEl.textContent = '';
    try {
      const r = await fetch(pendingUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: noteEl.value || undefined }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        errEl.textContent = j.message || 'Erreur lors de l\\'envoi.';
      } else {
        dialog.close();
        await refresh();
      }
    } catch (_e) {
      errEl.textContent = 'Erreur réseau.';
    } finally {
      confirmBtn.disabled = false;
    }
  });

  const agreeBtn = document.getElementById('btnAgree');
  const rejectBtn = document.getElementById('btnReject');
  if (agreeBtn) agreeBtn.addEventListener('click', () => open('agree'));
  if (rejectBtn) rejectBtn.addEventListener('click', () => open('reject'));
}

async function refresh() {
  const data = await loadData();
  if (data) render(data);
}

// PDF panel — drag/resize/toggle. The client portal uses the browser's
// native PDF viewer in an iframe (no pdf.js highlight overlay needed —
// there's no per-line jump affordance on this side).
const panel = document.getElementById('pdfPanel');
const handle = document.getElementById('pdfHandle');
const toggle = document.getElementById('pdfToggle');
const closeBtn = document.getElementById('pdfClose');
const frame = document.getElementById('pdfFrame');
const resize = document.getElementById('pdfResize');
let pdfLoaded = false;

toggle.addEventListener('click', () => {
  panel.classList.toggle('open');
  if (panel.classList.contains('open') && !pdfLoaded) {
    frame.src = PDF_URL;
    pdfLoaded = true;
  }
});
closeBtn.addEventListener('click', () => panel.classList.remove('open'));

(function dragify() {
  let dragging = false; let dx = 0, dy = 0;
  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    dragging = true;
    const r = panel.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.left = (e.clientX - dx) + 'px';
    panel.style.top = (e.clientY - dy) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });
})();

(function resizify() {
  let resizing = false;
  resize.addEventListener('mousedown', (e) => { resizing = true; e.preventDefault(); e.stopPropagation(); });
  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const r = panel.getBoundingClientRect();
    panel.style.width = Math.max(280, e.clientX - r.left) + 'px';
    panel.style.height = Math.max(240, e.clientY - r.top) + 'px';
  });
  window.addEventListener('mouseup', () => { resizing = false; });
})();

refresh();
</script>
</body>
</html>`;
}

export default router;
