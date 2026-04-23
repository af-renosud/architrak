import { db } from "../server/db";
import { eq, and, isNull, isNotNull, asc } from "drizzle-orm";
import { devis, devisLineItems } from "@shared/schema";
import { getDocumentBuffer } from "../server/storage/object-storage";
import { parseDocument } from "../server/gmail/document-parser";

// Backfill `devis_line_items.pdf_page_hint` for older devis uploaded before
// Task #111 introduced click-to-jump. The script re-runs the AI extractor's
// page-hint pass against the stored source PDF and patches ONLY the page
// hint column on existing rows — descriptions, totals, line numbers and
// every other field are left untouched (matching the task's invariant).
//
// Idempotent: devis whose line items already all carry a page hint are
// skipped without re-calling the AI. Within a single devis, line items
// that already have a hint are likewise left alone — only currently-null
// hints get filled. Re-running after a successful pass is a no-op.
//
// Coercion mirrors `processDevisUpload` so the script can never persist a
// garbage hint that would mis-target the contractor portal jump button.

export interface DevisStats {
  devisId: number;
  devisCode: string | null;
  status: "skipped-no-pdf" | "skipped-no-lines" | "skipped-already-complete"
        | "skipped-parse-failed" | "skipped-no-extracted-lines"
        | "updated" | "no-new-hints";
  lineItems: number;
  alreadyHinted: number;
  updated: number;
  reason?: string;
}

interface CliOptions {
  dryRun: boolean;
  devisId: number | null;
  limit: number | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, devisId: null, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--devis-id") opts.devisId = Number(argv[++i]);
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/backfill-page-hints.ts [--dry-run] [--devis-id <id>] [--limit <n>]",
      );
      process.exit(0);
    }
  }
  if (opts.devisId != null && (!Number.isFinite(opts.devisId) || opts.devisId <= 0)) {
    throw new Error(`--devis-id must be a positive integer, got: ${argv.join(" ")}`);
  }
  if (opts.limit != null && (!Number.isFinite(opts.limit) || opts.limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got: ${argv.join(" ")}`);
  }
  return opts;
}

export function coercePageHint(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1
    ? Math.floor(raw)
    : null;
}

export async function backfillOne(devisId: number, dryRun: boolean): Promise<DevisStats> {
  const [d] = await db.select().from(devis).where(eq(devis.id, devisId)).limit(1);
  if (!d) {
    return { devisId, devisCode: null, status: "skipped-no-pdf", lineItems: 0, alreadyHinted: 0, updated: 0, reason: "devis not found" };
  }
  const base: DevisStats = {
    devisId: d.id,
    devisCode: d.devisCode ?? null,
    status: "updated",
    lineItems: 0,
    alreadyHinted: 0,
    updated: 0,
  };

  if (!d.pdfStorageKey || !d.pdfFileName) {
    return { ...base, status: "skipped-no-pdf" };
  }

  const lines = await db
    .select()
    .from(devisLineItems)
    .where(eq(devisLineItems.devisId, d.id))
    .orderBy(asc(devisLineItems.lineNumber));

  base.lineItems = lines.length;
  base.alreadyHinted = lines.filter((l) => l.pdfPageHint != null).length;

  if (lines.length === 0) {
    return { ...base, status: "skipped-no-lines" };
  }
  if (base.alreadyHinted === lines.length) {
    return { ...base, status: "skipped-already-complete" };
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await getDocumentBuffer(d.pdfStorageKey);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...base, status: "skipped-parse-failed", reason: `pdf fetch: ${reason}` };
  }

  const parsed = await parseDocument(pdfBuffer, d.pdfFileName);
  if (!parsed.lineItems || parsed.lineItems.length === 0) {
    return { ...base, status: "skipped-no-extracted-lines" };
  }

  // Map parsed lines by 1-indexed position; the upload-time persistence path
  // creates each devis_line_items row with lineNumber = i + 1, so this is the
  // natural and stable join key. Re-extraction order is deterministic at
  // temperature 0 in the parser config.
  const parsedByLineNumber = new Map<number, number | null>();
  parsed.lineItems.forEach((li, i) => {
    parsedByLineNumber.set(i + 1, coercePageHint(li.pageHint));
  });

  let updated = 0;
  for (const line of lines) {
    if (line.pdfPageHint != null) continue;
    const newHint = parsedByLineNumber.get(line.lineNumber);
    if (newHint == null) continue;
    if (!dryRun) {
      await db
        .update(devisLineItems)
        .set({ pdfPageHint: newHint })
        .where(and(eq(devisLineItems.id, line.id), isNull(devisLineItems.pdfPageHint)));
    }
    updated++;
  }

  return {
    ...base,
    status: updated > 0 ? "updated" : "no-new-hints",
    updated,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  console.log(
    `[backfill-page-hints] starting dryRun=${opts.dryRun} devisId=${opts.devisId ?? "all"} limit=${opts.limit ?? "none"}`,
  );

  let candidates: Array<{ id: number }>;
  if (opts.devisId != null) {
    candidates = [{ id: opts.devisId }];
  } else {
    const baseQuery = db
      .select({ id: devis.id })
      .from(devis)
      .where(isNotNull(devis.pdfStorageKey))
      .orderBy(asc(devis.id));
    candidates = opts.limit != null ? await baseQuery.limit(opts.limit) : await baseQuery;
  }

  const summary: Record<DevisStats["status"], number> = {
    "skipped-no-pdf": 0,
    "skipped-no-lines": 0,
    "skipped-already-complete": 0,
    "skipped-parse-failed": 0,
    "skipped-no-extracted-lines": 0,
    "updated": 0,
    "no-new-hints": 0,
  };
  let totalLinesUpdated = 0;

  for (const { id } of candidates) {
    let stats: DevisStats;
    try {
      stats = await backfillOne(id, opts.dryRun);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stats = { devisId: id, devisCode: null, status: "skipped-parse-failed", lineItems: 0, alreadyHinted: 0, updated: 0, reason };
    }
    summary[stats.status]++;
    totalLinesUpdated += stats.updated;
    const tag = `devis#${stats.devisId}${stats.devisCode ? ` (${stats.devisCode})` : ""}`;
    if (stats.status === "updated") {
      console.log(
        `[backfill-page-hints] ${tag}: updated ${stats.updated}/${stats.lineItems - stats.alreadyHinted} pending lines (${stats.alreadyHinted} already hinted)`,
      );
    } else if (stats.status === "no-new-hints") {
      console.log(
        `[backfill-page-hints] ${tag}: re-extracted but AI emitted no usable page hints for the ${stats.lineItems - stats.alreadyHinted} pending lines`,
      );
    } else {
      console.log(
        `[backfill-page-hints] ${tag}: ${stats.status}${stats.reason ? ` — ${stats.reason}` : ""}`,
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[backfill-page-hints] done in ${elapsedMs}ms. devis examined=${candidates.length} ` +
      `updated=${summary.updated} noNewHints=${summary["no-new-hints"]} ` +
      `alreadyComplete=${summary["skipped-already-complete"]} noPdf=${summary["skipped-no-pdf"]} ` +
      `noLines=${summary["skipped-no-lines"]} parseFailed=${summary["skipped-parse-failed"]} ` +
      `noExtractedLines=${summary["skipped-no-extracted-lines"]} ` +
      `totalLineItemsUpdated=${totalLinesUpdated}${opts.dryRun ? " (dry-run, nothing written)" : ""}`,
  );
}

// Auto-run only when invoked directly via `tsx scripts/backfill-page-hints.ts`,
// so the module can be imported by tests without triggering main().
const isDirectInvocation = (() => {
  const entry = process.argv[1] ?? "";
  return entry.includes("backfill-page-hints");
})();

if (isDirectInvocation) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[backfill-page-hints] failed:", err);
      process.exit(1);
    });
}
