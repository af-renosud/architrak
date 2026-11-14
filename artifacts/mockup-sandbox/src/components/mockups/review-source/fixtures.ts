// Sandbox-only API boundary, response shapes from use-quotation-extraction-review.ts.
import { useState } from "react";

export const reviewOutcomes = {
  confirmed_inaccurate: "Confirmed inaccurate", unresolved: "Unresolved",
  false_alarm: "False alarm", corrected: "Corrected",
} as const;
export const reviewCategories = {
  missing_text: "Missing text", wrong_association: "Wrong association",
  quantities: "Quantities", prices: "Prices", totals: "Totals", other: "Other",
} as const;
export interface ExtractionReviewRequest {
  outcome: keyof typeof reviewOutcomes;
  category: keyof typeof reviewCategories;
  reason: string;
  effortMinutes: number;
}
export interface ExtractionCandidateApplyRequest {
  attemptId: number; reason: string; reviewedOriginal: true; initialDifferencesAreOcrErrors: true;
}
export interface ExtractionReviewEvent {
  id: number | string; created_at: string; kind: string;
  outcome: string | null; category: string | null; reason: string | null; effort_minutes: number | null;
}
export const fixture = {
  projectId: "villa-sophia",
  devis: { id: 580, devisCode: "DVP0000580", status: "pending", driveWebViewLink: "#drive" },
  lines: [
    ["Installation de chantier et protections", "1", "forfait", "850.00"],
    ["Implantation du bassin", "1", "forfait", "450.00"],
    ["Terrassement en pleine masse", "48", "m³", "2880.00"],
    ["Évacuation des terres en décharge", "48", "m³", "1920.00"],
    ["Radier béton armé", "32", "m²", "3840.00"],
    ["Élévation des parois du bassin", "36", "m²", "5400.00"],
    ["Escalier d’angle maçonné", "1", "u", "1250.00"],
    ["Enduit d’étanchéité", "68", "m²", "2380.00"],
    ["Liner armé 150/100, coloris sable", "68", "m²", "5304.00"],
    ["Margelles en pierre reconstituée", "24", "ml", "2040.00"],
    ["Pièces à sceller et skimmers", "1", "ens", "1450.00"],
    ["Réseau hydraulique et raccordements", "1", "ens", "1800.00"],
    ["Filtration et traitement automatique", "1", "ens", "3200.00"],
    ["Éclairage LED submersible", "4", "u", "840.00"],
    ["Volet roulant immergé motorisé", "1", "u", "6482.06"],
    ["Mise en eau et mise en service", "1", "forfait", "900.00"],
  ].map(([description, quantity, unit, totalHt], index) => ({
    id: 58001 + index, devisId: 580, lineNumber: index + 1, description, quantity, unit,
    unitPriceHt: (Number(totalHt) / Number(quantity)).toFixed(2), totalHt,
  })),
  evidence: { quotationVerification: {
    manifest: { segments: [], sections: [] }, failures: [], coverage: { issues: [] },
    initialComparison: [], proposedLineItems: [],
  } },
  events: [{
    id: 1, created_at: "2026-04-18T10:25:00.000Z", kind: "extraction_processed",
    outcome: null, category: null,
    reason: "Quotation extraction completed. Compare the 16 extracted rows with the original contractor PDF before recording a review.",
    effort_minutes: 0,
  }] as ExtractionReviewEvent[],
  monitoring: {
    processed: 9, reviewed: 0, inaccurate: 0, repeatFailures: 0, effortMinutes: 0,
    categories: [] as Array<{ category: string; count: number }>,
  },
};

// Keep source links visible without a main-app dependency. The document route
// is intercepted by the extraction root below instead of issuing an API request.
export function useQuotationExtractionReview(_devisId: number, _days: 7 | 30 | 90, _projectId: string) {
  const [events, setEvents] = useState(fixture.events);
  const [error, setError] = useState<Error | null>(null);
  const recorded = events.filter(event => event.kind === "human_review");
  return {
    review: {
      data: {
        running: false, events, evidence: fixture.evidence,
        sourcePdfUrl: "#original-contractor-pdf", candidateAttemptId: null as number | null,
      },
      isPending: false, isError: false, error: new Error("Extraction evidence unavailable."),
      refetch: async () => undefined,
    },
    summary: {
      data: { ...fixture.monitoring,
        reviewed: recorded.length ? 1 : 0,
        inaccurate: recorded.some(event => event.outcome === "confirmed_inaccurate") ? 1 : 0,
        effortMinutes: recorded.reduce((sum, event) => sum + (event.effort_minutes ?? 0), 0),
      },
      isPending: false, isError: false, error: new Error("Monitoring unavailable."),
      refetch: async () => undefined,
    },
    record: {
      isPending: false, isError: error !== null, error: error ?? new Error("Review not recorded."),
      reset: () => setError(null),
      mutateAsync: async (request: ExtractionReviewRequest) => {
        setEvents(previous => [...previous, {
          id: `local-${previous.length}`, created_at: new Date().toISOString(), kind: "human_review",
          outcome: request.outcome, category: request.category, reason: request.reason,
          effort_minutes: request.effortMinutes,
        }]);
      },
    },
    apply: {
      isPending: false, error: null as Error | null,
      mutateAsync: async (_request: ExtractionCandidateApplyRequest) => {
        throw new Error("Sandbox: there is no prepared candidate to apply.");
      },
    },
  };
}
