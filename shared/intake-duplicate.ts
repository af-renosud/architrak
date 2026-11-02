export interface IntakeDuplicateSummary {
  intakeId: number;
  originalId: number | null;
  originalHref: string | null;
  match: "exact" | "content" | "reference" | "possible";
  lifecycle: "active" | "historical" | "unprocessed" | "missing";
  label: string;
  href: string | null;
  evidenceHref?: string | null;
  explanation: string;
  recovery: "draft" | "resume" | null;
  blockedReason: string | null;
  version: string;
}
