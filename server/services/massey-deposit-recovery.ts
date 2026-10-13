/**
 * Reviewed one-off legacy relationship, not an amount-based general matcher.
 * The operator identified this exact C1 as the same opening deposit and
 * confirmed its external architect invoice was prepared only, not sent/paid.
 * All other financial/delivery/version guards still apply at commit.
 */
export function isReviewedMasseyDepositRelationship(invoice: any, certificate: any) {
  return invoice.id === 6 && invoice.projectId === 12 && invoice.devisId === 34 &&
    invoice.contractorId === 37 && invoice.sourceIntakeDocumentId === 114 &&
    invoice.invoiceNumber === "DV260940" &&
    invoice.aiExtractedData?.relationshipResolution?.sourceFingerprint ===
      "291081ba2e570b1cc57ad7272956ad2b4b778b491bfe139fdf9fde76bd7f5cbf" &&
    certificate.id === 5 && certificate.projectId === 12 && certificate.contractorId === 37 &&
    certificate.certificateRef === "C1" && Number(certificate.totalWorksHt) === 19002 &&
    Number(certificate.retenueGarantie) === 950.10 && Number(certificate.tvaAmount) === 1805.19 &&
    Number(certificate.previousPayments) === 0;
}
