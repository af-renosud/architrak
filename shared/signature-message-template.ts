/**
 * Task #280 — pure builder for the pre-filled client message shown in the
 * SigningPanel "send for signature" dialog. The architect can rewrite the
 * text entirely before sending; this is only the default template.
 *
 * Lives in shared/ so the server-side English-copy regression test
 * (server/__tests__/client-english-copy.test.ts) can assert it never
 * drifts back to French. `descriptionFr` is the devis' French lot
 * description — a domain value interpolated as-is, not UI copy.
 */
/**
 * Task #442 — fixed, server-guaranteed payment warning appended to every
 * client-facing devis signing message (Archisign envelope body AND the
 * ArchiTrak context email). Lives in shared/ so both the server builders
 * and the English-copy regression guard use the exact same string. It is
 * intentionally NOT part of the editable prefill template below: the
 * server appends it outside the architect's text so it can never be
 * edited away (and never shows twice).
 */
export const CLIENT_NO_PAYMENT_NOTICE =
  "Don't pay anything now. At this stage, you are only authorising the quotation. " +
  "Payment instructions will follow.";

export interface ClientSignatureMessageTemplateInput {
  refLabel: string;
  descriptionFr: string | null | undefined;
  /** Pre-formatted amount label, e.g. "9 435,84" (fr-FR number format kept by convention). */
  amountTtcLabel: string | null | undefined;
  projectName: string | null | undefined;
  clientContactName: string | null | undefined;
}

export function buildClientSignatureMessageTemplate({
  refLabel,
  descriptionFr,
  amountTtcLabel,
  projectName,
  clientContactName,
}: ClientSignatureMessageTemplateInput): string {
  const clientName = (clientContactName ?? "").trim();
  const description = (descriptionFr ?? "").trim();
  const amount = (amountTtcLabel ?? "").trim();
  const project = (projectName ?? "").trim();
  const greeting = clientName ? `Dear ${clientName},` : "Dear Sir or Madam,";
  const descriptionPart = description ? ` (${description})` : "";
  const amountPart = amount ? ` for ${amount} € TTC` : "";
  const projectPart = project ? ` on project "${project}"` : "";
  return (
    `${greeting}\n\n` +
    `Devis ${refLabel}${descriptionPart}${amountPart}${projectPart} is ready for electronic signature.\n\n` +
    `You will shortly receive a separate email from Archisign containing the secure signing link. ` +
    `Please do not hesitate to contact me with any questions.\n\n` +
    `Kind regards,`
  );
}
