import { storage } from "../storage";
import { evaluateInsuranceMirrorPreloaded } from "./insurance-verdict";
import type { Devis } from "@shared/schema";

/**
 * Task #374 — batch, read-only readiness derivation for the devis list
 * strip (Review · Translation · Ready · Signature).
 *
 * The Ready predicates are a superset of the send-time preconditions in
 * `POST /api/devis/:id/send-to-signer` (routes/archisign-envelopes.ts):
 * every send-time gate is mirrored (stage, open contractor checks,
 * translated PDF for BOTH modes, finalised translation for mode B,
 * client contact, insurance), plus two spec-mandated data-completeness
 * prerequisites the send route does not check (lot reference, English
 * description). Two deliberate differences from send time:
 *   - the insurance signal is the cheap mirror-only evaluation (plus
 *     recorded overrides), never the live Archidoc call — the live
 *     verdict stays authoritative at send time;
 *   - readiness can only be stricter, never greener, than the send route.
 */

export type SignatureState =
  | "not_sent"
  | "sent"
  | "viewed"
  | "queried"
  | "signed"
  | "declined"
  | "expired"
  | "void";

export interface DevisReadiness {
  devisId: number;
  stage: string;
  invoicingMode: string;
  /** Raw translation status ("missing" when no row exists). */
  translationStatus: string;
  openContractorChecks: number;
  openClientChecks: number;
  envelopeStatus: string | null;
  signature: SignatureState;
  /** True once the devis has moved past the pre-send phase. */
  sent: boolean;
  readyToSend: boolean;
  /** Human-readable failed predicates (empty when readyToSend). */
  blockers: string[];
  insuranceOk: boolean;
  insuranceOverridden: boolean;
  insuranceReason: string | null;
}

export interface DeriveReadinessInput {
  devis: Pick<
    Devis,
    | "id"
    | "status"
    | "signOffStage"
    | "invoicingMode"
    | "lotId"
    | "lotRefText"
    | "descriptionUk"
    | "archisignEnvelopeId"
    | "archisignEnvelopeStatus"
  >;
  translationStatus: string | null;
  openContractorChecks: number;
  openClientChecks: number;
  clientContactPresent: boolean;
  insurance: { ok: boolean; reason: string };
  insuranceOverridden: boolean;
}

const ENVELOPE_STATES: ReadonlySet<string> = new Set([
  "sent",
  "viewed",
  "queried",
  "signed",
  "declined",
  "expired",
]);

function deriveSignature(input: DeriveReadinessInput): SignatureState {
  const d = input.devis;
  if (d.status === "void" || d.signOffStage === "void") return "void";
  const env = (d.archisignEnvelopeStatus ?? "").trim();
  if (env && ENVELOPE_STATES.has(env)) return env as SignatureState;
  switch (d.signOffStage) {
    case "sent_to_client":
      return "sent";
    case "client_signed_off":
      return "signed";
    case "client_rejected":
      return "declined";
    default:
      return "not_sent";
  }
}

export function deriveDevisReadiness(input: DeriveReadinessInput): DevisReadiness {
  const d = input.devis;
  const isModeB = d.invoicingMode === "mode_b";
  const translationStatus = input.translationStatus ?? "missing";
  const signature = deriveSignature(input);
  const sent =
    signature !== "not_sent" ||
    d.signOffStage === "sent_to_client" ||
    d.signOffStage === "client_signed_off";

  const blockers: string[] = [];
  if (d.signOffStage !== "approved_for_signing") {
    blockers.push(`Stage is "${d.signOffStage}" — must reach "Approved for signing"`);
  }
  if (input.openContractorChecks > 0) {
    blockers.push(
      input.openContractorChecks === 1
        ? "1 contractor check is still open"
        : `${input.openContractorChecks} contractor checks are still open`,
    );
  }
  // The send route requires a translated PDF (draft/edited/finalised) for
  // EVERY invoicing mode — the envelope PDF is the translation.
  const translationReady =
    translationStatus === "draft" ||
    translationStatus === "edited" ||
    translationStatus === "finalised";
  if (!translationReady) {
    blockers.push(`Translated PDF not generated (currently ${translationStatus})`);
  } else if (isModeB && translationStatus !== "finalised") {
    blockers.push(`Translation not finalised (currently ${translationStatus})`);
  }
  const hasLot = d.lotId != null || Boolean((d.lotRefText ?? "").trim());
  if (!hasLot) blockers.push("Lot reference missing");
  if (!(d.descriptionUk ?? "").trim()) blockers.push("English description missing");
  if (!input.clientContactPresent) {
    blockers.push("Client contact name/email missing on the project");
  }
  const insuranceOk = input.insurance.ok || input.insuranceOverridden;
  if (!insuranceOk) {
    blockers.push(`Insurance: ${input.insurance.reason}`);
  }

  return {
    devisId: d.id,
    stage: d.signOffStage,
    invoicingMode: d.invoicingMode,
    translationStatus,
    openContractorChecks: input.openContractorChecks,
    openClientChecks: input.openClientChecks,
    envelopeStatus: d.archisignEnvelopeStatus ?? null,
    signature,
    sent,
    readyToSend: blockers.length === 0,
    blockers,
    insuranceOk,
    insuranceOverridden: input.insuranceOverridden,
    insuranceReason: input.insurance.ok ? null : input.insurance.reason,
  };
}

/** Batch readiness for every devis in a project — ONE call per list render. */
export async function getProjectDevisReadiness(
  projectId: number,
): Promise<Record<number, DevisReadiness>> {
  const [devisList, project, translations, contractorChecks, clientChecks, lots] =
    await Promise.all([
      storage.getDevisByProject(projectId),
      storage.getProject(projectId),
      storage.getDevisTranslationStatusesByProject(projectId),
      storage.countOpenDevisChecksForProject(projectId),
      storage.countOpenClientChecksForProject(projectId),
      storage.getLotsByProject(projectId),
    ]);

  const contractorIds = Array.from(new Set(devisList.map((d) => d.contractorId)));
  const [overrides, contractorRows, mirrorProject] = await Promise.all([
    storage.listDevisIdsWithInsuranceOverride(devisList.map((d) => d.id)),
    storage.getContractorsByIds(contractorIds),
    project?.archidocId ? storage.getArchidocProject(project.archidocId) : Promise.resolve(undefined),
  ]);
  const contractorById = new Map(contractorRows.map((c) => [c.id, c] as const));
  const mirrorLotContractors = mirrorProject?.lotContractors ?? null;
  const lotNumberById = new Map(lots.map((l) => [l.id, l.lotNumber] as const));
  const clientContactPresent = Boolean(
    (project?.clientContactName ?? "").trim() && (project?.clientContactEmail ?? "").trim(),
  );
  const out: Record<number, DevisReadiness> = {};
  for (const d of devisList) {
    const insurance = evaluateInsuranceMirrorPreloaded(
      contractorById.get(d.contractorId),
      mirrorLotContractors,
      d.lotId != null ? (lotNumberById.get(d.lotId) ?? null) : null,
    );
    out[d.id] = deriveDevisReadiness({
      devis: d,
      translationStatus: translations[d.id] ?? null,
      openContractorChecks: contractorChecks[d.id] ?? 0,
      openClientChecks: clientChecks[d.id] ?? 0,
      clientContactPresent,
      insurance,
      insuranceOverridden: overrides.has(d.id),
    });
  }
  return out;
}
