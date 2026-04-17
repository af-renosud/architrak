import { db } from "../db";
import { documentAdvisories, type DocumentAdvisory } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import {
  deriveAdvisoryCode,
  type ValidatorWarningLike,
  type AdvisorySource,
} from "@shared/advisory-codes";

export interface ReconcileSubject {
  devisId?: number;
  invoiceId?: number;
}

export interface ReconcileResult {
  inserted: number;
  resolved: number;
  unchanged: number;
}

export async function reconcileAdvisories(
  subject: ReconcileSubject,
  warnings: ValidatorWarningLike[],
  source: AdvisorySource = "ai_extraction",
): Promise<ReconcileResult> {
  if (!subject.devisId && !subject.invoiceId) {
    throw new Error("reconcileAdvisories requires devisId or invoiceId");
  }
  if (subject.devisId && subject.invoiceId) {
    throw new Error("reconcileAdvisories: provide only one of devisId/invoiceId");
  }

  const subjectFilter = subject.devisId
    ? eq(documentAdvisories.devisId, subject.devisId)
    : eq(documentAdvisories.invoiceId, subject.invoiceId!);

  const desired = new Map<string, ValidatorWarningLike>();
  for (const w of warnings) {
    const code = deriveAdvisoryCode(w);
    if (!desired.has(code)) desired.set(code, w);
  }

  let inserted = 0;
  let resolved = 0;
  let unchanged = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(documentAdvisories)
      .where(subjectFilter)
      .for("update");

    const existingByCode = new Map<string, DocumentAdvisory>();
    for (const a of existing) existingByCode.set(a.code, a);

    for (const [code, w] of Array.from(desired.entries())) {
      const prior = existingByCode.get(code);
      if (!prior) {
        await tx.insert(documentAdvisories).values({
          devisId: subject.devisId ?? null,
          invoiceId: subject.invoiceId ?? null,
          code,
          field: w.field ?? null,
          severity: w.severity,
          message: w.message,
          source,
        });
        inserted++;
        continue;
      }
      if (prior.acknowledgedAt) {
        unchanged++;
        continue;
      }
      if (prior.resolvedAt) {
        await tx
          .update(documentAdvisories)
          .set({
            resolvedAt: null,
            raisedAt: now,
            message: w.message,
            severity: w.severity,
            field: w.field ?? null,
            source,
          })
          .where(eq(documentAdvisories.id, prior.id));
        inserted++;
        continue;
      }
      if (prior.message !== w.message || prior.severity !== w.severity) {
        await tx
          .update(documentAdvisories)
          .set({ message: w.message, severity: w.severity })
          .where(eq(documentAdvisories.id, prior.id));
      }
      unchanged++;
    }

    for (const a of existing) {
      if (desired.has(a.code)) continue;
      if (a.resolvedAt) continue;
      if (a.acknowledgedAt) continue;
      await tx
        .update(documentAdvisories)
        .set({ resolvedAt: now })
        .where(eq(documentAdvisories.id, a.id));
      resolved++;
    }
  });

  return { inserted, resolved, unchanged };
}

export async function getAdvisoriesForDevis(devisId: number): Promise<DocumentAdvisory[]> {
  return db
    .select()
    .from(documentAdvisories)
    .where(eq(documentAdvisories.devisId, devisId))
    .orderBy(documentAdvisories.id);
}

export async function getAdvisoriesForInvoice(invoiceId: number): Promise<DocumentAdvisory[]> {
  return db
    .select()
    .from(documentAdvisories)
    .where(eq(documentAdvisories.invoiceId, invoiceId))
    .orderBy(documentAdvisories.id);
}

export async function acknowledgeAdvisory(
  id: number,
  acknowledgedBy: string | null,
): Promise<DocumentAdvisory | undefined> {
  const [row] = await db
    .update(documentAdvisories)
    .set({
      acknowledgedAt: new Date(),
      acknowledgedBy: acknowledgedBy ?? null,
      resolvedAt: new Date(),
    })
    .where(and(eq(documentAdvisories.id, id), isNull(documentAdvisories.acknowledgedAt)))
    .returning();
  return row;
}

