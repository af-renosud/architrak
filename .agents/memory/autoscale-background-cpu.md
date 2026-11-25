---
name: Autoscale background CPU
description: Why production PDF rasterisation/intake jobs time out while dev renders the same PDF in ~1.5s.
---
Production is an Autoscale deployment. Intake and Gmail jobs run in the background after the HTTP response returns. The same Stimulsoft PDFs that render in about 1.5s in dev hit 120s pdftoppm timeouts in production (about half of emailed PDFs failed rasterisation on 2026-11-18 to 11-24).
**Why:** Autoscale allocates and bills compute only while requests are being served, so background work probably runs with very little CPU. This is the most likely cause. It has not been confirmed from production logs, which were no longer available.
**How to apply:** Before adding another rasteriser fallback, consider either a Reserved VM deployment or keeping the heavy work inside a request. Treat a bare drizzle "Failed query" from a background job as transient, and store its `cause`.
