export type TechnicalLot = {
  id: string;
  code: string;
  labelFr: string;
  displayOrder: number;
  isActive: boolean;
  deletedAt: string | null;
};

export type TechnicalLotsResponse = {
  lots: TechnicalLot[];
  catalogue: { revision: number; changedAt: string; syncedAt?: string } | null;
  sync: { status: string; errorMessage?: string | null } | null;
  availability?: {
    state: "ready" | "last_known_good" | "empty";
    selectable: boolean;
    reason: string | null;
    lotCount: number;
    activeLotCount: number;
    revision: number | null;
    changedAt: string | null;
    syncedAt: string | null;
    diagnosticCode?: string | null;
    lastFetch: {
      endpoint: string;
      outcome: "success" | "error";
      status: number | null;
      durationMs: number;
      checkedAt: string;
      code: string | null;
      reason: string;
    } | null;
  };
};

export function deriveTechnicalLotsUiState(
  data: TechnicalLotsResponse | undefined,
  queryError: unknown,
) {
  const explicitState = data?.availability?.state;
  const catalogueSelectable =
    data?.availability?.selectable ?? data?.catalogue != null;
  const catalogueColdFailure =
    explicitState === "empty" ||
    (!!queryError && !data) ||
    (!!data && data.catalogue == null);
  const catalogueStale =
    explicitState === "last_known_good" ||
    (!!queryError && !!data?.catalogue) ||
    (!!data?.catalogue && data.sync?.status === "failed");

  return {
    catalogueSelectable,
    catalogueColdFailure,
    catalogueStale,
    diagnosticReason: data?.availability?.reason ?? data?.sync?.errorMessage ?? null,
  };
}