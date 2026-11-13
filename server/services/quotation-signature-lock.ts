import type { RequestHandler } from "express";
import { pool } from "../db";
import { REPLACEMENT_LOCK_NAMESPACE } from "./quotation-replacement.service";

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
