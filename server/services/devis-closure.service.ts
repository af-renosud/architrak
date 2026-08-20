import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { devis, marches, type Devis } from "@shared/schema";
import { isPvReceptionApproved } from "./pv-reception.service";

export type DevisClosureErrorCode =
  | "DEVIS_NOT_FOUND"
  | "DEVIS_CLOSURE_VOID"
  | "DEVIS_CLOSURE_NOT_ACTIVE"
  | "DEVIS_CLOSURE_NOT_SIGNED"
  | "DEVIS_MARCHE_REQUIRED"
  | "DEVIS_MARCHE_MISMATCH"
  | "PV_RECEPTION_REQUIRED"
  | "DEVIS_CLOSURE_CONFLICT";

export class DevisClosureError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: DevisClosureErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DevisClosureError";
  }
}

export interface DevisClosureResult {
  devis: Devis;
  alreadyClosed: boolean;
}

/**
 * Closes one executed devis under a row lock. The lock serialises closure with
 * generic devis updates (including marché reassignment), while the exact
 * marché lookup prevents the contractor-level fallback used by certificat
 * calculations from satisfying this per-quotation legal backstop.
 */
export async function closeDevisWithApprovedPv(
  devisId: number,
  userId: number,
): Promise<DevisClosureResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(devis)
      .where(eq(devis.id, devisId))
      .for("update");

    if (!current) {
      throw new DevisClosureError(404, "DEVIS_NOT_FOUND", "Devis introuvable.");
    }
    if (current.closureState === "closed") {
      return { devis: current, alreadyClosed: true };
    }
    if (
      current.status === "void" ||
      current.signOffStage === "void" ||
      current.signOffStage === "client_rejected"
    ) {
      throw new DevisClosureError(
        409,
        "DEVIS_CLOSURE_VOID",
        "Un devis annulé ou refusé ne correspond pas à des travaux à réceptionner et ne peut pas être clôturé.",
      );
    }
    if (current.accountingState !== "active") {
      throw new DevisClosureError(
        409,
        "DEVIS_CLOSURE_NOT_ACTIVE",
        "Seul un devis actif peut être clôturé. Les devis provisoires ou remplacés restent hors de la clôture des travaux.",
        { accountingState: current.accountingState },
      );
    }
    if (current.signOffStage !== "client_signed_off") {
      throw new DevisClosureError(
        409,
        "DEVIS_CLOSURE_NOT_SIGNED",
        "Le devis doit être signé par le client avant la clôture des travaux.",
        { signOffStage: current.signOffStage },
      );
    }
    if (current.marcheId == null) {
      throw new DevisClosureError(
        422,
        "DEVIS_MARCHE_REQUIRED",
        "Ce devis n'est lié à aucun marché. Liez-le au marché correspondant avant d'enregistrer le PV de réception et de clôturer les travaux.",
      );
    }

    const [marche] = await tx
      .select()
      .from(marches)
      .where(eq(marches.id, current.marcheId))
      .for("update");

    if (
      !marche ||
      marche.projectId !== current.projectId ||
      marche.contractorId !== current.contractorId
    ) {
      throw new DevisClosureError(
        422,
        "DEVIS_MARCHE_MISMATCH",
        "Le marché lié au devis ne correspond pas au même projet et à la même entreprise. Corrigez le lien avant la clôture.",
        {
          marcheId: current.marcheId,
          marcheProjectId: marche?.projectId ?? null,
          marcheContractorId: marche?.contractorId ?? null,
        },
      );
    }
    if (!isPvReceptionApproved(marche)) {
      throw new DevisClosureError(
        422,
        "PV_RECEPTION_REQUIRED",
        marche.pvReceptionStatus === "draft"
          ? "Le PV de réception de ce marché est encore en brouillon. Approuvez-le avant de clôturer le devis."
          : "Un PV de réception approuvé avec sa date de réception est obligatoire avant de clôturer le devis.",
        {
          marcheId: marche.id,
          pvReceptionStatus: marche.pvReceptionStatus,
          receptionDate: marche.receptionDate,
        },
      );
    }

    const [closed] = await tx
      .update(devis)
      .set({
        closureState: "closed",
        closedAt: new Date(),
        closedByUserId: userId,
        closureMarcheId: marche.id,
        closureProjectId: current.projectId,
        closureContractorId: current.contractorId,
        closureReceptionDate: marche.receptionDate,
        updatedAt: new Date(),
      })
      .where(and(eq(devis.id, devisId), eq(devis.closureState, "open")))
      .returning();

    if (!closed) {
      throw new DevisClosureError(
        409,
        "DEVIS_CLOSURE_CONFLICT",
        "Le devis a changé pendant la clôture. Rechargez la page puis réessayez.",
      );
    }
    return { devis: closed, alreadyClosed: false };
  });
}