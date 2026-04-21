export interface BilingualLotLike {
  descriptionFr?: string | null;
  descriptionUk?: string | null;
}

export function formatLotDescription(lot: BilingualLotLike | null | undefined): string {
  if (!lot) return "";
  const fr = (lot.descriptionFr ?? "").trim();
  const uk = (lot.descriptionUk ?? "").trim();
  if (fr && uk && fr !== uk) return `${fr} (${uk})`;
  return fr || uk;
}
