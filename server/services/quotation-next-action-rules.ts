import type { Certificat, CertificatPayment, Devis } from "@shared/schema";
import type { QuotationNextAction, QuotationNextActions } from "@shared/quotation-next-actions";
import { hasRecordedSignature } from "@shared/devis-stage-recovery";
import { computeCertificatPaymentState } from "@shared/financial-utils";
import type { DevisReadiness } from "./devis-readiness";

export interface CertificateActionEvidence {
  certificate: Certificat;
  deposit: boolean;
  payments: CertificatPayment[];
  delivered: boolean;
  pendingEvidence: boolean;
  failedDelivery: boolean;
  pendingDelivery?: boolean;
}
export interface QuotationActionEvidence {
  devis: Devis;
  archived: boolean;
  readiness?: DevisReadiness;
  certificates: CertificateActionEvidence[];
  unscopedCertificate?: Certificat;
}
const terminal = new Set(["void", "cancelled", "superseded"]);
const money = (value: unknown): value is string =>
  typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value) && Number.isFinite(Number(value));

/** Read-only presentation rules. Current mutation guards always recheck eligibility. */
export function deriveQuotationNextActions(input: QuotationActionEvidence): QuotationNextActions {
  const { devis: d, readiness: r } = input;
  const actions: QuotationNextAction[] = [];
  const result = () => ({
    devisId: d.id,
    actions: actions.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id)),
    actionable: actions.some(a => a.actor === "architect" && a.tone !== "unknown"),
  });
  if (input.archived || terminal.has(d.status) || d.signOffStage === "void" || d.accountingState === "superseded") return result();
  const href = `/projets/${d.projectId}?tab=devis&devis=${d.id}`;
  const add = (code: string, label: string, why: string, nextStep: string,
    opts: Partial<QuotationNextAction> = {}) => {
    actions.push({ id: `${d.id}:${code}`, code, label, why, nextStep, actor: "architect",
      tone: "action", priority: 50, devisId: d.id, href, ...opts });
  };
  const certs = input.certificates.filter(e => !terminal.has(e.certificate.status));
  for (const evidence of certs) {
    const { certificate: c, payments, delivered, pendingEvidence, failedDelivery } = evidence;
    const base: Partial<QuotationNextAction> = {
      id: `${d.id}:certificate:${c.id}`, certificateId: c.id, certificateRef: c.certificateRef,
      href: `/certificats?projectId=${d.projectId}&certificatId=${c.id}`, priority: 30,
    };
    const deposit = evidence.deposit;
    const name = deposit ? "deposit certificate" : "certificate";
    if (!money(c.netToPayTtc) || payments.some(p => !money(p.amount))) {
      add("payment_unknown", "Check certificate figures", "The recorded figures cannot be reconciled safely.",
        "Open the certificate and review its figures before making a payment decision.", { ...base, actor: "system", tone: "unknown" });
      continue;
    }
    const state = computeCertificatPaymentState(Number(c.netToPayTtc), payments.map(p => Number(p.amount)));
    if (state.fullyPaid) continue;
    // Legacy status-only paid rows must never become a fresh demand for payment.
    if (c.status === "paid" || (deposit && ["paid", "applied"].includes(d.acompteState))) {
      add("legacy_paid", "Payment record needs reconciliation",
        "The certificate or deposit is marked paid, but the certificate payment entries do not fully cover the recorded amount.",
        "Review the existing payment evidence. Do not request another payment on this basis.",
        { ...base, actor: "system", tone: "unknown" });
      continue;
    }
    if (!["draft", "ready", "sent"].includes(c.status)) {
      add("certificate_unknown", "Certificate status needs review", "The certificate has an unrecognised workflow state.",
        "Open the certificate to check its current status.", { ...base, actor: "system", tone: "unknown" });
      continue;
    }
    if (c.status === "draft") {
      add("review_certificate", `Review ${name}`, "A draft exists but has not been issued.",
        "Review the figures and banking details, then use the existing Ready action.", base);
      continue;
    }
    const financial = { ...base, outstandingTtc: state.outstanding.toFixed(2) };
    if (pendingEvidence) {
      add("verify_payment", "Verify payment evidence", "An unreviewed payment reply is linked to this certificate. It is not yet a recorded payment.",
        "Open the certificate and review the payment evidence before confirming or dismissing it.", { ...financial, priority: 10 });
      // Do not encourage a second demand while a payment report awaits review.
      continue;
    }
    if (delivered) {
      add("await_payment", "Awaiting client payment", "The certificate was emailed successfully and the ledger still shows an outstanding balance.",
        "Review the payment record if new evidence arrives. Do not record a payment without evidence.",
        { ...financial, actor: "client", tone: "waiting", priority: 90 });
    } else if (evidence.pendingDelivery) {
      add("delivery_pending", "Certificate email in progress", "The certificate email is queued or being sent, and delivery has not yet been confirmed.",
        "Wait for the existing send attempt to finish. Check its delivery history rather than starting another send.",
        { ...financial, actor: "system", tone: "waiting", priority: 85 });
    } else if (failedDelivery) {
      add("delivery_failed", "Review failed certificate email", "A certificate email failed and there is no successful delivery record.",
        "Open the certificate and check the delivery issue before using the existing send flow.",
        { ...financial, tone: "blocked", priority: 5 });
    } else {
      add("send_certificate", `Send ${name}`, "The certificate is ready but has no successful client-email delivery record.",
        "Open the certificate, review it and use the existing Send action.", financial);
    }
  }

  const signed = hasRecordedSignature(d) || d.status === "signed";
  if (signed) {
    const hasDepositCertificate = certs.some(c => c.deposit);
    if (d.acompteRequired && ["pending", "invoiced"].includes(d.acompteState) && !hasDepositCertificate && input.unscopedCertificate) {
      const c = input.unscopedCertificate;
      add("deposit_scope_unknown", "Check existing certificate scope",
        "An active certificate for this contractor has no explicit quotation links, so a separate deposit certificate cannot safely be suggested.",
        "Review the existing certificate and deposit history before creating another.",
        { actor: "system", tone: "unknown", certificateId: c.id, certificateRef: c.certificateRef,
          href: `/certificats?projectId=${d.projectId}&certificatId=${c.id}` });
    } else if (d.acompteRequired && !["none", "paid", "applied", "invoiced"].includes(d.acompteState) && !hasDepositCertificate) {
      if (d.acompteState !== "pending") {
        add("deposit_unknown", "Deposit status needs review", "The deposit state is not recognised.",
          "Review the quotation's deposit details.", { actor: "system", tone: "unknown", target: "deposit" });
      } else if (d.signOffStage !== "client_signed_off") {
        add("restore_signed_stage", "Review signed quotation stage", "Signature evidence exists, but the workflow has been moved back.",
          "Review the existing signed copy and restore the signed stage if appropriate. Do not send a new signature request.",
          { target: "stage", priority: 40 });
      } else if (!((money(d.acompteAmountHt) && Number(d.acompteAmountHt) > 0) ||
          (money(d.acomptePercent) && Number(d.acomptePercent) > 0 && Number(d.acomptePercent) <= 100 &&
            money(d.amountHt) && Number(d.amountHt) > 0))) {
        add("review_deposit_amount", "Review deposit amount",
          "The deposit is pending, but a valid positive deposit amount or percentage could not be established.",
          "Open the quotation and edit its deposit settings before generating a certificate.", { priority: 40 });
      } else {
        add("prepare_deposit", "Prepare deposit certificate", "The quotation is signed and its deposit is pending, with no linked active certificate.",
          "Review the deposit details and use Generate Certificate. A separate confirmation is required.",
          { target: "deposit", priority: 40 });
      }
    } else if (d.acompteRequired && d.acompteState === "invoiced" && !hasDepositCertificate) {
      add("review_deposit_invoice", "Review deposit invoice", "A deposit invoice is linked, but no explicitly linked active certificate was found.",
        "Review the invoice and its certificate workflow before creating anything.",
        { href: `/projets/${d.projectId}?tab=factures${d.acompteInvoiceId ? `&invoice=${d.acompteInvoiceId}` : ""}`, priority: 40 });
    }
    return result(); // Signing/translation readiness is irrelevant after signing.
  }
  if (!r) {
    add("readiness_unknown", "Signing checks unavailable", "Current signing readiness could not be established.",
      "Refresh the quotation checks before deciding what to do.", { actor: "system", tone: "unknown", target: "signature" });
  } else if (["sent", "viewed", "queried"].includes(r.signature)) {
    add("await_signature", r.signature === "queried" ? "Review client signing query" : "Awaiting client signature",
      r.signature === "queried" ? "The signature service reports a client query." : "A signature request has already been sent.",
      "Open the existing signature request to review its status.",
      { actor: r.signature === "queried" ? "architect" : "client", tone: r.signature === "queried" ? "action" : "waiting", priority: 90, target: "signature" });
  } else if (["declined", "expired"].includes(r.signature)) {
    add("signature_issue", "Review signature request", "The existing signature request was declined or expired.",
      "Review its history before deciding whether to prepare another request.", { target: "signature", priority: 45 });
  } else if (r.readyToSend) {
    add("prepare_signature", "Prepare signature request", "The local signing checklist is complete.",
      "Review the document and client message. Live safeguards are checked again before sending.", { target: "signature", priority: 60 });
  } else {
    const issue = r.issues?.find(i => i.severity === "blocker");
    if (issue) {
      const target = issue.target.field === "lotId" ? "lot" : issue.target.field === "descriptionUk" ? "description"
        : issue.target.section === "translation" ? "translation"
        : ["source", "financial"].includes(issue.target.section) ? "source" : "signature";
      add(issue.code, target === "source" ? "Review quotation source or figures" : target === "translation" ? "Review translation" : "Review signing requirements",
        issue.message, "Open the indicated section, resolve the listed requirement, then review again.",
        { target, priority: 60, tone: issue.code === "VERIFICATION_UNAVAILABLE" ? "unknown" : "blocked" });
      return result();
    }
    // One existing checklist contains all prerequisites; don't duplicate every advisory.
    add("review_signing", "Review signing requirements", "The local signing checklist still has items to review.",
      "Open the checklist to resolve prerequisites or review an available architect authorisation.",
      { target: "signature", priority: 60 });
  }
  return result();
}
