import { pool } from "../db";

export async function recordExtractionEvent(devisId: number, kind: "attempt" | "review" | "replacement",
  outcome: string, snapshot: unknown = {}) {
  await pool.query(`INSERT INTO quotation_extraction_events(devis_id,kind,outcome,snapshot)
    VALUES($1,$2,$3,$4::jsonb)`, [devisId, kind, outcome, JSON.stringify(snapshot)]);
}