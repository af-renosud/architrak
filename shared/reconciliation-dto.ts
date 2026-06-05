/**
 * Task #233 — API DTOs for the Needs Review anomaly-resolution surface.
 *
 * These are wire shapes returned by `GET /api/projects/:projectId/overlap-cases`
 * and consumed by the per-project review UI. Defined in `shared/` so the server
 * builder and the React client agree on one type (zero-tolerance TS: no drift).
 *
 * Banking / sensitive fields are NEVER included here (mirrors the portal
 * whitelist convention) — only the financial figures and document codes the
 * architect needs to make a confirm/keep-separate decision.
 */
import type {
  AccountingState,
  OverlapDetectionSource,
  OverlapRelationshipType,
  OverlapVerdict,
} from "./schema";

/** Lightweight per-devis summary shown side-by-side on a decision card. */
export interface ReviewDevisSummary {
  id: number;
  devisCode: string;
  contractorId: number;
  contractorName: string;
  descriptionFr: string;
  amountHt: string;
  amountTtc: string;
  accountingState: AccountingState;
}

/** A single citation to a source line behind the overlap suggestion. */
export interface OverlapCitation {
  devisId: number;
  devisCode: string | null;
  lineNumber: number | null;
  description: string;
  totalHt: string | null;
}

/** The arithmetic proof figures (in integer cents) behind a case. */
export interface OverlapArithmeticProof {
  primaryCents: number;
  memberCents: number[];
  sumCents: number;
  deltaCents: number;
  reconciles: boolean;
}

/** An open case requiring a human confirm / keep-separate decision. */
export interface ReviewCard {
  id: number;
  relationshipType: OverlapRelationshipType;
  detectionSource: OverlapDetectionSource;
  confidence: string;
  verdict: OverlapVerdict;
  reasoning: string | null;
  arithmeticProof: OverlapArithmeticProof | null;
  citations: OverlapCitation[];
  /** Euros that confirming would remove from Contracted (active members only). */
  impactEuros: number;
  primary: ReviewDevisSummary | null;
  members: ReviewDevisSummary[];
  lastSeenAt: string;
}

/** A case an architect has already ruled on — shown in the audit accordion. */
export interface ResolvedReviewCard {
  id: number;
  relationshipType: OverlapRelationshipType;
  reasoning: string | null;
  primary: ReviewDevisSummary | null;
  members: ReviewDevisSummary[];
  decision: "confirm" | "dismiss";
  decidedAt: string;
  actorEmail: string | null;
  note: string | null;
}

export interface ProjectReviewCasesResponse {
  projectId: number;
  openCases: ReviewCard[];
  resolvedCases: ResolvedReviewCard[];
}
