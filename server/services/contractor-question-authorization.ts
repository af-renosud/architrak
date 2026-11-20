import { createHash } from "node:crypto";
import type { DevisCheck } from "@shared/schema";

const unresolved = new Set(["open", "awaiting_contractor", "awaiting_architect"]);

/** Stable, quotation-bound receipt. Counts alone cannot detect edited/replaced questions. */
export function contractorQuestionSnapshot(devisId: number, checks: DevisCheck[]) {
  const questions = checks.filter(c => unresolved.has(c.status))
    .sort((a, b) => a.id - b.id)
    .map(c => ({
      id: c.id, devisId: c.devisId, query: c.query, status: c.status,
      origin: c.origin, lineItemId: c.lineItemId,
      resolutionNote: c.resolutionNote,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      createdByUserId: c.createdByUserId,
      resolvedAt: c.resolvedAt, resolvedByUserId: c.resolvedByUserId,
    }));
  const fullSnapshot = { version: 1, devisId, questions };
  return {
    snapshot: createHash("sha256").update(JSON.stringify(fullSnapshot)).digest("hex"),
    fullSnapshot,
    openCount: questions.length,
  };
}

export interface SignatureQuestionReceipt {
  quotationContentVersion?: string;
  envelopeId: string;
  snapshot: string;
  fullSnapshot: ReturnType<typeof contractorQuestionSnapshot>["fullSnapshot"];
  authorization: { reason: string; actorId: number; actorEmail: string; authorizedAt: string } | null;
}
