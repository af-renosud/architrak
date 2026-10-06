import { sql } from "drizzle-orm";
import { db } from "../db";
import { uploadDocument, deleteDocument } from "../storage/object-storage";
import { randomUUID } from "crypto";

export class ArchitectInvoiceError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
interface InvoiceRow {
  storage_key: string | null;
  file_name: string | null;
  frozen_at: Date | null;
}
export async function getArchitectInvoice(certId: number): Promise<InvoiceRow | undefined> {
  return (await db.execute(sql`SELECT * FROM certificat_architect_invoices WHERE certificat_id=${certId}`)).rows[0] as unknown as InvoiceRow | undefined;
}
async function context(tx: any, certId: number) {
  // Same locking order for upload/remove and preparing delivery. The project
  // row lock also serializes against archiving.
  const cert = (await tx.execute(sql`SELECT c.*,p.archived_at FROM certificats c
    JOIN projects p ON p.id=c.project_id WHERE c.id=${certId} FOR UPDATE OF c,p`)).rows[0];
  if (!cert) throw new ArchitectInvoiceError("NOT_FOUND", "Certificate not found.", 404);
  if (cert.archived_at || cert.status === "superseded")
    throw new ArchitectInvoiceError("CERTIFICATE_READ_ONLY", "This certificate is archived or superseded.");
  return cert;
}
async function communication(tx: any, certId: number) {
  return (await tx.execute(sql`SELECT status FROM project_communications WHERE related_certificat_id=${certId}
    AND type='certificat_sent' ORDER BY (status='sent') DESC,id DESC LIMIT 1`)).rows[0];
}
export async function architectInvoiceStatus(certId: number) {
  const cert = (await db.execute(sql`SELECT c.id,c.status,p.archived_at FROM certificats c JOIN projects p ON p.id=c.project_id WHERE c.id=${certId}`)).rows[0];
  if (!cert) throw new ArchitectInvoiceError("NOT_FOUND", "Certificate not found.", 404);
  const invoice = await getArchitectInvoice(certId);
  const comm = await communication(db, certId);
  return {
    attached: Boolean(invoice?.storage_key),
    fileName: invoice?.file_name ?? null,
    locked: Boolean(invoice?.frozen_at || comm || cert.archived_at || cert.status === "superseded"),
    deliveryStatus: comm?.status ?? (invoice?.frozen_at ? "prepared" : null),
    sentWithInvoice: comm?.status === "sent" && invoice?.frozen_at ? Boolean(invoice.storage_key) : null,
    historicalDeliveryUnknown: comm?.status === "sent" && !invoice?.frozen_at,
  };
}
/** Store original bytes only. The financial certificate/PDF is not changed. */
export async function replaceArchitectInvoice(certId: number, file: { buffer: Buffer; originalname: string } | null, userId: number) {
  const fileName = file ? file.originalname.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(-150).replace(/\.pdf$/i, "") + ".pdf" : null;
  let newKey: string | null = null;
  let oldKey: string | null = null;
  try {
    await db.transaction(async tx => {
      const cert = await context(tx, certId);
      const current = (await tx.execute(sql`SELECT * FROM certificat_architect_invoices WHERE certificat_id=${certId}`)).rows[0];
      if (current?.frozen_at || await communication(tx, certId))
        throw new ArchitectInvoiceError("DELIVERY_LOCKED", "Attachments are locked once delivery is prepared. The delivery record must stay accurate.");
      oldKey = current?.storage_key as string ?? null;
      if (file) newKey = await uploadDocument(cert.project_id, `architect-invoice-${certId}-${randomUUID()}-${fileName}`, file.buffer, "application/pdf");
      await tx.execute(sql`INSERT INTO certificat_architect_invoices (certificat_id,storage_key,file_name,uploaded_at,uploaded_by)
        VALUES (${certId},${newKey},${fileName},${file ? new Date() : null},${userId})
        ON CONFLICT (certificat_id) DO UPDATE SET storage_key=EXCLUDED.storage_key,file_name=EXCLUDED.file_name,
        uploaded_at=EXCLUDED.uploaded_at,uploaded_by=EXCLUDED.uploaded_by`);
    });
  } catch (e) {
    if (newKey) await deleteDocument(newKey).catch(() => {});
    throw e;
  }
  // Old object is no longer referenced; concurrent replacement uses a distinct
  // UUID key, so this cannot delete a newer upload or a frozen delivery.
  if (oldKey) await deleteDocument(oldKey).catch(() => {});
  return architectInvoiceStatus(certId);
}
export async function requireArchitectInvoiceConfirmation(certId: number, confirmed: boolean) {
  const current = await getArchitectInvoice(certId);
  if (!current?.storage_key && !current?.frozen_at && !confirmed) {
    throw new ArchitectInvoiceError("ARCHITECT_INVOICE_CONFIRMATION_REQUIRED",
      "No architect’s invoice is attached. Attach the externally prepared PDF, or confirm sending without it.");
  }
}
/** Freeze exactly what will be sent, including an explicit no-invoice decision.
 * Retries use this same snapshot. No edit can race past this certificate lock. */
export async function reserveArchitectInvoiceDelivery(certId: number, confirmed: boolean, userId?: number): Promise<InvoiceRow | undefined> {
  return db.transaction(async tx => {
    await context(tx, certId);
    const current = (await tx.execute(sql`SELECT * FROM certificat_architect_invoices WHERE certificat_id=${certId}`)).rows[0] as unknown as InvoiceRow | undefined;
    if (current?.frozen_at) return current;
    const prior = await communication(tx, certId);
    // Do not invent attachment evidence for historical sends.
    if (prior?.status === "sent") return undefined;
    if (!current?.storage_key && !confirmed)
      throw new ArchitectInvoiceError("ARCHITECT_INVOICE_CONFIRMATION_REQUIRED", "No architect’s invoice is attached. Confirm sending without it.");
    const result = await tx.execute(sql`INSERT INTO certificat_architect_invoices
      (certificat_id,frozen_at,prepared_by,confirmed_without_invoice)
      VALUES (${certId},NOW(),${userId ?? null},true)
      ON CONFLICT (certificat_id) DO UPDATE SET frozen_at=NOW(),prepared_by=${userId ?? null},
      confirmed_without_invoice=(certificat_architect_invoices.storage_key IS NULL)
      RETURNING *`);
    return result.rows[0] as unknown as InvoiceRow;
  });
}

export function assertArchitectInvoiceAttached(snapshot: InvoiceRow | undefined, keys: string[]) {
  if (snapshot?.frozen_at && snapshot.storage_key && !keys.includes(snapshot.storage_key)) {
    throw new ArchitectInvoiceError("ARCHITECT_INVOICE_ATTACHMENT_MISSING", "The prepared architect invoice is missing from this email. Sending has been stopped.");
  }
}
