import { storage } from "../storage";
import type { CertificatPaymentMutationResult } from "../storage";
import { computeCertificatPaymentState, type CertificatPaymentState } from "@shared/financial-utils";
import type { Certificat, CertificatPayment, InsertCertificatPayment } from "@shared/schema";

/**
 * Task #465 — structured client-payment logging.
 *
 * The ledger records FACTS (payments received): partial payments accumulate
 * and the certificat flips to `paid` automatically — and ONLY — when the
 * cumulative logged amount covers net_to_pay_ttc (roundCurrency compare).
 * Entries stay correctable while the certificat is not fully paid; once
 * coverage is reached the ledger locks. Every mutation writes an
 * append-only audit row with the pre-change snapshot.
 *
 * Concurrency: all invariants are enforced INSIDE the storage transaction
 * (certificat row lock + precondition re-check + payment + audit +
 * conditional paid flip — see storage.createCertificatPaymentAtomic and
 * friends). This service maps the discriminated outcomes onto typed errors.
 *
 * Grandfathering: certificats already `paid` by status alone (no payment
 * rows) stay readable as paid; the ledger locks on ACTUAL coverage only,
 * so a grandfathered cert can still receive its historical entries.
 *
 * Draft policy: payments are facts about ISSUED certificats — drafts are
 * refused server-side (the UI hides the ledger for drafts).
 */

export class PaymentsLockedError extends Error {
  constructor(ref: string) {
    super(`Le certificat ${ref} est intégralement payé — le journal des paiements est verrouillé.`);
    this.name = "PaymentsLockedError";
  }
}

export class CertificatSupersededPaymentError extends Error {
  constructor(ref: string) {
    super(`Le certificat ${ref} a été remplacé par une réédition — les paiements se saisissent sur le certificat actif.`);
    this.name = "CertificatSupersededPaymentError";
  }
}

export class CertificatDraftPaymentError extends Error {
  constructor(ref: string) {
    super(`Le certificat ${ref} est encore un brouillon — les paiements s'enregistrent sur un certificat émis.`);
    this.name = "CertificatDraftPaymentError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor() {
    super("Paiement introuvable.");
    this.name = "PaymentNotFoundError";
  }
}

export function reconcilePayments(cert: Certificat, payments: CertificatPayment[]): CertificatPaymentState {
  return computeCertificatPaymentState(
    parseFloat(cert.netToPayTtc),
    payments.map((p) => parseFloat(p.amount)),
  );
}

function unwrap<T extends CertificatPaymentMutationResult>(result: T): Extract<T, { outcome: "ok" }> {
  switch (result.outcome) {
    case "ok":
      return result as Extract<T, { outcome: "ok" }>;
    case "not_found":
      throw new PaymentNotFoundError();
    case "superseded":
      throw new CertificatSupersededPaymentError(result.cert.certificateRef);
    case "draft":
      throw new CertificatDraftPaymentError(result.cert.certificateRef);
    case "locked":
      throw new PaymentsLockedError(result.cert.certificateRef);
  }
}

export async function logPayment(
  certificatId: number,
  entry: InsertCertificatPayment,
): Promise<{ payment: CertificatPayment; state: CertificatPaymentState }> {
  const result = unwrap(await storage.createCertificatPaymentAtomic(certificatId, entry));
  return { payment: (result as { payment: CertificatPayment }).payment, state: result.state };
}

export async function correctPayment(
  paymentId: number,
  patch: Partial<InsertCertificatPayment>,
  changedBy?: string | null,
): Promise<{ payment: CertificatPayment; state: CertificatPaymentState }> {
  const result = unwrap(await storage.updateCertificatPaymentAtomic(paymentId, patch, changedBy ?? null));
  return { payment: (result as { payment: CertificatPayment }).payment, state: result.state };
}

export async function removePayment(
  paymentId: number,
  changedBy?: string | null,
): Promise<{ state: CertificatPaymentState }> {
  const result = unwrap(await storage.deleteCertificatPaymentAtomic(paymentId, changedBy ?? null));
  return { state: result.state };
}
