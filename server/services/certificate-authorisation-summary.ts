import { roundCurrency } from "../../shared/financial-utils";

interface Certificate {
  id: number;
  contractorId: number;
  status: string;
  issuedAt?: Date | string | null;
  netToPayHt: string;
  netToPayTtc: string;
  reissuedFromCertificatId?: number | null;
  certificateTrack?: string;
}
interface Commitment {
  contractorId: number;
  devisCode: string;
  commitmentEligible: boolean;
  adjustedHt: number;
  adjustedTtc: number;
}

/** Sum period authorisations, never invoices or cumulative works.
 * Contractor grouping avoids inventing per-quotation allocations for legacy
 * and multi-quotation certificates. Receipt confirmation is irrelevant.
 */
export function certificateAuthorisationSummary(
  commitments: Commitment[],
  certificates: Certificate[],
  current: Certificate,
) {
  const groups = new Map<number, {
    contractorId: number; codes: string[]; adjustedHt: number; adjustedTtc: number;
    certifiedHt: number; certifiedTtc: number;
  }>();
  const group = (id: number) => {
    if (!groups.has(id)) groups.set(id, {
      contractorId: id, codes: [], adjustedHt: 0, adjustedTtc: 0,
      certifiedHt: 0, certifiedTtc: 0,
    });
    return groups.get(id)!;
  };
  for (const d of commitments.filter(d => d.commitmentEligible)) {
    const g = group(d.contractorId);
    g.codes.push(d.devisCode);
    g.adjustedHt += d.adjustedHt;
    g.adjustedTtc += d.adjustedTtc;
  }
  const cutoff = current.issuedAt ? new Date(current.issuedAt).getTime() : Infinity;
  for (const c of certificates) {
    if (c.certificateTrack && c.certificateTrack !== "contractor_works") continue;
    if (c.status === "superseded" || c.id === current.reissuedFromCertificatId) continue;
    if (c.id !== current.id &&
      (!c.issuedAt || new Date(c.issuedAt).getTime() > cutoff)) continue;
    const g = group(c.contractorId);
    g.certifiedHt += Number(c.netToPayHt);
    g.certifiedTtc += Number(c.netToPayTtc);
  }
  const rows = Array.from(groups.values()).map(g => ({
    ...g,
    adjustedHt: roundCurrency(g.adjustedHt),
    adjustedTtc: roundCurrency(g.adjustedTtc),
    certifiedHt: roundCurrency(g.certifiedHt),
    certifiedTtc: roundCurrency(g.certifiedTtc),
    resteARealiser: roundCurrency(g.adjustedHt - g.certifiedHt),
  }));
  const sum = (key: "adjustedHt" | "adjustedTtc" | "certifiedHt" | "certifiedTtc") =>
    roundCurrency(rows.reduce((n, r) => n + r[key], 0));
  return {
    rows,
    totalContractedHt: sum("adjustedHt"), totalContractedTtc: sum("adjustedTtc"),
    totalCertifiedHt: sum("certifiedHt"), totalCertifiedTtc: sum("certifiedTtc"),
    totalResteARealiser: roundCurrency(sum("adjustedHt") - sum("certifiedHt")),
    totalResteARealiserTtc: roundCurrency(sum("adjustedTtc") - sum("certifiedTtc")),
  };
}
