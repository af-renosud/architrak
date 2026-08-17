/**
 * Task #563 — read-side enrichment for the design-contract card.
 *
 * Milestones invoiced through a confirmed architect-fee-invoice evidence
 * row carry a linked fee entry, whose `pennylaneInvoiceNumber` (human
 * number captured at push time, e.g. "F-2026-138") — or the legacy
 * hand-typed `pennylaneInvoiceRef` — identifies the Pennylane invoice.
 * The number stays mastered on the fee entry; here we only read it
 * through the evidence link and attach it to the milestone payload.
 */
import { storage } from "../storage";
import type { DesignContractMilestone } from "@shared/schema";

export type MilestoneWithPennylane = DesignContractMilestone & {
  pennylaneInvoiceNumber: string | null;
};

export async function getMilestonesWithPennylane(
  contractId: number,
): Promise<MilestoneWithPennylane[]> {
  const milestones = await storage.getDesignContractMilestones(contractId);
  const numbers = await storage.getMilestonePennylaneNumbers(milestones.map((m) => m.id));
  return milestones.map((m) => ({
    ...m,
    pennylaneInvoiceNumber: numbers.get(m.id) ?? null,
  }));
}
