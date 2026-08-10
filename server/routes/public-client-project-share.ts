import { Router, type Request } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { rateLimit } from "../middleware/rate-limit";
import {
  hashToken,
  resolveProjectShareToken,
  computeTokenExpiry,
  isVisibleOnShareLink,
} from "../services/client-project-share";
import {
  classifyVerdict,
  buildClientPortalPayload,
  renderClientPortalShell,
  performClientReply,
  performClientQuery,
  retiredVerdictHandler,
  streamCombinedPackagePdf,
} from "./public-client-checks";
import { getDocumentStream } from "../storage/object-storage";
import type { ClientProjectShareToken, Devis } from "@shared/schema";

/**
 * Public project-scoped client share link (Task #388) — /p/client/project/:token.
 *
 * One link per project listing all quotations the architect has EXPLICITLY
 * published. Constitutional rule (ARCHITECTURE.md §4.8 wire-contract
 * invariant): this is an unauthenticated surface, so the payload is a
 * strict whitelist — NEVER banking fields (IBAN/BIC), aiExtractedData,
 * validationWarnings, storage keys, or unconfirmed analysis content.
 * The analysis/translation fields below are booleans only — availability
 * signals, never the content itself.
 */
export interface ProjectSharePayload {
  project: { name: string } | null;
  client: { name: string | null; email: string };
  quotations: Array<{
    /** Internal devis id — used only to build the per-devis detail URL
     *  under the same project token. Not sensitive (opaque sequence). */
    id: number;
    /** Public devis reference (devisNumber, falling back to devisCode). */
    ref: string;
    /** Trade / lot label, English preferred. */
    trade: string | null;
    description: string | null;
    descriptionEn: string | null;
    amountHt: string | null;
    /** True when a finalised English translation exists. */
    translationAvailable: boolean;
    /** True when a CONFIRMED cost analysis exists (drafts never signalled). */
    analysisAvailable: boolean;
    /** Open client questions on this devis (verdict rows excluded). */
    openQuestionCount: number;
    /** Display status: signed | rejected | awaiting_signature | in_review */
    status: "signed" | "rejected" | "awaiting_signature" | "in_review";
  }>;
}

function publicStatus(devis: Devis): ProjectSharePayload["quotations"][number]["status"] {
  if (devis.signOffStage === "client_signed_off") return "signed";
  if (devis.signOffStage === "client_rejected") return "rejected";
  if (devis.signOffStage === "sent_to_client" || devis.signOffStage === "approved_for_signing") {
    return "awaiting_signature";
  }
  return "in_review";
}

export async function buildProjectSharePayload(
  token: Pick<ClientProjectShareToken, "id" | "projectId" | "clientName" | "clientEmail">,
): Promise<ProjectSharePayload> {
  const project = await storage.getProject(token.projectId);
  const devisIds = await storage.listProjectShareDevisIds(token.id);
  const lots = project ? await storage.getLotsByProject(project.id) : [];
  const lotById = new Map(lots.map((l) => [l.id, l]));

  const quotations: ProjectSharePayload["quotations"] = [];
  for (const devisId of devisIds) {
    const devis = await storage.getDevis(devisId);
    // Defence in depth: membership rows survive state changes, but void /
    // provisional / superseded devis (or cross-project rows, which should
    // be impossible) never render on the public page.
    if (!devis || devis.projectId !== token.projectId || !isVisibleOnShareLink(devis)) continue;
    const [translation, analysis, checks] = await Promise.all([
      storage.getDevisTranslation(devis.id),
      storage.getDevisCostAnalysis(devis.id),
      storage.listClientChecks(devis.id),
    ]);
    const openQuestionCount = checks.filter(
      (c) => c.status === "open" && classifyVerdict(c) === null,
    ).length;
    const lot = devis.lotId != null ? lotById.get(devis.lotId) : undefined;
    const trade = lot
      ? (lot.descriptionUk || lot.descriptionFr)
      : (devis.lotRefText ?? null);
    quotations.push({
      id: devis.id,
      ref: devis.devisNumber || devis.devisCode,
      trade: trade ?? null,
      description: devis.descriptionFr ?? null,
      descriptionEn: devis.descriptionUk ?? null,
      amountHt: devis.amountHt ?? null,
      translationAvailable: translation?.status === "finalised",
      analysisAvailable: analysis?.status === "confirmed",
      openQuestionCount,
      status: publicStatus(devis),
    });
  }
  // Stable ordering: by ref, so the page doesn't reshuffle between visits.
  quotations.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true, sensitivity: "base" }));

  return {
    project: project ? { name: project.name } : null,
    client: { name: token.clientName ?? null, email: token.clientEmail },
    quotations,
  };
}

const router = Router();

const tokenParams = z.object({ token: z.string().min(20).max(200) });

function tokenFromReq(req: Request): string {
  const raw = req.params.token;
  return typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
}

const ipKeyer = (req: Request) => `ip:${req.ip || req.socket.remoteAddress || "anon"}`;
// Hash the raw token for the bucket key so the limiter store never persists
// raw token material at rest — same pattern as the other public portals.
const tokenOnlyKeyer = (req: Request) => {
  const raw = tokenFromReq(req);
  return raw ? `pstokh:${hashToken(raw)}` : "pstokh:anon";
};

const shareReadIpLimiter = rateLimit({
  name: "project-share-read-ip",
  windowMs: 60_000,
  max: 240,
  keyer: ipKeyer,
  message: "Too many requests. Please try again in a minute.",
});
const shareReadTokenLimiter = rateLimit({
  name: "project-share-read-tok",
  windowMs: 60_000,
  max: 60,
  keyer: tokenOnlyKeyer,
  message: "Too many requests. Please try again in a minute.",
});

/** HTML shell — greeting + card list of published quotations. */
router.get(
  "/p/client/project/:token",
  shareReadIpLimiter, shareReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveProjectShareToken(tokenFromReq(req));
    if (!lookup.ok) {
      if (lookup.reason === "expired") {
        res.status(410).type("html").send(renderShareExpired());
      } else {
        res.status(404).type("html").send(renderShareInvalid());
      }
      return;
    }
    res.type("html").send(renderProjectShareShell({ mode: "live", token: tokenFromReq(req) }));
  },
);

/** JSON state for the landing page. */
router.get(
  "/p/client/project/:token/data",
  shareReadIpLimiter, shareReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveProjectShareToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    await storage.touchProjectShareTokenUsed(t.id, computeTokenExpiry());
    const payload = await buildProjectSharePayload(t);
    res.json(payload);
  },
);

/**
 * Per-devis detail view under the SAME project token (Task #393). The
 * quotation cards on the landing page link here. Membership enforcement:
 * the devis must be an explicitly published member of THIS token's
 * project link, belong to the token's project, and still pass the
 * render-time visibility filter — otherwise 404, indistinguishable from
 * a nonexistent devis.
 */
const detailParams = z.object({
  token: z.string().min(20).max(200),
  devisId: z.coerce.number().int().positive(),
});
const detailReplySchema = z.object({
  checkId: z.number().int().positive(),
  body: z.string().min(1).max(5000),
}).strict();
const detailQuerySchema = z.object({
  body: z.string().min(1).max(5000),
  /** Optional "Ask about this" anchor — must be a line of THIS devis. */
  devisLineItemId: z.number().int().positive().optional(),
}).strict();

const shareWriteIpLimiter = rateLimit({
  name: "project-share-write-ip",
  windowMs: 60_000,
  max: 30,
  keyer: ipKeyer,
  message: "Too many requests. Please try again in a minute.",
});
const shareWriteTokenLimiter = rateLimit({
  name: "project-share-write-tok",
  windowMs: 60_000,
  max: 10,
  keyer: tokenOnlyKeyer,
  message: "Too many requests. Please try again in a minute.",
});

function devisIdFromReq(req: Request): number {
  return Number(req.params.devisId);
}

/** Resolve a member devis for this token, or null when unreachable. */
async function resolveMemberDevis(
  token: ClientProjectShareToken,
  devisId: number,
): Promise<Devis | null> {
  const devisIds = await storage.listProjectShareDevisIds(token.id);
  if (!devisIds.includes(devisId)) return null;
  const devis = await storage.getDevis(devisId);
  if (!devis || devis.projectId !== token.projectId || !isVisibleOnShareLink(devis)) return null;
  return devis;
}

type DetailHandler = (
  token: ClientProjectShareToken,
  devis: Devis,
  req: Request,
  res: Parameters<Parameters<Router["get"]>[1]>[1],
) => Promise<void>;

/** Shared token+membership gate for the JSON detail endpoints. */
function detailEndpoint(handler: DetailHandler) {
  return async (req: Request, res: Parameters<DetailHandler>[3]) => {
    const lookup = await resolveProjectShareToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "This link has expired. Please contact your Renosud representative."
        : "Invalid or expired link";
      res.status(status).json({ message, expired: lookup.reason === "expired" });
      return;
    }
    const devis = await resolveMemberDevis(lookup.token, devisIdFromReq(req));
    if (!devis) {
      res.status(404).json({ message: "Quotation not found" });
      return;
    }
    await handler(lookup.token, devis, req, res);
  };
}

/** HTML shell for the detail view — reuses the client portal shell. */
router.get(
  "/p/client/project/:token/devis/:devisId",
  shareReadIpLimiter, shareReadTokenLimiter,
  validateRequest({ params: detailParams }),
  async (req, res) => {
    const lookup = await resolveProjectShareToken(tokenFromReq(req));
    if (!lookup.ok) {
      if (lookup.reason === "expired") {
        res.status(410).type("html").send(renderShareExpired());
      } else {
        res.status(404).type("html").send(renderShareInvalid());
      }
      return;
    }
    const devis = await resolveMemberDevis(lookup.token, devisIdFromReq(req));
    if (!devis) {
      res.status(404).type("html").send(renderShareInvalid());
      return;
    }
    res.type("html").send(renderClientPortalShell({
      mode: "project-share",
      token: tokenFromReq(req),
      devisId: devis.id,
    }));
  },
);

/** JSON state for the detail view — same whitelisted DTO as the per-devis portal. */
router.get(
  "/p/client/project/:token/devis/:devisId/data",
  shareReadIpLimiter, shareReadTokenLimiter,
  validateRequest({ params: detailParams }),
  detailEndpoint(async (t, devis, _req, res) => {
    await storage.touchProjectShareTokenUsed(t.id, computeTokenExpiry());
    const payload = await buildClientPortalPayload(devis, {
      clientName: t.clientName ?? null,
      clientEmail: t.clientEmail,
    });
    if (!payload) {
      res.status(404).json({ message: "Quotation not found" });
      return;
    }
    res.json(payload);
  }),
);

/** Stream the devis PDF inline (membership-gated). */
router.get(
  "/p/client/project/:token/devis/:devisId/pdf",
  shareReadIpLimiter, shareReadTokenLimiter,
  validateRequest({ params: detailParams }),
  detailEndpoint(async (t, devis, _req, res) => {
    if (!devis.pdfStorageKey) {
      res.status(404).json({ message: "PDF unavailable" });
      return;
    }
    try {
      const doc = await getDocumentStream(devis.pdfStorageKey);
      res.setHeader("Content-Type", doc.contentType || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="devis-${devis.devisCode}.pdf"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      await storage.touchProjectShareTokenUsed(t.id, computeTokenExpiry());
      doc.stream.pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "PDF read error";
      res.status(500).json({ message: msg });
    }
  }),
);

/** Client replies on an existing check thread (same semantics as per-devis portal). */
router.post(
  "/p/client/project/:token/devis/:devisId/messages",
  shareWriteIpLimiter, shareWriteTokenLimiter,
  validateRequest({ params: detailParams, body: detailReplySchema }),
  detailEndpoint(async (t, devis, req, res) => {
    const result = await performClientReply(
      { devisId: devis.id, clientEmail: t.clientEmail, clientName: t.clientName ?? null },
      req.body.checkId,
      req.body.body,
    );
    if (result.status < 400) await storage.touchProjectShareTokenUsed(t.id, computeTokenExpiry());
    res.status(result.status).json(result.json);
  }),
);

/** Client opens a brand-new query on this devis. */
router.post(
  "/p/client/project/:token/devis/:devisId/queries",
  shareWriteIpLimiter, shareWriteTokenLimiter,
  validateRequest({ params: detailParams, body: detailQuerySchema }),
  detailEndpoint(async (t, devis, req, res) => {
    const result = await performClientQuery(
      { devisId: devis.id, clientEmail: t.clientEmail, clientName: t.clientName ?? null },
      req.body.body,
      req.body.devisLineItemId ?? null,
    );
    await storage.touchProjectShareTokenUsed(t.id, computeTokenExpiry());
    res.status(result.status).json(result.json);
  }),
);

/**
 * Verdict endpoints are NOT exposed here: the per-devis portal retired
 * /agree and /reject (Task #389 — approval happens through dialogue plus
 * the e-signature workflow), and this surface must not resurrect them.
 * The tombstone handlers keep the paths occupied with an explanatory 410.
 */
router.post("/p/client/project/:token/devis/:devisId/agree", shareWriteIpLimiter, shareWriteTokenLimiter, retiredVerdictHandler);
router.post("/p/client/project/:token/devis/:devisId/reject", shareWriteIpLimiter, shareWriteTokenLimiter, retiredVerdictHandler);

/** Download the combined EN+FR "complete package" PDF (membership-gated). */
router.get(
  "/p/client/project/:token/devis/:devisId/package.pdf",
  shareReadIpLimiter, shareReadTokenLimiter,
  validateRequest({ params: detailParams }),
  detailEndpoint(async (t, devis, _req, res) => {
    await storage.touchProjectShareTokenUsed(t.id, computeTokenExpiry());
    await streamCombinedPackagePdf(devis, res);
  }),
);

function renderShareInvalid(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invalid link</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1f2937}</style>
</head><body data-testid="page-project-share-invalid"><h1>Invalid link</h1>
<p>This link is no longer valid. Please contact your Renosud representative to obtain a new link.</p>
</body></html>`;
}

function renderShareExpired(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Link expired</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#0f172a;line-height:1.5}
h1{font-size:22px;margin:0 0 12px;color:#b45309}
.note{background:#fef3c7;border-left:3px solid #f59e0b;padding:12px 16px;border-radius:4px;margin:16px 0}
p{margin:8px 0}
</style>
</head><body data-testid="page-project-share-expired">
<h1>Link expired</h1>
<div class="note">This link has expired for security reasons.</div>
<p>Please contact your Renosud representative (the architect who sent you this link). They can generate a new access link for you.</p>
</body></html>`;
}

/**
 * Shell for the project landing page. Two modes:
 *  - live:    the public client-facing page under /p/client/project/:token
 *  - preview: the authenticated architect preview (Task #403) — data comes
 *             from the /api preview endpoint, quotation cards link to the
 *             existing per-devis architect preview shell (forms disabled),
 *             and a banner makes the preview state unmistakable. Nothing in
 *             preview mode touches token last-used/expiry tracking.
 */
export function renderProjectShareShell(
  opts: { mode: "live"; token: string } | { mode: "preview"; projectId: number },
): string {
  const isPreview = opts.mode === "preview";
  const dataUrl = isPreview
    ? `/api/projects/${opts.projectId}/client-share/preview/data`
    : `/p/client/project/${encodeURIComponent(opts.token)}/data`;
  const detailUrlBase = isPreview
    ? "/api/devis"
    : `/p/client/project/${encodeURIComponent(opts.token)}/devis`;
  const detailUrlSuffix = isPreview ? "/client-checks/portal-preview/shell" : "";
  const previewBanner = isPreview
    ? `<div class="preview-banner" data-testid="banner-project-share-preview">Architect preview — this is what the client will see. Nothing is sent or recorded.</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Your quotations — Renosud</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  header { background: #0B2545; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; padding-bottom: 60px; }
  .greeting { font-size: 15px; margin: 0 0 16px; color: #334155; }
  a.card { display: block; text-decoration: none; color: inherit; }
  a.card:hover { border-color: #94a3b8; box-shadow: 0 2px 8px rgba(15,23,42,0.08); }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  .open-hint { font-size: 12px; color: #2563eb; font-weight: 600; margin-top: 10px; }
  .card .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
  .card h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .trade { font-size: 12px; color: #64748b; margin: 2px 0 0; }
  .desc { font-size: 13px; color: #334155; margin: 8px 0 0; line-height: 1.4; }
  .desc-en { color: #64748b; font-style: italic; }
  .amount { font-size: 15px; font-weight: 600; white-space: nowrap; }
  .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .badge { display: inline-block; font-size: 11px; padding: 2px 10px; border-radius: 9999px; font-weight: 600; }
  .b-status-signed { background: #dcfce7; color: #166534; }
  .b-status-rejected { background: #fee2e2; color: #991b1b; }
  .b-status-awaiting_signature { background: #fef3c7; color: #92400e; }
  .b-status-in_review { background: #e0f2fe; color: #075985; }
  .b-info { background: #f1f5f9; color: #475569; }
  .b-questions { background: #fef3c7; color: #92400e; }
  .empty { color: #64748b; font-style: italic; padding: 32px; text-align: center; background: #fff; border: 1px dashed #cbd5e1; border-radius: 8px; }
  .preview-banner { background: #fef3c7; color: #92400e; font-size: 13px; font-weight: 600; padding: 8px 24px; border-bottom: 1px solid #fde68a; }
</style>
</head>
<body>
${previewBanner}<header>
  <h1>Client portal — Renosud</h1>
  <div class="meta" id="meta">Loading…</div>
</header>
<main id="root"><div class="empty">Loading…</div></main>
<script>
const DATA_URL = ${JSON.stringify(dataUrl)};
const DETAIL_URL_BASE = ${JSON.stringify(detailUrlBase)};
const DETAIL_URL_SUFFIX = ${JSON.stringify(detailUrlSuffix)};
const STATUS_LABELS = {
  signed: "Signed",
  rejected: "Declined",
  awaiting_signature: "Awaiting signature",
  in_review: "In review",
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function formatAmount(a) {
  const n = parseFloat(a);
  if (!isFinite(n)) return null;
  return new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + " € HT";
}

function renderQuotation(q) {
  const badges = [
    '<span class="badge b-status-' + escapeHtml(q.status) + '" data-testid="badge-status-' + escapeHtml(q.ref) + '">' + (STATUS_LABELS[q.status] || escapeHtml(q.status)) + '</span>',
  ];
  if (q.translationAvailable) badges.push('<span class="badge b-info">English translation available</span>');
  if (q.analysisAvailable) badges.push('<span class="badge b-info">Cost analysis available</span>');
  if (q.openQuestionCount > 0) badges.push('<span class="badge b-questions" data-testid="badge-questions-' + escapeHtml(q.ref) + '">' + q.openQuestionCount + ' open question' + (q.openQuestionCount > 1 ? 's' : '') + '</span>');
  const amount = q.amountHt ? formatAmount(q.amountHt) : null;
  const href = DETAIL_URL_BASE + '/' + encodeURIComponent(q.id) + DETAIL_URL_SUFFIX;
  return '<a class="card" href="' + escapeHtml(href) + '" data-testid="card-quotation-' + escapeHtml(q.ref) + '">'
    + '<div class="top"><div>'
    + '<h3>Devis ' + escapeHtml(q.ref) + '</h3>'
    + (q.trade ? '<p class="trade" data-testid="text-trade-' + escapeHtml(q.ref) + '">' + escapeHtml(q.trade) + '</p>' : '')
    + '</div>'
    + (amount ? '<div class="amount" data-testid="text-amount-' + escapeHtml(q.ref) + '">' + escapeHtml(amount) + '</div>' : '')
    + '</div>'
    + (q.description ? '<p class="desc">' + escapeHtml(q.description) + '</p>' : '')
    + (q.descriptionEn ? '<p class="desc desc-en">' + escapeHtml(q.descriptionEn) + '</p>' : '')
    + '<div class="badges">' + badges.join('') + '</div>'
    + '<div class="open-hint">View details, translation &amp; questions &rarr;</div>'
    + '</a>';
}

async function load() {
  const root = document.getElementById("root");
  const meta = document.getElementById("meta");
  let r;
  try {
    r = await fetch(DATA_URL);
  } catch (_e) {
    root.innerHTML = '<div class="empty">Network error. Please try again.</div>';
    return;
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    root.innerHTML = '<div class="empty">' + escapeHtml(j.message || "Invalid or expired link.") + '</div>';
    return;
  }
  const data = await r.json();
  meta.textContent = data.project ? data.project.name : "";
  const name = data.client && data.client.name ? data.client.name : null;
  const greeting = '<p class="greeting" data-testid="text-greeting">Hello' + (name ? ' ' + escapeHtml(name) : '') + ', here are the quotations shared with you' + (data.project ? ' for ' + escapeHtml(data.project.name) : '') + '.</p>';
  const cards = (data.quotations && data.quotations.length)
    ? data.quotations.map(renderQuotation).join('')
    : '<div class="empty" data-testid="text-no-quotations">No quotations have been shared with you yet.</div>';
  root.innerHTML = greeting + cards;
}

load();
</script>
</body>
</html>`;
}

export default router;
