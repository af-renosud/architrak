import { pool } from "../db";
import type { Pool, PoolClient } from "pg";
import type { FeeRecordKind, FeeVisibilityResponse, FeeVisibilityRecord } from "@shared/fee-visibility";

type Queryable = Pick<Pool | PoolClient, "query">;
export class FeeVisibilityError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function feeEntryArchiveBlock(entry: {
  status: string; pennylane_invoice_ref?: string | null; pennylane_invoice_id?: string | null;
  pennylane_invoice_number?: string | null; pennylane_paid_at?: unknown;
  pennylane_status?: string | null; push_blocked?: boolean;
}): string | null {
  if (entry.push_blocked) return "Resolve the accounting synchronization before archiving.";
  if (!["invoiced", "paid"].includes(entry.status)) return "Record the invoice before archiving this entry.";
  if (![entry.pennylane_invoice_ref, entry.pennylane_invoice_number, entry.pennylane_invoice_id].some(x => x?.trim())) {
    return "Add or reconcile the accounting invoice reference first.";
  }
  if (entry.pennylane_invoice_id && !entry.pennylane_paid_at && entry.pennylane_status !== "paid") {
    return "The linked accounting invoice is unpaid or its payment status is unconfirmed.";
  }
  return null;
}

export async function getFeeVisibility(projectId: number, connection: Queryable = pool): Promise<FeeVisibilityResponse> {
  const project = (await connection.query("SELECT id FROM projects WHERE id=$1", [projectId])).rows[0];
  if (!project) throw new FeeVisibilityError(404, "Project not found.");
  const fees = (await connection.query("SELECT * FROM fees WHERE project_id=$1 ORDER BY id", [projectId])).rows;
  const entries = (await connection.query(`SELECT e.*, EXISTS (
    SELECT 1 FROM pennylane_pushes p WHERE p.doc_id=e.id
    AND p.kind IN ('customer_invoice','email_send') AND p.state <> 'succeeded'
  ) AS push_blocked FROM fee_entries e JOIN fees f ON f.id=e.fee_id WHERE f.project_id=$1 ORDER BY e.id`, [projectId])).rows;
  const pending = (await connection.query(`SELECT project_id, candidates FROM architect_fee_invoices WHERE status='pending_review'`)).rows;
  const hasPending = pending.some(row => Number(row.project_id) === projectId ||
    (row.candidates?.projects ?? []).some((p: { projectId?: number }) => Number(p.projectId) === projectId));
  const events = (await connection.query(`SELECT v.* FROM fee_visibility_events v
    JOIN fees f ON f.id=v.fee_id WHERE f.project_id=$1 ORDER BY v.id DESC`, [projectId])).rows;
  const latest = new Map<string, any>();
  for (const event of events) {
    const key = event.entry_id == null ? `fee:${event.fee_id}` : `entry:${event.entry_id}`;
    if (!latest.has(key)) latest.set(key, event);
  }
  const records: FeeVisibilityRecord[] = [];
  const entryBlocks = new Map<number, string | null>();
  const append = (kind: FeeRecordKind, id: number, block: string | null) => {
    const event = latest.get(`${kind}:${id}`);
    records.push({
      kind, id, blockedReason: block,
      // New unresolved work always resurfaces, without rewriting historical decisions.
      archived: event?.action === "archive" && !block,
      archivedAt: event?.action === "archive" ? new Date(event.created_at).toISOString() : null,
      reason: event?.reason ?? null,
    });
  };
  for (const entry of entries) {
    const block = hasPending ? "Review this project's detected invoices before archiving." : feeEntryArchiveBlock(entry);
    entryBlocks.set(entry.id, block);
    append("entry", entry.id, block);
  }
  for (const fee of fees) {
    const children = entries.filter(entry => entry.fee_id === fee.id);
    const remaining = Number(fee.fee_amount_ht) - Number(fee.invoiced_amount ?? 0);
    const block = hasPending ? "Review this project's detected invoices before archiving."
      : !Number.isFinite(remaining) || Math.abs(remaining) >= 0.005 ? "This fee still has an amount to invoice or reconcile."
      : children.some(entry => entryBlocks.get(entry.id)) ? "Resolve the outstanding entries in this fee before archiving."
      : !children.length && Number(fee.fee_amount_ht) !== 0 && !fee.pennylane_ref?.trim() ? "Record the accounting invoice reference before archiving."
      : null;
    append("fee", fee.id, block);
  }
  return {
    records,
    events: events.map(event => ({
      id: event.id, kind: event.entry_id == null ? "fee" : "entry",
      recordId: event.entry_id ?? event.fee_id, action: event.action,
      reason: event.reason, actor: event.actor, createdAt: new Date(event.created_at).toISOString(),
    })),
  };
}

export async function changeFeeVisibility(args: {
  projectId: number; kind: FeeRecordKind; id: number;
  action: "archive" | "restore"; reason: string; actor: string;
}): Promise<FeeVisibilityResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize archive/restore decisions on the owning fee; lock children too.
    const result = await client.query(args.kind === "fee"
      ? "SELECT id FROM fees WHERE id=$1 AND project_id=$2 FOR UPDATE"
      : "SELECT f.id FROM fees f JOIN fee_entries e ON e.fee_id=f.id WHERE e.id=$1 AND f.project_id=$2 FOR UPDATE OF f",
    [args.id, args.projectId]);
    const fee = result.rows[0];
    if (!fee) throw new FeeVisibilityError(404, "Fee record not found in this project.");
    await client.query("SELECT id FROM fee_entries WHERE fee_id=$1 ORDER BY id FOR UPDATE", [fee.id]);
    const state = await getFeeVisibility(args.projectId, client);
    const record = state.records.find(r => r.kind === args.kind && r.id === args.id)!;
    if (args.action === "archive" && record.blockedReason) throw new FeeVisibilityError(409, record.blockedReason);
    // A repeat request is a no-op; it never creates duplicate audit events.
    if ((args.action === "archive" && record.archived) || (args.action === "restore" && !record.archivedAt)) {
      await client.query("COMMIT");
      return state;
    }
    await client.query(`INSERT INTO fee_visibility_events (fee_id,entry_id,action,reason,actor)
      VALUES ($1,$2,$3,$4,$5)`, [fee.id, args.kind === "entry" ? args.id : null, args.action, args.reason, args.actor]);
    const updated = await getFeeVisibility(args.projectId, client);
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
