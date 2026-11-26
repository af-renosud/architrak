---
name: Quotation points to check
description: How automatic quotation check points are keyed, stored and reviewed; route naming collision.
---
Rule points are computed on read from the current lines and never stored. A point's key is category + line ids + the figures that triggered it. Dismiss/reopen/sent-to-worksheet records are append-only and snapshot the point. AI suggestions are stored per run (key `ai:<runId>:<i>`), and only the latest successful run is shown.

**Why:** if the lines change, a dismissed point comes back as a new point instead of silently staying hidden. Each AI run gets fresh keys, so dismissals of earlier AI suggestions do not carry over.

**How to apply:** do not persist rule points. When you change a rule's trigger figures, accept that keys change. The API lives at `/api/devis/:id/points-to-check`; `/api/devis/:id/checks` already belongs to the contractor-questions feature.

Gemini failures map to allowlisted messages (402 = out of credit, 429/503 = busy). The dev Gemini key had depleted credit on 2026-11-26.
