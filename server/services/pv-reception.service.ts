import type { Marche } from "@shared/schema";

/**
 * Task #566 — PV de réception gate for final payment.
 *
 * A solde (final) certificat pays out the end of a contract — including,
 * potentially, the retenue de garantie. French practice ties that moment to
 * the réception des travaux formalised by a PV de réception. The gate below
 * refuses the solde path until the marché carries an APPROVED PV with a
 * reception date, unless the architect recorded an explicit, audited
 * override (legacy projects predating the PV workflow).
 *
 * The check is pure and synchronous so every caller (deduction resolver at
 * create/PATCH/preview, seal recompute, send route) applies the SAME rule to
 * a marché row it already holds — no duplicate queries, no drift between
 * enforcement points.
 */
export const PV_RECEPTION_STATUSES = ["draft", "approved"] as const;
export type PvReceptionStatus = (typeof PV_RECEPTION_STATUSES)[number];

export class PvReceptionRequiredError extends Error {
  constructor(
    public readonly marcheId: number | null,
    public readonly pvStatus: string | null,
  ) {
    super(
      marcheId == null
        ? "Aucun marché n'est enregistré pour cette entreprise : le certificat de solde exige un marché avec un PV de réception approuvé (ou une dérogation motivée)."
        : pvStatus === "draft"
          ? "Le PV de réception de ce marché est encore en brouillon : approuvez-le avant d'émettre le certificat de solde (ou enregistrez une dérogation motivée)."
          : "Aucun PV de réception approuvé pour ce marché : le certificat de solde est bloqué tant que la réception des travaux n'est pas formalisée (ou une dérogation motivée enregistrée).",
    );
    this.name = "PvReceptionRequiredError";
  }
}

type PvGateMarche = Pick<Marche, "id" | "pvReceptionStatus" | "receptionDate"> | null | undefined;

/** True when the marché carries an approved PV with a reception date. */
export function isPvReceptionApproved(marche: PvGateMarche): boolean {
  return (
    marche != null &&
    marche.pvReceptionStatus === "approved" &&
    marche.receptionDate != null
  );
}

/**
 * Throws `PvReceptionRequiredError` unless the marché's PV is approved (with
 * its reception date) or the caller holds a recorded override. An approved
 * status WITHOUT a reception date still fails: the date is what the GPA/RG
 * timing reads, so an approval that lost it must never unlock a payment.
 */
export function assertPvReceptionForSolde(marche: PvGateMarche, hasOverride: boolean): void {
  if (hasOverride) return;
  if (isPvReceptionApproved(marche)) return;
  throw new PvReceptionRequiredError(marche?.id ?? null, marche?.pvReceptionStatus ?? null);
}
