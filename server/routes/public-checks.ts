import { Router, type Request } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { rateLimit } from "../middleware/rate-limit";
import { hashToken, resolveDevisCheckToken, computeTokenExpiry } from "../services/devis-checks";
import type { DevisCheckToken, Devis, DevisCheck } from "@shared/schema";
import { getDocumentStream } from "../storage/object-storage";

/**
 * Shape returned by both the live (token-authed) and preview (architect-authed)
 * portal data endpoints. Keeping the contract identical lets the shared
 * `renderPortalShell` render either mode without branching its data handling.
 */
export interface PortalDataPayload {
  devis: { ref: string; description: string | null; hasPdf: boolean };
  project: { name: string } | null;
  contractor: { name: string } | null;
  checks: Array<{
    id: number;
    status: string;
    query: string;
    lineDescription: string | null;
    lineNumber: number | null;
    totalHt: string | null;
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
 * Build the portal payload for a devis. Shared by the live token portal and
 * the architect's preview endpoint so both render identical content.
 */
export async function buildPortalPayload(devis: Devis): Promise<PortalDataPayload | null> {
  const project = await storage.getProject(devis.projectId);
  const contractor = await storage.getContractor(devis.contractorId);
  const checks = await storage.listDevisChecks(devis.id);
  const lineItems = await storage.getDevisLineItems(devis.id);
  const lineMap = new Map(lineItems.map((li) => [li.id, li]));

  const enriched = await Promise.all(
    checks
      .filter((c: DevisCheck) => c.status !== "dropped" && c.status !== "resolved")
      .map(async (c: DevisCheck) => {
        const li = c.lineItemId ? lineMap.get(c.lineItemId) ?? null : null;
        return {
          id: c.id,
          status: c.status,
          query: c.query,
          lineDescription: li?.description ?? null,
          lineNumber: li?.lineNumber ?? null,
          totalHt: li?.totalHt ?? null,
          messages: (await storage.listDevisCheckMessages(c.id)).map((m) => ({
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
      hasPdf: !!devis.pdfStorageKey,
    },
    project: project ? { name: project.name } : null,
    contractor: contractor ? { name: contractor.name } : null,
    checks: enriched,
  };
}

const router = Router();

const tokenParams = z.object({ token: z.string().min(20).max(200) });
const replySchema = z.object({
  checkId: z.number().int().positive(),
  body: z.string().min(1).max(5000),
}).strict();

function tokenFromReq(req: Request): string {
  const raw = req.params.token;
  return typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
}

// Two independent buckets per request. We rely on `req.ip` rather than parsing
// `x-forwarded-for` directly: app.set("trust proxy", 1) is configured in
// server/index.ts, so req.ip is the trusted client IP.
const ipKeyer = (req: Request) => `ip:${req.ip || req.socket.remoteAddress || "anon"}`;
// IMPORTANT: never persist raw token material in the limiter bucket key — the
// Postgres-backed bucket store would otherwise leak token prefixes at rest.
// We hash the raw token (same SHA-256 used for storage lookup) and use the
// hash as the limiter key. Anonymous requests get a stable non-secret marker.
const tokenOnlyKeyer = (req: Request) => {
  const raw = tokenFromReq(req);
  return raw ? `tokh:${hashToken(raw)}` : "tokh:anon";
};

const portalReadIpLimiter = rateLimit({
  name: "portal-read-ip",
  windowMs: 60_000,
  max: 240,
  keyer: ipKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});
const portalReadTokenLimiter = rateLimit({
  name: "portal-read-tok",
  windowMs: 60_000,
  max: 60,
  keyer: tokenOnlyKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});
const portalWriteIpLimiter = rateLimit({
  name: "portal-write-ip",
  windowMs: 60_000,
  max: 30,
  keyer: ipKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});
const portalWriteTokenLimiter = rateLimit({
  name: "portal-write-tok",
  windowMs: 60_000,
  max: 10,
  keyer: tokenOnlyKeyer,
  message: "Trop de requêtes. Veuillez réessayer dans une minute.",
});

/**
 * Refresh the sliding expiry whenever the contractor interacts with their
 * link. Keeps active conversations alive while ensuring abandoned links
 * lapse after the configured TTL.
 */
async function touchToken(token: DevisCheckToken): Promise<void> {
  await storage.touchDevisCheckTokenUsed(token.id, computeTokenExpiry());
}

/** HTML shell — vanilla JS, French labels, draggable PDF iframe. */
router.get("/p/check/:token", portalReadIpLimiter, portalReadTokenLimiter, validateRequest({ params: tokenParams }), async (req, res) => {
  const lookup = await resolveDevisCheckToken(tokenFromReq(req));
  if (!lookup.ok) {
    if (lookup.reason === "expired") {
      res.status(410).type("html").send(renderExpired());
    } else {
      res.status(404).type("html").send(renderInvalid());
    }
    return;
  }
  res.type("html").send(renderPortalShell({ mode: "live", token: tokenFromReq(req) }));
});

/** JSON state for the portal (devis ref + checks + messages). */
router.get(
  "/p/check/:token/data",
  portalReadIpLimiter, portalReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveDevisCheckToken(tokenFromReq(req));
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
    // Override the contractor lookup to use the token's contractorId, which
    // may differ from devis.contractorId if the contractor was rotated after
    // the token was issued. The token is the source of truth for the live
    // portal session.
    const payload = await buildPortalPayload(devis);
    if (!payload) return res.status(404).json({ message: "Devis introuvable" });
    const tokenContractor = await storage.getContractor(t.contractorId);
    if (tokenContractor) payload.contractor = { name: tokenContractor.name };
    res.json(payload);
  },
);

/** Contractor posts a reply on a specific check thread. */
router.post(
  "/p/check/:token/messages",
  portalWriteIpLimiter, portalWriteTokenLimiter,
  validateRequest({ params: tokenParams, body: replySchema }),
  async (req, res) => {
    const lookup = await resolveDevisCheckToken(tokenFromReq(req));
    if (!lookup.ok) {
      const status = lookup.reason === "expired" ? 410 : 404;
      const message = lookup.reason === "expired"
        ? "Lien expiré. Veuillez contacter votre interlocuteur Renosud."
        : "Lien invalide ou expiré";
      return res.status(status).json({ message, expired: lookup.reason === "expired" });
    }
    const t = lookup.token;
    const check = await storage.getDevisCheck(req.body.checkId);
    if (!check || check.devisId !== t.devisId) {
      return res.status(404).json({ message: "Question introuvable" });
    }
    if (check.status === "resolved" || check.status === "dropped") {
      return res.status(409).json({ message: "Cette question est clôturée" });
    }
    const contractor = await storage.getContractor(t.contractorId);
    const msg = await storage.createDevisCheckMessage({
      checkId: check.id,
      authorType: "contractor",
      authorEmail: t.contractorEmail,
      authorName: contractor?.name ?? null,
      body: req.body.body,
      channel: "portal",
    });
    await storage.updateDevisCheck(check.id, { status: "awaiting_architect" });
    await touchToken(t);
    res.status(201).json({ id: msg.id });
  },
);

/** Stream the devis PDF inline so the contractor can view it in the portal. */
router.get(
  "/p/check/:token/pdf",
  portalReadIpLimiter, portalReadTokenLimiter,
  validateRequest({ params: tokenParams }),
  async (req, res) => {
    const lookup = await resolveDevisCheckToken(tokenFromReq(req));
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
      doc.stream.pipe(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lecture PDF";
      res.status(500).json({ message: msg });
    }
  },
);

function renderInvalid(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Lien invalide</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1f2937}</style>
</head><body data-testid="page-invalid"><h1>Lien invalide</h1>
<p>Ce lien n'est plus valable. Merci de contacter votre interlocuteur Renosud pour obtenir un nouveau lien.</p>
</body></html>`;
}

function renderExpired(): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Lien expiré</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#0f172a;line-height:1.5}
h1{font-size:22px;margin:0 0 12px;color:#b45309}
.note{background:#fef3c7;border-left:3px solid #f59e0b;padding:12px 16px;border-radius:4px;margin:16px 0}
p{margin:8px 0}
</style>
</head><body data-testid="page-expired">
<h1>Lien expiré</h1>
<div class="note">Ce lien d'accès au portail des questions a expiré pour des raisons de sécurité.</div>
<p>Pour reprendre la conversation sur ce devis, merci de contacter votre interlocuteur Renosud (l'architecte qui vous a transmis ce lien). Il pourra vous générer un nouveau lien d'accès.</p>
<p>Vos réponses précédentes sont conservées et restent accessibles à l'équipe Renosud.</p>
</body></html>`;
}

/**
 * Render the portal HTML shell. Two modes share the same template:
 *   • live: token-authed contractor portal (writes enabled).
 *   • preview: architect-authed read-only preview, served inside an iframe in
 *     the architect UI. Reply forms are suppressed and a banner identifies it
 *     as a preview so an architect can never confuse it with the real link.
 */
export function renderPortalShell(opts:
  | { mode: "live"; token: string }
  | { mode: "preview"; devisId: number }
): string {
  const isPreview = opts.mode === "preview";
  const dataUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/checks/portal-preview/data`
    : `/p/check/${encodeURIComponent(opts.token)}/data`;
  const pdfUrl = opts.mode === "preview"
    ? `/api/devis/${opts.devisId}/checks/portal-preview/pdf`
    : `/p/check/${encodeURIComponent(opts.token)}/pdf`;
  const messagesUrl = opts.mode === "preview"
    ? null
    : `/p/check/${encodeURIComponent(opts.token)}/messages`;
  // Inline single-page app — vanilla JS, no build step, French only.
  // The PDF viewer is a draggable, resizable floating panel; defaults to
  // bottom-right and can be toggled with a button.
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${isPreview ? "Aperçu architecte — " : ""}Espace contractant — Renosud</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f8fafc; color: #0f172a; }
  .preview-banner { background: #fef3c7; color: #78350f; border-bottom: 2px solid #f59e0b; padding: 8px 16px; font-size: 12px; font-weight: 600; text-align: center; letter-spacing: 0.02em; }
  header { background: #0f172a; color: #fff; padding: 16px 24px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .meta { font-size: 13px; opacity: 0.8; margin-top: 4px; }
  main { max-width: 880px; margin: 0 auto; padding: 24px; padding-bottom: 80px; }
  .check { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 16px; padding: 16px; }
  .check h3 { margin: 0 0 8px; font-size: 14px; color: #475569; font-weight: 600; }
  .line-badge { display: inline-block; background: #eef2ff; color: #3730a3; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 9999px; margin-right: 4px; }
  .line-amount { color: #64748b; font-weight: 500; font-size: 12px; margin-left: 4px; }
  .query { background: #fef3c7; border-left: 3px solid #f59e0b; padding: 8px 12px; margin: 0 0 12px; font-size: 14px; }
  .status { display: inline-block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 9999px; margin-left: 8px; }
  .status-open, .status-awaiting_contractor { background: #fee2e2; color: #991b1b; }
  .status-awaiting_architect { background: #dbeafe; color: #1e40af; }
  .status-resolved { background: #dcfce7; color: #166534; }
  .messages { margin: 12px 0; }
  .msg { padding: 8px 12px; margin: 6px 0; border-radius: 6px; font-size: 14px; line-height: 1.4; white-space: pre-wrap; }
  .msg-architect { background: #f1f5f9; }
  .msg-contractor { background: #ecfdf5; }
  .msg-meta { font-size: 11px; color: #64748b; margin-bottom: 2px; }
  textarea { width: 100%; min-height: 70px; box-sizing: border-box; border: 1px solid #cbd5e1; border-radius: 4px; padding: 8px; font: inherit; resize: vertical; }
  button { background: #0f172a; color: #fff; border: 0; border-radius: 4px; padding: 8px 14px; font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .pdf-toggle { position: fixed; bottom: 20px; right: 20px; z-index: 9; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .pdf-panel { position: fixed; bottom: 80px; right: 20px; width: 480px; height: 640px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 12px 32px rgba(0,0,0,0.2); display: none; flex-direction: column; z-index: 10; }
  .pdf-panel.open { display: flex; }
  .pdf-handle { padding: 8px 12px; background: #0f172a; color: #fff; cursor: move; user-select: none; border-radius: 8px 8px 0 0; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .pdf-handle button { background: transparent; padding: 2px 8px; }
  .pdf-panel iframe { flex: 1; border: 0; border-radius: 0 0 8px 8px; }
  .pdf-resize { position: absolute; bottom: 2px; right: 2px; width: 14px; height: 14px; cursor: nwse-resize; opacity: 0.5; }
  .empty { color: #64748b; font-style: italic; padding: 24px; text-align: center; }
  .err { color: #b91c1c; font-size: 13px; margin-top: 6px; }
</style>
</head>
<body${isPreview ? ` data-preview="1"` : ""}>
${isPreview ? `<div class="preview-banner" data-testid="banner-preview">Aperçu architecte — les réponses ne seront pas envoyées.</div>` : ""}
<header>
  <h1>Espace contractant — Renosud</h1>
  <div class="meta" id="meta">Chargement…</div>
</header>
<main id="root"><div class="empty">Chargement…</div></main>

<button class="pdf-toggle" id="pdfToggle" type="button" data-testid="button-pdf-toggle">Voir le devis (PDF)</button>
<div class="pdf-panel" id="pdfPanel">
  <div class="pdf-handle" id="pdfHandle">
    <span>Devis — PDF</span>
    <button id="pdfClose" type="button" aria-label="Fermer">×</button>
  </div>
  <iframe id="pdfFrame" title="Devis PDF" src="about:blank"></iframe>
  <div class="pdf-resize" id="pdfResize"></div>
</div>

<script>
const DATA_URL = ${JSON.stringify(dataUrl)};
const PDF_URL = ${JSON.stringify(pdfUrl)};
const MESSAGES_URL = ${messagesUrl === null ? "null" : JSON.stringify(messagesUrl)};
const PREVIEW_MODE = ${isPreview ? "true" : "false"};
const STATUS_LABELS = {
  open: "Ouvert",
  awaiting_contractor: "À votre tour",
  awaiting_architect: "En cours de revue",
  resolved: "Clôturé",
};

async function loadData() {
  const r = await fetch(DATA_URL);
  if (r.status === 410) {
    const j = await r.json().catch(() => ({}));
    document.getElementById("root").innerHTML =
      '<div class="empty" data-testid="text-expired">' +
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
  meta.textContent = (data.project?.name || "") + " — devis " + (data.devis?.ref || "");
  const root = document.getElementById("root");
  if (!data.checks.length) {
    root.innerHTML = '<div class="empty">Aucune question en cours.</div>';
    return;
  }
  root.innerHTML = data.checks.map((c) => {
    // Cross-reference each question to the actual devis line position + HT
    // amount so the contractor can locate it on their devis PDF (Task #110).
    let head;
    if (c.lineNumber != null && c.lineDescription) {
      const amount = (c.totalHt != null && Number.isFinite(Number(c.totalHt)))
        ? new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(c.totalHt))
        : null;
      const badge = '<span class="line-badge" data-testid="badge-line-' + c.id + '">Ligne ' + c.lineNumber + '</span>';
      const amountTail = amount ? ' <span class="line-amount">(' + escapeHtml(amount) + ' \u20AC HT)</span>' : '';
      head = badge + ' ' + escapeHtml(c.lineDescription) + amountTail;
    } else {
      // No authoritative line number → treat as a general question. We
      // intentionally do NOT render "Ligne : description" without a number,
      // because the line number IS the cross-reference contractors use to
      // locate the question on their devis PDF (Task #110 semantics, kept
      // consistent with the email body formatter formatCheckHead).
      head = "Question générale";
    }
    const msgs = c.messages.map((m) => {
      const author = m.authorType === "contractor" ? (m.authorName || "Vous") : "Renosud";
      return '<div class="msg msg-' + m.authorType + '"><div class="msg-meta">' + escapeHtml(author) + '</div>' + escapeHtml(m.body) + '</div>';
    }).join("");
    const canReply = c.status !== "resolved" && !PREVIEW_MODE;
    const replyForm = canReply
      ? '<form data-check="' + c.id + '"><textarea required maxlength="5000" data-testid="textarea-reply-' + c.id + '" placeholder="Votre réponse…"></textarea><div style="margin-top:8px;display:flex;gap:8px;align-items:center;"><button type="submit" data-testid="button-send-reply-' + c.id + '">Envoyer</button><span class="err" data-err="' + c.id + '"></span></div></form>'
      : (PREVIEW_MODE && c.status !== "resolved"
        ? '<div style="margin-top:8px"><textarea disabled placeholder="Aperçu architecte — réponse désactivée" data-testid="textarea-reply-disabled-' + c.id + '"></textarea><div style="margin-top:8px"><button type="button" disabled data-testid="button-send-reply-disabled-' + c.id + '">Envoyer</button></div></div>'
        : '');
    return '<section class="check" data-testid="check-' + c.id + '"><h3>' + head + '<span class="status status-' + c.status + '">' + (STATUS_LABELS[c.status] || c.status) + '</span></h3>'
      + '<p class="query">' + escapeHtml(c.query) + '</p>'
      + '<div class="messages">' + msgs + '</div>' + replyForm + '</section>';
  }).join("");

  root.querySelectorAll("form[data-check]").forEach((f) => {
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const checkId = Number(f.getAttribute("data-check"));
      const ta = f.querySelector("textarea");
      const btn = f.querySelector("button");
      const errEl = f.querySelector("[data-err]");
      errEl.textContent = "";
      btn.disabled = true;
      try {
        if (!MESSAGES_URL) throw new Error("Aperçu — envoi désactivé");
        const r = await fetch(MESSAGES_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ checkId, body: ta.value }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.message || "Échec de l'envoi");
        }
        ta.value = "";
        const next = await loadData();
        if (next) render(next);
      } catch (e) {
        errEl.textContent = e.message || "Erreur";
      } finally {
        btn.disabled = false;
      }
    });
  });
}

loadData().then((d) => { if (d) render(d); });

// Floating PDF panel — toggle, drag, resize.
const panel = document.getElementById("pdfPanel");
const frame = document.getElementById("pdfFrame");
const toggle = document.getElementById("pdfToggle");
const closeBtn = document.getElementById("pdfClose");
const handle = document.getElementById("pdfHandle");
const resize = document.getElementById("pdfResize");

toggle.addEventListener("click", () => {
  panel.classList.toggle("open");
  if (panel.classList.contains("open") && frame.src === "about:blank") {
    frame.src = PDF_URL;
  }
});
closeBtn.addEventListener("click", () => panel.classList.remove("open"));

let dragging = false, dragOffset = { x: 0, y: 0 };
handle.addEventListener("mousedown", (e) => {
  if (e.target.tagName === "BUTTON") return;
  dragging = true;
  const rect = panel.getBoundingClientRect();
  dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  panel.style.left = (e.clientX - dragOffset.x) + "px";
  panel.style.top = (e.clientY - dragOffset.y) + "px";
});
window.addEventListener("mouseup", () => { dragging = false; });

let resizing = false, startSize = { w: 0, h: 0 }, startPos = { x: 0, y: 0 };
resize.addEventListener("mousedown", (e) => {
  resizing = true;
  startSize = { w: panel.offsetWidth, h: panel.offsetHeight };
  startPos = { x: e.clientX, y: e.clientY };
  e.preventDefault();
  e.stopPropagation();
});
window.addEventListener("mousemove", (e) => {
  if (!resizing) return;
  panel.style.width = Math.max(280, startSize.w + (e.clientX - startPos.x)) + "px";
  panel.style.height = Math.max(240, startSize.h + (e.clientY - startPos.y)) + "px";
});
window.addEventListener("mouseup", () => { resizing = false; });
</script>
</body>
</html>`;
}

export default router;
