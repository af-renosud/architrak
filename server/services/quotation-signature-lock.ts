import type { RequestHandler } from "express";
import { pool } from "../db";
import { REPLACEMENT_LOCK_NAMESPACE } from "./quotation-replacement.service";

/** Ordinary content writers use row locks, not the signing advisory lock.
 * Keep their commits outside the final source-read/dispatch interval. */
export async function withQuotationDispatchLock<T>(devisId: number, dispatch: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM devis WHERE id=$1 FOR SHARE", [devisId]);
    await client.query("SELECT p.id FROM projects p JOIN devis d ON d.project_id=p.id WHERE d.id=$1 FOR SHARE OF p", [devisId]);
    await client.query("SELECT id FROM devis_line_items WHERE devis_id=$1 FOR SHARE", [devisId]);
    await client.query("SELECT devis_id FROM devis_translations WHERE devis_id=$1 FOR SHARE", [devisId]);
    const result = await dispatch();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/** Keep the replacement decision outside the entire external signature send,
 * including the interval before an envelope ID has been persisted. */
export function withQuotationSignatureLock(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    let client;
    try { client = await pool.connect(); }
    catch (err) { next(err); return; }
    let acquired = false;
    let destroy = false;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired",
        [REPLACEMENT_LOCK_NAMESPACE, Number(req.params.id)]);
      acquired = result.rows[0].acquired;
      if (!acquired) {
        res.status(409).json({ code: "QUOTATION_BUSY", message: "A signing or replacement action is already in progress. Please wait, then try again." });
        return;
      }
      await handler(req, res, next);
    } catch (err) { next(err); }
    finally {
      if (acquired) {
        try {
          await client.query("SELECT pg_advisory_unlock($1::int, $2::int)",
            [REPLACEMENT_LOCK_NAMESPACE, Number(req.params.id)]);
        } catch { destroy = true; }
      }
      client.release(destroy);
    }
  };
}
