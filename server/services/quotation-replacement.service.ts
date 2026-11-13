import { createHash } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { accountingStateChanges, contractors, devis, devisReplacements, projects, users, type Devis } from "@shared/schema";
import type { DbTransaction } from "../storage";
import type { ReplacementOptions, ReplacementQuotation, QuotationReplacementHistory } from "@shared/quotation-replacement";

export const REPLACEMENT_LOCK_NAMESPACE = 80101;
export const replaceQuotationSchema = z.object({
  replacementDevisId: z.number().int().positive(),
  note: z.string().trim().min(1, "Explain why this quotation is being replaced.").max(2000),
  sourceVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  impactVersion: z.string().min(1),
  differentContractorAcknowledged: z.boolean().default(false),
}).strict();

export class ReplacementError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const label = (d: Devis) => `${d.devisCode}${d.devisNumber ? ` — ${d.devisNumber}` : ""}`;
export function replacementBlockedReason(d: Devis): string | null {
  if (d.status === "void" || d.signOffStage === "void") return "This quotation is void and cannot be replaced.";
  if (d.accountingState === "superseded") return "This quotation has already been replaced.";
  const terminalEnvelope = ["signed", "declined", "expired", "cancelled", "canceled", "revoked"].includes(d.archisignEnvelopeStatus ?? "");
  if (["sent", "viewed", "queried", "created", "draft", "pending", "partially_signed"].includes(d.archisignEnvelopeStatus ?? "")
    || (d.archisignEnvelopeId && !terminalEnvelope)
    || (d.signOffStage === "sent_to_client" && !terminalEnvelope)) {
    return "A signature request is in progress. Resolve or cancel it in the signing workflow before replacing this quotation.";
  }
  return null;
}
function quotation(d: Devis, contractorName: string): ReplacementQuotation {
  return {
    id: d.id, devisCode: d.devisCode, devisNumber: d.devisNumber,
    descriptionFr: d.descriptionFr, contractorId: d.contractorId, contractorName,
    amountHt: d.amountHt, amountTtc: d.amountTtc,
    signed: d.signOffStage === "client_signed_off" || d.status === "signed"
      || d.archisignEnvelopeStatus === "signed" || !!d.signedPdfStorageKey,
    // Bind confirmation to the exact server row, including signature and revision state.
    version: hash(d), blockedReason: replacementBlockedReason(d),
  };
}

async function impactFor(conn: typeof db | DbTransaction, source: Devis) {
  // Legacy whole-contractor certificates may have no explicit source rows.
  // Include them conservatively so the architect is warned rather than hiding payments.
  const result = await conn.execute(sql`
    WITH inv AS (SELECT * FROM invoices WHERE devis_id = ${source.id}),
    sit AS (SELECT * FROM situations WHERE devis_id = ${source.id}),
    cert AS (
      SELECT c.* FROM certificats c WHERE c.project_id = ${source.projectId} AND (
        c.acompte_devis_id = ${source.id}
        OR EXISTS (SELECT 1 FROM certificat_sources cs WHERE cs.certificat_id = c.id AND
          (cs.invoice_id IN (SELECT id FROM inv) OR cs.situation_id IN (SELECT id FROM sit)))
        OR (c.contractor_id = ${source.contractorId} AND NOT EXISTS
          (SELECT 1 FROM certificat_sources cs WHERE cs.certificat_id = c.id))
      )
    )
    SELECT
      COALESCE((SELECT jsonb_agg(to_jsonb(inv) ORDER BY id) FROM inv), '[]'::jsonb) AS invoices,
      COALESCE((SELECT jsonb_agg(to_jsonb(sit) ORDER BY id) FROM sit), '[]'::jsonb) AS situations,
      COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM marche_documents m WHERE devis_id = ${source.id}), '[]'::jsonb) AS marches,
      COALESCE((SELECT jsonb_agg(to_jsonb(cert) ORDER BY id) FROM cert), '[]'::jsonb) AS certificates,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM certificat_payments p WHERE certificat_id IN (SELECT id FROM cert)), '[]'::jsonb) AS payments,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM acompte_no_invoice_payments p WHERE devis_id = ${source.id}), '[]'::jsonb) AS deposits
  `);
  const evidence = result.rows[0] as Record<string, Array<{ status?: string; date_paid?: string }>>;
  return {
    impact: {
      invoices: evidence.invoices.length, situations: evidence.situations.length,
      marcheDocuments: evidence.marches.length, certificates: evidence.certificates.length,
      payments: evidence.payments.length + evidence.deposits.length
        + evidence.invoices.filter(i => i.status === "paid" || i.date_paid).length,
    },
    impactVersion: hash(evidence),
  };
}

export async function getReplacementOptions(id: number): Promise<ReplacementOptions> {
  const [source] = await db.select().from(devis).where(eq(devis.id, id));
  if (!source) throw new ReplacementError(404, "NOT_FOUND", "Quotation not found.");
  const [project] = await db.select().from(projects).where(eq(projects.id, source.projectId));
  const rows = await db.select({ d: devis, name: contractors.name }).from(devis)
    .innerJoin(contractors, eq(contractors.id, devis.contractorId)).where(eq(devis.projectId, source.projectId));
  const links = await db.select().from(devisReplacements).where(eq(devisReplacements.projectId, source.projectId));
  const alreadyTargets = new Set(links.map(link => link.newDevisId));
  return {
    source: quotation(source, rows.find(row => row.d.id === id)?.name ?? "Unknown contractor"),
    candidates: rows.filter(({ d }) => d.id !== id && d.status !== "void" && d.signOffStage !== "void"
      && d.accountingState !== "superseded" && !alreadyTargets.has(d.id))
      .map(({ d, name }) => quotation(d, name)),
    ...await impactFor(db, source),
    blockedReason: project?.archivedAt || project?.status === "archived"
      ? "Archived projects are read-only." : replacementBlockedReason(source),
  };
}

export async function getReplacementHistory(projectId: number): Promise<QuotationReplacementHistory[]> {
  const rows = await db.select().from(devisReplacements)
    .where(eq(devisReplacements.projectId, projectId)).orderBy(asc(devisReplacements.id));
  return rows.map(row => ({
    id: row.id, oldDevisId: row.oldDevisId, newDevisId: row.newDevisId,
    oldLabel: row.oldLabel, newLabel: row.newLabel, note: row.note,
    actorName: row.actorName, createdAt: row.createdAt.toISOString(),
  }));
}

export async function replaceQuotation(id: number, input: z.infer<typeof replaceQuotationSchema>, actorId: number) {
  const data = replaceQuotationSchema.parse(input);
  if (id === data.replacementDevisId) throw new ReplacementError(400, "SELF_REPLACEMENT", "Choose a different quotation.");
  return db.transaction(async tx => {
    // Signature sending holds these same locks across external calls. Try, never
    // queue a replacement that could execute unexpectedly after a long send.
    for (const lockedId of [id, data.replacementDevisId].sort((a, b) => a - b)) {
      const lock = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${REPLACEMENT_LOCK_NAMESPACE}, ${lockedId}) AS acquired`);
      if (!lock.rows[0]?.acquired) throw new ReplacementError(409, "QUOTATION_BUSY", "A signing or replacement action is in progress. Wait for it to finish, then review again.");
    }
    const [initial] = await tx.select().from(devis).where(eq(devis.id, id));
    if (!initial) throw new ReplacementError(404, "NOT_FOUND", "Quotation not found.");
    // Project lock serializes the whole replacement graph and archive changes.
    const [project] = await tx.select().from(projects).where(eq(projects.id, initial.projectId)).for("update");
    if (!project || project.archivedAt || project.status === "archived") throw new ReplacementError(409, "PROJECT_ARCHIVED", "Archived projects are read-only.");
    const rows = await tx.select().from(devis).where(inArray(devis.id, [id, data.replacementDevisId])).orderBy(asc(devis.id)).for("update");
    const source = rows.find(row => row.id === id)!;
    const target = rows.find(row => row.id === data.replacementDevisId);
    if (!target || target.projectId !== source.projectId) throw new ReplacementError(400, "INVALID_TARGET", "Choose a live quotation in the same project.");
    for (const row of [source, target]) {
      const reason = replacementBlockedReason(row);
      if (reason) throw new ReplacementError(409, "REPLACEMENT_BLOCKED", reason);
    }
    if (hash(source) !== data.sourceVersion || hash(target) !== data.targetVersion) {
      throw new ReplacementError(409, "STALE_REVIEW", "A quotation changed while you were reviewing. Refresh and review the replacement again.");
    }
    if (source.contractorId !== target.contractorId && !data.differentContractorAcknowledged) {
      throw new ReplacementError(400, "CONTRACTOR_ACK_REQUIRED", "Confirm that you intend to replace this quotation with one from a different contractor.");
    }
    const history = await tx.select().from(devisReplacements).where(eq(devisReplacements.projectId, source.projectId));
    if (history.some(h => h.oldDevisId === id || h.newDevisId === target.id)) {
      throw new ReplacementError(409, "ALREADY_LINKED", "One of these quotations already has a replacement relationship. Refresh and review its history.");
    }
    let cursor = target.id;
    const seen = new Set<number>();
    while (!seen.has(cursor)) {
      if (cursor === source.id) throw new ReplacementError(409, "REPLACEMENT_CYCLE", "This would create a circular replacement history.");
      seen.add(cursor);
      const next = history.find(h => h.oldDevisId === cursor);
      if (!next) break;
      cursor = next.newDevisId;
    }
    const impact = await impactFor(tx, source);
    if (impact.impactVersion !== data.impactVersion) throw new ReplacementError(409, "STALE_IMPACT", "Linked financial records changed. Review the impact again before confirming.");
    const [actor] = await tx.select().from(users).where(eq(users.id, actorId));
    if (!actor) throw new ReplacementError(401, "ACTOR_REQUIRED", "Sign in again before recording a replacement.");
    await tx.update(devis).set({ accountingState: "superseded", updatedAt: new Date() }).where(eq(devis.id, source.id));
    await tx.insert(devisReplacements).values({
      projectId: source.projectId, oldDevisId: source.id, newDevisId: target.id,
      actorId, actorName: [actor.firstName, actor.lastName].filter(Boolean).join(" ") || actor.email, note: data.note,
      oldLabel: label(source), newLabel: label(target),
      snapshot: {
        old: { label: label(source), amountHt: source.amountHt, amountTtc: source.amountTtc, contractorId: source.contractorId, stage: source.signOffStage },
        replacement: { label: label(target), amountHt: target.amountHt, amountTtc: target.amountTtc, contractorId: target.contractorId, stage: target.signOffStage },
        impact: impact.impact, differentContractorAcknowledged: data.differentContractorAcknowledged,
      },
    });
    await tx.insert(accountingStateChanges).values({
      devisId: source.id, projectId: source.projectId, fromState: source.accountingState, toState: "superseded",
      reason: "human_replace", actorUserId: actorId, note: `Replaced by ${label(target)}. ${data.note}`,
    });
    return { ok: true as const, projectId: source.projectId };
  });
}
