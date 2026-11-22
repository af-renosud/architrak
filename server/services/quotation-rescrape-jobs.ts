import { randomUUID } from "node:crypto";
import { pool } from "../db";
import { rescrapeDevis } from "./devis-rescrape.service";
import { decodeExtractionResponse } from "../gmail/extraction-response";
import type { ParsedDocument } from "../gmail/document-parser";

const LOCK_NAMESPACE = 848;
let sweeping = false;
let timer: ReturnType<typeof setInterval> | undefined;

export async function quotationRescrapeStatus(id: number) {
  const { rows } = await pool.query(
    "SELECT state,message,updated_at FROM quotation_rescrape_jobs WHERE devis_id=$1", [id]);
  return rows[0] ?? null;
}
export async function isQuotationRescrapeRunning(id: number) {
  const status = await quotationRescrapeStatus(id);
  return status?.state === "pending" || status?.state === "running";
}
export async function startQuotationRescrape(id: number) {
  await pool.query(`INSERT INTO quotation_rescrape_jobs(devis_id) VALUES($1)
    ON CONFLICT(devis_id) DO UPDATE SET state='pending',owner=NULL,attempts=0,message=NULL,updated_at=now()
    WHERE quotation_rescrape_jobs.state NOT IN ('pending','running')`, [id]);
  void sweepQuotationRescrapes().catch(() => console.error("[QuotationRescrape] Queue deferred"));
}

/** A session lock excludes other instances, including recovery of abandoned runs.
 * The owner token fences final writes; loss of the lock connection invalidates results. */
export async function runQuotationRescrape(id: number) {
  const client = await pool.connect();
  const owner = randomUUID();
  let locked = false;
  let lost = false;
  const onError = () => { lost = true; };
  client.on("error", onError);
  try {
    const { rows: [lock] } = await client.query("SELECT pg_try_advisory_lock($1,$2) AS locked", [LOCK_NAMESPACE, id]);
    locked = lock.locked;
    if (!locked) return;
    const { rows: [job] } = await client.query(`UPDATE quotation_rescrape_jobs
      SET state='running',owner=$2,attempts=attempts+1,updated_at=now(),
        message='Reading the quotation. Compatible completed page groups will be reused.'
      WHERE devis_id=$1 AND state IN ('pending','running') RETURNING attempts`, [id, owner]);
    if (!job) return;
    if (job.attempts > 3) {
      await client.query(`UPDATE quotation_rescrape_jobs SET state='failed',
        message='Extraction was interrupted repeatedly. Retry when the service is available.',updated_at=now()
        WHERE devis_id=$1 AND owner=$2`, [id, owner]);
      return;
    }
    const assertOwner = async () => {
      if (lost) throw new Error("Extraction ownership lost");
      const { rows } = await client.query(
        "SELECT 1 FROM quotation_rescrape_jobs WHERE devis_id=$1 AND owner=$2 AND state='running'", [id, owner]);
      if (!rows.length || lost) throw new Error("Extraction ownership lost");
    };
    const heartbeat = setInterval(() => {
      if (!lost) void client.query(`UPDATE quotation_rescrape_jobs SET updated_at=now()
        WHERE devis_id=$1 AND owner=$2 AND state='running'`, [id, owner])
        .catch(() => { lost = true; });
    }, 15_000);
    heartbeat.unref();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const writeEvent: Parameters<typeof rescrapeDevis>[3] = async (devisId, kind, outcome, snapshot = {}) => {
        if (lost || devisId !== id) throw new Error("Extraction ownership lost");
        const inserted = await client.query(`INSERT INTO quotation_extraction_events(devis_id,kind,outcome,snapshot)
          SELECT devis_id,$3,$4,$5::jsonb FROM (
            SELECT devis_id FROM quotation_rescrape_jobs
            WHERE devis_id=$1 AND owner=$2 AND state='running' FOR UPDATE
          ) owned RETURNING id`, [id, owner, kind, outcome, JSON.stringify(snapshot)]);
        if (!inserted.rowCount) throw new Error("Extraction ownership lost");
      };
      const work = rescrapeDevis(id, undefined, assertOwner, writeEvent, {
        load: async key => {
          await assertOwner();
          const { rows } = await client.query(`SELECT snapshot->'result' AS result
            FROM quotation_extraction_events WHERE devis_id=$1 AND kind='attempt' AND outcome='chunk_saved'
            AND snapshot->>'key'=$2 ORDER BY id DESC LIMIT 1`, [id, key]);
          await assertOwner();
          if (!rows[0]) return null;
          try { return decodeExtractionResponse(JSON.stringify(rows[0].result)) as unknown as ParsedDocument; }
          catch { return null; }
        },
        save: async (key, result, completed, total) => {
          await assertOwner();
          const clean = decodeExtractionResponse(JSON.stringify(result));
          await writeEvent(id, "attempt", "chunk_saved", { key, result: clean });
          await assertOwner();
          await client.query(`UPDATE quotation_rescrape_jobs SET message=$3,updated_at=now()
            WHERE devis_id=$1 AND owner=$2 AND state='running'`,
            [id, owner, `Read ${completed} of ${total} page groups. Completed work is saved; you can leave this screen.`]);
        },
      });
      const result = await Promise.race([work, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { lost = true; reject(new Error("Job deadline")); }, 10 * 60_000);
      })]);
      await assertOwner();
      // Never persist arbitrary provider exceptions or credentials.
      const message = result.success ? "Extraction ready. Review the prepared candidate before applying it."
        : (result.data.extraction as { extractionFailure?: { message?: string } } | undefined)?.extractionFailure?.message
        ?? (result.status === 409 ? "Extraction is blocked by protected quotation content or its current status. Review the existing quotation."
        : "Extraction could not finish. The original quotation is unchanged. Review the extraction details and retry.");
      const retryable = !result.success && result.status === 503 && job.attempts < 3;
      await client.query(`UPDATE quotation_rescrape_jobs SET state=$3,message=$4,updated_at=now()
        WHERE devis_id=$1 AND owner=$2 AND state='running'`, [id, owner,
          result.success ? "prepared" : retryable ? "pending" : "failed",
          retryable ? `${message} A retry is queued; completed page groups are saved.` : message]);
    } catch {
      await client.query(`UPDATE quotation_rescrape_jobs SET state='failed',
        message='Extraction failed. The original quotation is unchanged. Please retry.',updated_at=now()
        WHERE devis_id=$1 AND owner=$2`, [id, owner]).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
    }
  } finally {
    if (locked && !lost) await client.query("SELECT pg_advisory_unlock($1,$2)", [LOCK_NAMESPACE, id]).catch(() => { lost = true; });
    client.removeListener("error", onError);
    client.release(lost);
  }
}
export async function sweepQuotationRescrapes() {
  if (sweeping) return;
  sweeping = true;
  try {
    const { rows } = await pool.query(`SELECT devis_id FROM quotation_rescrape_jobs
       WHERE state='running' OR (state='pending' AND
         (attempts=0 OR updated_at < now() - attempts * interval '15 seconds'))
       ORDER BY updated_at LIMIT 10`);
    // Single concurrent extraction per instance; DB locks coordinate instances.
    for (const row of rows) await runQuotationRescrape(row.devis_id);
  } finally { sweeping = false; }
}
export function startQuotationRescrapeSweeper() {
  if (timer) return;
  const sweep = () => void sweepQuotationRescrapes().catch(() => console.error("[QuotationRescrape] Queue unavailable"));
  timer = setInterval(sweep, 15_000);
  timer.unref();
  sweep();
}
