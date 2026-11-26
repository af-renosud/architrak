import { createHash } from "node:crypto";
import type pg from "pg";
import { pool } from "../db";
import { WorksheetError, worksheetService, type WorksheetDetail } from "./quotation-worksheet";
import {
  CommunicationDeliveryAwaitingConfirmationError, CommunicationSendInProgressError, isValidRecipientEmail, sendCommunication,
} from "../communications/email-sender";
import {
  buildRevisionRequestEmail, buildSharedWorksheetPayload, compareWithRevisedQuotation, revisionRequestInputSchema,
  revisionRequestSendSchema, worksheetCommentSchema, worksheetRevisionChanges,
  type RevisedQuotationLine, type SharedWorksheetPayload,
} from "../../shared/worksheet-agreement";
import { computeWorksheet, type WorksheetLineData } from "../../shared/quotation-worksheet";

/**
 * Agreed client worksheets:
 *  - sealed English client copies on the project's client link (+ comments);
 *  - French revision requests to the contractor via project_communications;
 *  - comparison of a revised quotation with the agreed worksheet.
 */

type Client = pg.PoolClient | pg.Pool;
const iso = (v: any) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const actorSql = "COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),u.email)";
/** Same render-time rule as published quotations (void/provisional/superseded never shown). */
const VISIBLE_DEVIS_SQL = `d.sign_off_stage <> 'void' AND d.status NOT IN ('void','cancelled','superseded')
  AND d.accounting_state NOT IN ('provisional','superseded')`;
export const REVISION_REQUEST_PREFIX = "worksheet-revision-request:";

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: Array<{ message: string }> } } }, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new WorksheetError(r.error.issues[0]?.message ?? "Invalid request.", 400);
  return r.data;
}

export interface SharedWorksheetRelease {
  id: number; worksheetRevision: number; sealedAt: string; sealedBy: string | null;
  withdrawnAt: string | null; withdrawnBy: string | null; current: boolean; revisedTtcCents: number;
  comments: Array<{ id: number; body: string; authorName: string | null; authorEmail: string; createdAt: string; acknowledgedAt: string | null }>;
}

export function createWorksheetAgreementService(deps: {
  pool: pg.Pool;
  send?: (id: number, opts: { sentByUserId: number | null }) => Promise<void>;
}) {
  const send = deps.send ?? ((id, opts) => sendCommunication(id, opts));
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>) {
    const c = await deps.pool.connect();
    try { await c.query("BEGIN"); const v = await fn(c); await c.query("COMMIT"); return v; }
    catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  }
  async function auditWorksheet(c: pg.PoolClient, w: { id: number; devis_id: number }, actorId: number, action: string, after: unknown) {
    await c.query(`INSERT INTO quotation_worksheet_audit(worksheet_id,devis_id,actor_user_id,action,after) VALUES($1,$2,$3,$4,$5)`,
      [w.id, w.devis_id, actorId, action, JSON.stringify(after)]);
  }
  /** Locks the worksheet against edits (edits take FOR UPDATE) and checks the agreed version. */
  async function lockAgreedVersion(c: pg.PoolClient, worksheetId: number, expectedRevision: number) {
    const w = (await c.query("SELECT * FROM quotation_worksheets WHERE id=$1 FOR SHARE", [worksheetId])).rows[0];
    if (!w) throw new WorksheetError("Worksheet not found.", 404);
    const d = (await c.query(`SELECT d.*, p.archived_at, p.name AS project_name, (${VISIBLE_DEVIS_SQL}) AS visible
      FROM devis d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 FOR SHARE OF d, p`, [w.devis_id])).rows[0];
    if (!d) throw new WorksheetError("Quotation not found.", 404);
    if (d.archived_at) throw new WorksheetError("Archived projects are read-only.");
    if (!d.visible) throw new WorksheetError("This quotation is void, provisional or superseded, so this worksheet can no longer be used for agreement.");
    if (w.revision !== expectedRevision) throw new WorksheetError("This worksheet changed after you opened it. Review the latest figures, then try again.");
    return { w, d };
  }
  async function englishWording(c: Client, devisId: number) {
    const t = (await c.query("SELECT status, line_translations FROM devis_translations WHERE devis_id=$1", [devisId])).rows[0];
    const map = new Map<number, string>();
    // Portal rule: only a FINALISED translation is client content.
    if (!t || t.status !== "finalised" || !Array.isArray(t.line_translations)) return map;
    const byNumber = new Map<number, string>();
    for (const entry of t.line_translations) {
      if (typeof entry?.lineNumber === "number" && typeof entry?.translation === "string" && entry.translation.trim()) byNumber.set(entry.lineNumber, entry.translation);
    }
    const lines = (await c.query("SELECT id, line_number FROM devis_line_items WHERE devis_id=$1", [devisId])).rows;
    for (const l of lines) { const en = byNumber.get(l.line_number); if (en) map.set(l.id, en); }
    return map;
  }
  /** Contractor lines on the worksheet that have no approved (finalised) English wording. */
  async function englishGap(c: Client, devisId: number, lines: WorksheetLineData[], english: Map<number, string>) {
    const status = (await c.query("SELECT status FROM devis_translations WHERE devis_id=$1", [devisId])).rows[0]?.status ?? null;
    const missing = lines.filter(l => l.sourceLineItemId != null && !english.get(l.sourceLineItemId)?.trim()).length;
    if (status !== "finalised") return { missing, reason: "The client sees agreed changes in English. Finalise this quotation's English translation, then share the worksheet." };
    if (missing > 0) return { missing, reason: `${missing} line${missing > 1 ? "s have" : " has"} no approved English wording. Complete and finalise the translation, then share the worksheet.` };
    return { missing: 0, reason: null as string | null };
  }
  async function withdrawOpen(c: pg.PoolClient, w: { id: number; devis_id: number; project_id: number; title: string }, devisCode: string, actorId: number, exceptId: number | null, why: string) {
    const rows = (await c.query(`UPDATE client_worksheet_releases SET withdrawn_at=now(), withdrawn_by_user_id=$2
      WHERE worksheet_id=$1 AND withdrawn_at IS NULL AND ($3::int IS NULL OR id<>$3) RETURNING id, worksheet_revision`, [w.id, actorId, exceptId])).rows;
    for (const r of rows) {
      await auditWorksheet(c, w, actorId, "withdraw_client", { releaseId: r.id, revision: r.worksheet_revision, why });
      await c.query(`INSERT INTO client_project_share_audit(project_id,devis_id,action,actor_user_id,detail) VALUES($1,$2,'worksheet_withdraw',$3,$4)`,
        [w.project_id, w.devis_id, actorId, `Copie client n°${r.id} de la feuille de travail « ${w.title} » (devis ${devisCode}) retirée du lien client (${why}).`]);
    }
    return rows.length;
  }
  function sharedPayload(detail: WorksheetDetail, english: Map<number, string>): SharedWorksheetPayload {
    return buildSharedWorksheetPayload({
      title: detail.worksheet.title, meetingDate: detail.worksheet.meetingDate, depositPercent: detail.worksheet.depositPercent,
      projectName: detail.quotation.projectName,
      quotation: { ref: detail.quotation.code, documentRef: detail.quotation.number, contractorName: detail.quotation.contractorName, date: detail.quotation.date },
      lines: detail.lines, english,
    });
  }

  // ── Client sharing ──────────────────────────────────────────────────────

  async function share(worksheetId: number, input: unknown, actorId: number) {
    const expectedRevision = Number((input as any)?.expectedRevision);
    if (!Number.isInteger(expectedRevision) || expectedRevision <= 0) throw new WorksheetError("Reload the worksheet and try again.", 400);
    return tx(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`worksheet-client-share:${worksheetId}`]);
      const { w, d } = await lockAgreedVersion(c, worksheetId, expectedRevision);
      const token = (await c.query(`SELECT id FROM client_project_share_tokens WHERE project_id=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now()) ORDER BY id DESC LIMIT 1 FOR SHARE`, [w.project_id])).rows[0];
      if (!token) throw new WorksheetError("This project has no active client link. Create it from Manage client link, then share the worksheet.");
      const existing = (await c.query(`SELECT id FROM client_worksheet_releases WHERE worksheet_id=$1 AND worksheet_revision=$2
        AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1`, [worksheetId, w.revision])).rows[0];
      const latest = (await c.query(`SELECT id FROM client_worksheet_releases WHERE worksheet_id=$1 AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1`, [worksheetId])).rows[0];
      if (existing && latest?.id === existing.id) return { releaseId: existing.id as number, unchanged: true };
      const detail = await worksheetService().get(worksheetId, c);
      const english = await englishWording(c, w.devis_id);
      const gap = await englishGap(c, w.devis_id, detail.lines, english);
      if (gap.reason) throw new WorksheetError(gap.reason);
      const payload = sharedPayload(detail, english);
      const json = JSON.stringify(payload);
      const sha = createHash("sha256").update(json).digest("hex");
      const release = (await c.query(`INSERT INTO client_worksheet_releases(project_id,devis_id,worksheet_id,worksheet_revision,payload,payload_sha256,sealed_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [w.project_id, w.devis_id, w.id, w.revision, json, sha, actorId])).rows[0];
      // Only one version is ever published: the new copy replaces any earlier one.
      await withdrawOpen(c, w, d.devis_code, actorId, release.id, `remplacée par la copie n°${release.id}`);
      await auditWorksheet(c, w, actorId, "share_client", { releaseId: release.id, revision: w.revision });
      await c.query(`INSERT INTO client_project_share_audit(project_id,token_id,devis_id,action,actor_user_id,detail) VALUES($1,$2,$3,'worksheet_share',$4,$5)`,
        [w.project_id, token.id, w.devis_id, actorId,
          `Feuille de travail « ${w.title} » du devis ${d.devis_code} (version ${w.revision}) partagée avec le client — copie scellée n°${release.id} (SHA-256 ${sha}).`]);
      return { releaseId: release.id as number, unchanged: false };
    });
  }

  /** Stop sharing: withdraws every published copy of this worksheet, so no older version resurfaces. */
  async function withdraw(worksheetId: number, releaseId: number, actorId: number) {
    return tx(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`worksheet-client-share:${worksheetId}`]);
      const r = (await c.query(`SELECT r.id, w.id AS wid, w.devis_id, w.project_id, w.title, d.devis_code FROM client_worksheet_releases r
        JOIN quotation_worksheets w ON w.id=r.worksheet_id JOIN devis d ON d.id=r.devis_id WHERE r.id=$1 AND r.worksheet_id=$2`, [releaseId, worksheetId])).rows[0];
      if (!r) throw new WorksheetError("Shared copy not found.", 404);
      const withdrawn = await withdrawOpen(c, { id: r.wid, devis_id: r.devis_id, project_id: r.project_id, title: r.title }, r.devis_code, actorId, null, "partage arrêté");
      return { worksheetId, withdrawn };
    });
  }

  async function shareState(worksheetId: number) {
    const w = (await deps.pool.query("SELECT id, project_id, revision FROM quotation_worksheets WHERE id=$1", [worksheetId])).rows[0];
    if (!w) throw new WorksheetError("Worksheet not found.", 404);
    const link = (await deps.pool.query(`SELECT id FROM client_project_share_tokens WHERE project_id=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`, [w.project_id])).rows[0];
    const rows = (await deps.pool.query(`SELECT r.id, r.worksheet_revision, r.sealed_at, r.withdrawn_at, r.payload->'revised'->>'ttcCents' AS ttc,
        ${actorSql} AS sealed_by, (SELECT ${actorSql.replace(/u\./g, "u2.")} FROM users u2 WHERE u2.id=r.withdrawn_by_user_id) AS withdrawn_by
      FROM client_worksheet_releases r LEFT JOIN users u ON u.id=r.sealed_by_user_id WHERE r.worksheet_id=$1 ORDER BY r.id DESC`, [worksheetId])).rows;
    const comments = rows.length ? (await deps.pool.query(`SELECT * FROM client_worksheet_comments WHERE release_id = ANY($1::int[]) ORDER BY id`,
      [rows.map(r => r.id)])).rows : [];
    const currentId = rows.find(r => !r.withdrawn_at)?.id ?? null;
    const releases: SharedWorksheetRelease[] = rows.map(r => ({
      id: r.id, worksheetRevision: r.worksheet_revision, sealedAt: iso(r.sealed_at)!, sealedBy: r.sealed_by ?? null,
      withdrawnAt: iso(r.withdrawn_at), withdrawnBy: r.withdrawn_by ?? null, current: r.id === currentId, revisedTtcCents: Number(r.ttc ?? 0),
      comments: comments.filter(cm => cm.release_id === r.id).map(cm => ({ id: cm.id, body: cm.body, authorName: cm.author_name,
        authorEmail: cm.author_email, createdAt: iso(cm.created_at)!, acknowledgedAt: iso(cm.acknowledged_at) })),
    }));
    const detail = await worksheetService().get(worksheetId, deps.pool);
    const gap = await englishGap(deps.pool, detail.quotation.id, detail.lines, await englishWording(deps.pool, detail.quotation.id));
    return {
      worksheetRevision: w.revision as number, hasActiveLink: !!link, releases, englishBlocker: gap.reason,
      unreadComments: releases.reduce((n, r) => n + r.comments.filter(cm => !cm.acknowledgedAt).length, 0),
    };
  }

  async function acknowledgeComments(worksheetId: number, releaseId: number, actorId: number) {
    const r = (await deps.pool.query(`UPDATE client_worksheet_comments c SET acknowledged_at=now(), acknowledged_by_user_id=$3
      FROM client_worksheet_releases r WHERE r.id=c.release_id AND c.release_id=$1 AND r.worksheet_id=$2 AND c.acknowledged_at IS NULL
      RETURNING c.id`, [releaseId, worksheetId, actorId])).rows;
    return { acknowledged: r.length };
  }

  /** Per-quotation counts for the worksheet list on the quotation card. */
  async function devisSummary(devisId: number) {
    const rows = (await deps.pool.query(`SELECT w.id,
        (SELECT r.worksheet_revision FROM client_worksheet_releases r WHERE r.worksheet_id=w.id AND r.withdrawn_at IS NULL ORDER BY r.id DESC LIMIT 1) AS shared_revision,
        (SELECT count(*)::int FROM client_worksheet_comments c JOIN client_worksheet_releases r ON r.id=c.release_id WHERE r.worksheet_id=w.id AND c.acknowledged_at IS NULL) AS unread,
        (SELECT q.created_at FROM worksheet_revision_requests q WHERE q.worksheet_id=w.id ORDER BY q.id DESC LIMIT 1) AS last_request
      FROM quotation_worksheets w WHERE w.devis_id=$1`, [devisId])).rows;
    return Object.fromEntries(rows.map(r => [r.id, { sharedRevision: r.shared_revision ?? null, unreadComments: r.unread, lastRevisionRequestAt: iso(r.last_request) }]));
  }

  // ── Public (client link) ───────────────────────────────────────────────

  async function visibleForProject(projectId: number) {
    const rows = (await deps.pool.query(`SELECT DISTINCT ON (r.worksheet_id) r.id, r.sealed_at, r.payload, r.worksheet_id,
        (SELECT count(*)::int FROM client_worksheet_comments c WHERE c.release_id=r.id) AS comments
      FROM client_worksheet_releases r JOIN devis d ON d.id=r.devis_id
      WHERE r.project_id=$1 AND r.withdrawn_at IS NULL AND ${VISIBLE_DEVIS_SQL}
      ORDER BY r.worksheet_id, r.id DESC`, [projectId])).rows;
    return rows.map(r => {
      const p = r.payload as SharedWorksheetPayload;
      return { releaseId: r.id as number, title: p.title, quotationRef: p.quotation.documentRef ?? p.quotation.ref, contractorName: p.quotation.contractorName,
        meetingDate: p.meetingDate, sealedAt: iso(r.sealed_at)!, originalTtcCents: p.original.ttcCents, revisedTtcCents: p.revised.ttcCents,
        commentCount: r.comments as number };
    }).sort((a, b) => b.releaseId - a.releaseId);
  }

  async function publicRelease(projectId: number, releaseId: number) {
    const r = (await deps.pool.query(`SELECT r.*, EXISTS (SELECT 1 FROM client_worksheet_releases n WHERE n.worksheet_id=r.worksheet_id
        AND n.id > r.id AND n.withdrawn_at IS NULL) AS superseded
      FROM client_worksheet_releases r JOIN devis d ON d.id=r.devis_id
      WHERE r.id=$1 AND r.project_id=$2 AND r.withdrawn_at IS NULL AND ${VISIBLE_DEVIS_SQL}`, [releaseId, projectId])).rows[0];
    if (!r) return null;
    const comments = (await deps.pool.query(`SELECT id, body, author_name, created_at FROM client_worksheet_comments WHERE release_id=$1 ORDER BY id`, [releaseId])).rows;
    return {
      releaseId: r.id as number, sealedAt: iso(r.sealed_at)!, superseded: r.superseded === true, worksheet: r.payload as SharedWorksheetPayload,
      comments: comments.map(cm => ({ id: cm.id, body: cm.body, authorName: cm.author_name, createdAt: iso(cm.created_at)! })),
    };
  }

  async function addClientComment(token: { id: number; projectId: number; clientEmail: string; clientName: string | null }, releaseId: number, input: unknown) {
    const body = parse(worksheetCommentSchema, input);
    return tx(async c => {
      const r = (await c.query(`SELECT r.id FROM client_worksheet_releases r JOIN devis d ON d.id=r.devis_id
        WHERE r.id=$1 AND r.project_id=$2 AND r.withdrawn_at IS NULL AND ${VISIBLE_DEVIS_SQL} FOR SHARE OF r`, [releaseId, token.projectId])).rows[0];
      if (!r) throw new WorksheetError("This worksheet is no longer shared.", 404);
      const row = (await c.query(`INSERT INTO client_worksheet_comments(release_id,project_id,token_id,author_email,author_name,body)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id, body, author_name, created_at`, [releaseId, token.projectId, token.id, token.clientEmail, token.clientName, body.body])).rows[0];
      return { id: row.id as number, body: row.body as string, authorName: row.author_name as string | null, createdAt: iso(row.created_at)! };
    });
  }

  // ── Contractor revision request ────────────────────────────────────────

  async function requestContext(c: Client, detail: WorksheetDetail) {
    const k = (await c.query(`SELECT k.name, k.email, k.contact_name FROM devis d JOIN contractors k ON k.id=d.contractor_id WHERE d.id=$1`, [detail.quotation.id])).rows[0];
    const changes = worksheetRevisionChanges(detail.lines);
    const email = (k?.email ?? "").trim();
    const reason = detail.readOnlyReason
      ?? (!changes.length ? "Nothing to request: the worksheet has no added, removed or changed lines." : null)
      ?? (!isValidRecipientEmail(email) ? `${k?.name ?? "The contractor"} has no valid email address. Add it on the contractor record, then try again.` : null);
    return { contractorName: (k?.name as string) ?? "", contactName: (k?.contact_name as string | null) ?? null, email, changes, reason };
  }
  function emailFor(detail: WorksheetDetail, ctx: Awaited<ReturnType<typeof requestContext>>, opts: { message?: string | null; includeNotes?: boolean }, requestId?: string) {
    return buildRevisionRequestEmail({
      projectName: detail.quotation.projectName, quotationRef: detail.quotation.code, documentRef: detail.quotation.number,
      contactName: ctx.contactName, meetingDate: detail.worksheet.meetingDate, changes: ctx.changes,
      originalHtCents: detail.computed.original.htCents, revisedHtCents: detail.computed.revised.htCents,
      message: opts.message, includeNotes: opts.includeNotes, requestId,
    });
  }

  async function previewRevisionRequest(worksheetId: number, input: unknown) {
    const opts = parse(revisionRequestInputSchema, input ?? {});
    const detail = await worksheetService().get(worksheetId, deps.pool);
    const ctx = await requestContext(deps.pool, detail);
    const email = emailFor(detail, ctx, opts);
    return { worksheetRevision: detail.worksheet.revision, contractorName: ctx.contractorName, recipientEmail: ctx.email || null,
      changes: ctx.changes, subject: email.subject, body: email.body, canSend: !ctx.reason, reason: ctx.reason };
  }

  async function dispatch(communicationId: number, actorId: number) {
    try {
      await send(communicationId, { sentByUserId: actorId });
      return { status: "sent" as const, message: null };
    } catch (error) {
      if (error instanceof CommunicationDeliveryAwaitingConfirmationError || error instanceof CommunicationSendInProgressError)
        return { status: "sending" as const, message: "Delivery confirmation is pending. Do not send another copy." };
      console.error(`[WorksheetRevision] send failed for communication ${communicationId}:`, error instanceof Error ? error.message : error);
      return { status: "failed" as const, message: "The email was not confirmed as sent. The request is saved; retry it from the worksheet." };
    }
  }

  async function sendRevisionRequest(worksheetId: number, input: unknown, actorId: number) {
    const body = parse(revisionRequestSendSchema, input);
    const created = await tx(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${REVISION_REQUEST_PREFIX}${worksheetId}`]);
      const prior = (await c.query(`SELECT q.id, q.worksheet_id, q.communication_id, pc.status FROM worksheet_revision_requests q
        LEFT JOIN project_communications pc ON pc.id=q.communication_id WHERE q.request_id=$1`, [body.requestId])).rows[0];
      if (prior) {
        if (prior.worksheet_id !== worksheetId) throw new WorksheetError("Request identifier already used.", 409);
        return { requestId: prior.id as number, communicationId: prior.communication_id as number | null, status: prior.status as string | null, replay: true };
      }
      const { w, d } = await lockAgreedVersion(c, worksheetId, body.expectedRevision);
      const inFlight = (await c.query(`SELECT 1 FROM worksheet_revision_requests q JOIN project_communications pc ON pc.id=q.communication_id
        WHERE q.worksheet_id=$1 AND pc.status IN ('queued','sending') LIMIT 1`, [worksheetId])).rows[0];
      if (inFlight) throw new WorksheetError("A revision request for this worksheet is still being sent. Wait for it to finish before sending another.");
      const detail = await worksheetService().get(worksheetId, c);
      const ctx = await requestContext(c, detail);
      if (ctx.reason) throw new WorksheetError(ctx.reason, 422);
      const email = emailFor(detail, ctx, body, body.requestId);
      const comm = (await c.query(`INSERT INTO project_communications(project_id,type,recipient_type,recipient_email,recipient_name,subject,body,related_devis_id,dedupe_key,status)
        VALUES($1,'devis_revision_request','contractor',$2,$3,$4,$5,$6,$7,'queued') RETURNING id, status`,
        [w.project_id, ctx.email, ctx.contractorName, email.subject, email.body, d.id, `${REVISION_REQUEST_PREFIX}${worksheetId}:${body.requestId}`])).rows[0];
      const request = (await c.query(`INSERT INTO worksheet_revision_requests(project_id,devis_id,worksheet_id,worksheet_revision,request_id,changes,agreed_lines,subject,body,recipient_email,communication_id,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [w.project_id, d.id, w.id, w.revision, body.requestId, JSON.stringify(ctx.changes), JSON.stringify(detail.lines),
          email.subject, email.body, ctx.email, comm.id, actorId])).rows[0];
      await auditWorksheet(c, w, actorId, "revision_request", { requestId: request.id, revision: w.revision, changes: ctx.changes.length, recipient: ctx.email });
      return { requestId: request.id as number, communicationId: comm.id as number, status: comm.status as string, replay: false };
    });
    if (created.communicationId == null) return { requestId: created.requestId, status: "failed", message: "The email record is missing." };
    if (created.status === "sent") return { requestId: created.requestId, status: "sent", message: null };
    if (created.replay && created.status !== "queued") return { requestId: created.requestId, status: created.status, message: null };
    return { requestId: created.requestId, ...(await dispatch(created.communicationId, actorId)) };
  }

  async function retryRevisionRequest(worksheetId: number, requestId: number, actorId: number) {
    const r = (await deps.pool.query(`SELECT q.worksheet_id, q.communication_id, pc.status, p.archived_at FROM worksheet_revision_requests q
      JOIN projects p ON p.id=q.project_id LEFT JOIN project_communications pc ON pc.id=q.communication_id WHERE q.id=$1`, [requestId])).rows[0];
    if (!r || r.worksheet_id !== worksheetId) throw new WorksheetError("Revision request not found.", 404);
    if (r.archived_at) throw new WorksheetError("Archived projects are read-only.");
    if (r.communication_id == null || r.status !== "failed") throw new WorksheetError("Only a failed send can be retried.", 409);
    return { worksheetId: r.worksheet_id as number, requestId, ...(await dispatch(r.communication_id, actorId)) };
  }

  async function listRevisionRequests(worksheetId: number) {
    const rows = (await deps.pool.query(`SELECT q.*, pc.status AS comm_status, pc.sent_at, ${actorSql} AS created_by
      FROM worksheet_revision_requests q LEFT JOIN project_communications pc ON pc.id=q.communication_id
      LEFT JOIN users u ON u.id=q.created_by_user_id WHERE q.worksheet_id=$1 ORDER BY q.id DESC`, [worksheetId])).rows;
    return rows.map(r => ({
      id: r.id as number, worksheetRevision: r.worksheet_revision as number, subject: r.subject as string, body: r.body as string,
      recipientEmail: r.recipient_email as string, changeCount: (r.changes as unknown[]).length, createdAt: iso(r.created_at)!,
      createdBy: r.created_by ?? null, status: (r.comm_status as string | null) ?? "unknown", sentAt: iso(r.sent_at),
    }));
  }

  // ── Comparison ─────────────────────────────────────────────────────────

  async function comparisonCandidates(worksheetId: number) {
    const w = (await deps.pool.query("SELECT devis_id, project_id FROM quotation_worksheets WHERE id=$1", [worksheetId])).rows[0];
    if (!w) throw new WorksheetError("Worksheet not found.", 404);
    const replacement = (await deps.pool.query("SELECT new_devis_id FROM devis_replacements WHERE old_devis_id=$1", [w.devis_id])).rows[0];
    const rows = (await deps.pool.query(`SELECT d.id, d.devis_code, d.devis_number, d.amount_ht, d.created_at,
        (SELECT count(*)::int FROM devis_line_items li WHERE li.devis_id=d.id) AS lines
      FROM devis d WHERE d.project_id=$1 AND d.id<>$2
        AND (d.id=$3 OR d.contractor_id=(SELECT contractor_id FROM devis WHERE id=$2))
      ORDER BY (d.id=$3) DESC, d.id DESC LIMIT 30`, [w.project_id, w.devis_id, replacement?.new_devis_id ?? null])).rows;
    return {
      replacementDevisId: (replacement?.new_devis_id as number | undefined) ?? null,
      candidates: rows.map(r => ({ id: r.id as number, code: r.devis_code as string, number: r.devis_number as string | null,
        amountHt: r.amount_ht == null ? null : String(r.amount_ht), lineCount: r.lines as number, createdAt: iso(r.created_at)! })),
    };
  }

  async function compare(worksheetId: number, targetDevisId: number) {
    const w = (await deps.pool.query("SELECT * FROM quotation_worksheets WHERE id=$1", [worksheetId])).rows[0];
    if (!w) throw new WorksheetError("Worksheet not found.", 404);
    const target = (await deps.pool.query("SELECT id, project_id, devis_code, devis_number, amount_ht FROM devis WHERE id=$1", [targetDevisId])).rows[0];
    if (!target || target.project_id !== w.project_id || target.id === w.devis_id) throw new WorksheetError("Choose another quotation from this project.", 400);
    // Only a request the contractor actually received defines what was agreed.
    const request = (await deps.pool.query(`SELECT q.id, q.worksheet_revision, q.agreed_lines, pc.sent_at FROM worksheet_revision_requests q
      JOIN project_communications pc ON pc.id=q.communication_id
      WHERE q.worksheet_id=$1 AND pc.status='sent' ORDER BY q.id DESC LIMIT 1`, [worksheetId])).rows[0];
    const undelivered = (await deps.pool.query(`SELECT q.id, COALESCE(pc.status,'unknown') AS status, q.created_at FROM worksheet_revision_requests q
      LEFT JOIN project_communications pc ON pc.id=q.communication_id
      WHERE q.worksheet_id=$1 AND q.id > $2 AND COALESCE(pc.status,'unknown') <> 'sent' ORDER BY q.id DESC LIMIT 1`, [worksheetId, request?.id ?? 0])).rows[0];
    let agreed: WorksheetLineData[];
    let basis: { kind: "revision_request"; requestId: number; revision: number; at: string } | { kind: "worksheet"; revision: number };
    if (request) {
      agreed = request.agreed_lines as WorksheetLineData[];
      basis = { kind: "revision_request", requestId: request.id, revision: request.worksheet_revision, at: iso(request.sent_at)! };
    } else {
      agreed = (await worksheetService().get(worksheetId, deps.pool)).lines;
      basis = { kind: "worksheet", revision: w.revision };
    }
    const lines: RevisedQuotationLine[] = (await deps.pool.query(`SELECT id, line_number, description, unit, quantity, unit_price_ht, total_ht
      FROM devis_line_items WHERE devis_id=$1 ORDER BY line_number, id`, [targetDevisId])).rows.map(r => ({
      id: r.id, lineNumber: r.line_number, description: String(r.description ?? ""), unit: r.unit ?? null,
      quantity: r.quantity == null ? null : String(r.quantity), unitPriceHt: r.unit_price_ht == null ? null : String(r.unit_price_ht),
      totalHt: r.total_ht == null ? null : String(r.total_ht),
    }));
    return {
      basis, worksheetChangedSinceBasis: w.revision !== basis.revision,
      /** A later request that has not been confirmed as delivered (pending or failed); not used as the basis. */
      undeliveredRequest: undelivered ? { id: undelivered.id as number, status: undelivered.status as string, createdAt: iso(undelivered.created_at)! } : null,
      target: { id: target.id as number, code: target.devis_code as string, number: target.devis_number as string | null,
        amountHt: target.amount_ht == null ? null : String(target.amount_ht), lineCount: lines.length },
      agreedOriginalHtCents: computeWorksheet(agreed, null).original.htCents,
      comparison: compareWithRevisedQuotation(agreed, lines),
    };
  }

  return {
    share, withdraw, shareState, acknowledgeComments, devisSummary, visibleForProject, publicRelease, addClientComment,
    previewRevisionRequest, sendRevisionRequest, retryRevisionRequest, listRevisionRequests, comparisonCandidates, compare,
  };
}

let service: ReturnType<typeof createWorksheetAgreementService> | null = null;
export const worksheetAgreementService = () => (service ??= createWorksheetAgreementService({ pool }));
