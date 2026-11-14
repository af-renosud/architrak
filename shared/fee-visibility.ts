export type FeeRecordKind = "fee" | "entry";
export interface FeeVisibilityRecord {
  kind: FeeRecordKind;
  id: number;
  archived: boolean;
  archivedAt: string | null;
  reason: string | null;
  blockedReason: string | null;
}
export interface FeeVisibilityEvent {
  id: number;
  kind: FeeRecordKind;
  recordId: number;
  action: "archive" | "restore";
  reason: string;
  actor: string;
  createdAt: string;
}
export interface FeeVisibilityResponse {
  records: FeeVisibilityRecord[];
  events: FeeVisibilityEvent[];
}
