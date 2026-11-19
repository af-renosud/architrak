import { createHash } from "node:crypto";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { contractorExternalDeliveries, devis, projects, type Devis } from "@shared/schema";
import { signedCopyInactive } from "./signed-copy-provenance";

export const externalDeliveryBody = z.object({
  requestId: z.string().uuid(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  sentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
      && value <= new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  }, "Enter a valid delivery date, not in the future."),
  method: z.enum(["email", "whatsapp", "post", "hand", "other"]),
  recipient: z.string().trim().min(1).max(300),
  note: z.string().trim().max(2000).default(""),
  confirmed: z.literal(true),
}).strict();

// Identity follows the signature/document, not editable translation or email details.
// No claim is made that this document was verified or sent by the email provider.
export function externalDeliveryVersion(d: Devis): string {
  return createHash("sha256").update(JSON.stringify([
    d.id, d.projectId, d.contractorId, d.signOffStage, d.signedOffVia,
    d.archisignEnvelopeId, d.signedPdfStorageKey, d.signedPdfArchisignEnvelopeId,
    d.manualSignoffAt, d.manualSignoffBy, d.manualSignoffNote, d.manualSignoffExternalRef,
  ])).digest("hex");
}

export function externalDeliveryEligible(d: Devis, archived: boolean): boolean {
  return !archived && !signedCopyInactive(d) && d.signOffStage === "client_signed_off" && !!d.contractorId;
}

export async function listExternalDeliveries(d: Devis) {
  const rows = await db.select().from(contractorExternalDeliveries)
    .where(eq(contractorExternalDeliveries.devisId, d.id)).orderBy(desc(contractorExternalDeliveries.id));
  const version = externalDeliveryVersion(d);
  return rows.map(({ documentVersion, requestId, ...row }) => ({
    ...row, currentDocument: documentVersion === version,
  }));
}

export async function recordExternalDelivery(devisId: number, actor: number, raw: unknown) {
  const input = externalDeliveryBody.parse(raw);
  return db.transaction(async tx => {
    const [d] = await tx.select().from(devis).where(eq(devis.id, devisId)).for("update");
    if (!d) throw new Error("Quotation not found.");
    const [project] = await tx.select().from(projects).where(eq(projects.id, d.projectId)).for("share");
    if (!project || !externalDeliveryEligible(d, !!project.archivedAt)) {
      throw new Error("Only a current signed quotation in an active project can be recorded as sent.");
    }
    const [existing] = await tx.select().from(contractorExternalDeliveries)
      .where(eq(contractorExternalDeliveries.requestId, input.requestId));
    if (existing) {
      if (existing.devisId !== devisId || existing.recordedBy !== actor ||
          existing.documentVersion !== input.expectedVersion || existing.sentOn !== input.sentOn ||
          existing.method !== input.method || existing.recipient !== input.recipient || existing.note !== input.note) {
        throw new Error("This confirmation was already used for different delivery details.");
      }
      return existing;
    }
    if (externalDeliveryVersion(d) !== input.expectedVersion) {
      throw new Error("The signed quotation changed. Close and reopen the delivery panel, then review it again.");
    }
    const [saved] = await tx.insert(contractorExternalDeliveries).values({
      devisId, recordedBy: actor, documentVersion: input.expectedVersion,
      requestId: input.requestId, sentOn: input.sentOn, method: input.method,
      recipient: input.recipient, note: input.note,
    }).returning();
    return saved;
  });
}
