/**
 * Insurance verdict client + decision-tree evaluator.
 *
 * Counterpart to Archidoc's `POST /api/integrations/architrak/
 * contractors/:contractorId/insurance-verdict` endpoint per
 * `docs/INTER_APP_CONTRACT_v1.0.md` §1.3 (frozen 2026-04-25).
 *
 * Four-arm decision tree (per `docs/STEP4_IMPLEMENTATION_BREAKDOWN.md` §1.1
 * AT3 row + §3.1 G7):
 *
 *   1. live_ok        — 200 + canProceed:true                 → proceed
 *   2. live_blocked   — 200 + canProceed:false                → red, overridable
 *   3. mirror_*       — live unreachable (503, config gap,    → fall through to mirror-only
 *                       missing archidocId, network)              evaluation; mirror's verdict
 *                                                                determines proceed/overridable
 *   4. live_not_found — 404                                   → red, NON-overridable (data fix)
 *
 * Differentiated error handling per task §3.5:
 *   - 401 → retry once with the (re-read) `ARCHIDOC_SYNC_API_KEY`. If still
 *           401, surface as `live_auth_error` (overridable per G7 uniform
 *           treatment of non-2xx-non-404 response classes that aren't 503).
 *   - 503 → log as receiver-config-gap (do NOT rotate keys), fall through
 *           to MIRROR-ONLY FALLBACK (architect-blocking 5s budget already
 *           consumed, do not stack mirror eval on top of a hung TCP).
 *   - other 5xx + network/timeout → uniform overridable per G7.
 *
 * Per §1.4 exception, the TOTAL call budget for the insurance verdict is
 * 5 seconds (architect-blocking UX), not 10s × 3. We split this as
 * 2.5s + 2.5s across the at-most-two attempts so the worst-case total
 * stays inside budget even on the 401-retry branch.
 *
 * `intendedWorkLot` per G11 closure: lot's case-insensitive label
 * (descriptionFr) when the devis carries a lot; field omitted otherwise
 * so Archidoc falls back to project-scoped semantics.
 */

import { env } from "../env";
import { storage } from "../storage";

// ---- Wire types -----------------------------------------------------------

/** Per contract §1.3 + §2.2.1 — Archidoc's response shape on 200. */
export interface InsuranceVerdictResponse {
  canProceed: boolean;
  reason?: string;
  // Free-form extras Archidoc may return (e.g. `coverageDetails`,
  // `policyExpiresAt`, …). We persist the entire body verbatim into
  // `insurance_overrides.live_verdict_response` for audit, so we keep an
  // open shape here rather than enumerating fields the contract does not
  // freeze.
  [key: string]: unknown;
}

interface CallParams {
  contractorArchidocId: string;
  projectArchidocId: string;
  intendedWorkLot: string | null;
}

/** Discriminated outcome of the `live` call attempt. */
export type LiveCallOutcome =
  | { kind: "ok"; httpStatus: 200; body: InsuranceVerdictResponse }
  | { kind: "blocked"; httpStatus: 200; body: InsuranceVerdictResponse }
  | { kind: "not_found"; httpStatus: 404; body: unknown }
  | { kind: "auth_error"; httpStatus: 401; body: unknown }
  | { kind: "config_gap"; httpStatus: 503; body: unknown }
  | { kind: "transient_error"; httpStatus: number; body: unknown }
  | { kind: "unreachable"; httpStatus: 0; reason: "no_archidoc_config" | "no_archidoc_id" | "network_error" | "timeout"; error?: string };

const TOTAL_BUDGET_MS = 5_000;
const PER_ATTEMPT_TIMEOUT_MS = 2_500;

async function callOnce(
  params: CallParams,
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
  const url = new URL(
    `/api/integrations/architrak/contractors/${encodeURIComponent(params.contractorArchidocId)}/insurance-verdict`,
    baseUrl,
  );
  const requestBody: Record<string, string> = { projectId: params.projectArchidocId };
  if (params.intendedWorkLot && params.intendedWorkLot.trim() !== "") {
    requestBody.intendedWorkLot = params.intendedWorkLot;
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Calls the live verdict endpoint with the §1.4 5-second budget and the
 * §3.5 401-retry rule. Returns a discriminated outcome — never throws on
 * HTTP/network failures (those are first-class verdict states).
 */
export async function callLiveInsuranceVerdict(params: CallParams): Promise<LiveCallOutcome> {
  const baseUrl = env.ARCHIDOC_BASE_URL;
  if (!baseUrl || !env.ARCHIDOC_SYNC_API_KEY) {
    return { kind: "unreachable", httpStatus: 0, reason: "no_archidoc_config" };
  }

  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), TOTAL_BUDGET_MS);

  try {
    const attemptOnce = async (): Promise<{ status: number; body: unknown } | { error: "timeout" } | { error: "network"; message: string }> => {
      const attemptController = new AbortController();
      const onAbort = () => attemptController.abort();
      budgetController.signal.addEventListener("abort", onAbort);
      const attemptTimer = setTimeout(() => attemptController.abort(), PER_ATTEMPT_TIMEOUT_MS);
      try {
        // env.ARCHIDOC_SYNC_API_KEY re-read in case the secrets store
        // mutated under us between attempts (per task §3.5 401-retry
        // semantics). In current Architrak runtime the env-cache is
        // process-lifetime, so this is best-effort — production secret
        // rotation requires a deploy/restart.
        const apiKey = env.ARCHIDOC_SYNC_API_KEY!;
        const result = await callOnce(params, apiKey, baseUrl, attemptController.signal);
        return result;
      } catch (err) {
        if (budgetController.signal.aborted) return { error: "timeout" };
        if (attemptController.signal.aborted) return { error: "timeout" };
        return { error: "network", message: err instanceof Error ? err.message : String(err) };
      } finally {
        clearTimeout(attemptTimer);
        budgetController.signal.removeEventListener("abort", onAbort);
      }
    };

    const first = await attemptOnce();
    let final: typeof first;
    if ("error" in first) {
      final = first;
    } else if (first.status === 401) {
      // Single retry against (re-read) secret per §3.5.
      const second = await attemptOnce();
      final = second;
    } else {
      final = first;
    }

    if ("error" in final) {
      if (final.error === "timeout") {
        return { kind: "unreachable", httpStatus: 0, reason: "timeout" };
      }
      return { kind: "unreachable", httpStatus: 0, reason: "network_error", error: final.message };
    }

    const { status, body } = final;
    if (status === 200) {
      const parsed = (body && typeof body === "object" ? body : {}) as InsuranceVerdictResponse;
      if (parsed.canProceed === true) return { kind: "ok", httpStatus: 200, body: parsed };
      return { kind: "blocked", httpStatus: 200, body: parsed };
    }
    if (status === 404) return { kind: "not_found", httpStatus: 404, body };
    if (status === 401) return { kind: "auth_error", httpStatus: 401, body };
    if (status === 503) {
      // Per task §3.5: log as receiver-config-gap operational alert, no key rotation.
      console.warn(
        `[insurance-verdict] receiver-config-gap (503) from Archidoc for contractor=${params.contractorArchidocId} project=${params.projectArchidocId}`,
      );
      return { kind: "config_gap", httpStatus: 503, body };
    }
    return { kind: "transient_error", httpStatus: status, body };
  } finally {
    clearTimeout(budgetTimer);
  }
}

// ---- Decision tree --------------------------------------------------------

/**
 * Final gate verdict surfaced to the architect. Drives the UI banner +
 * override modal and the PATCH-time enforcement at
 * `approved_for_signing → sent_to_client`.
 */
export type GateDecisionArm =
  | "live_ok"
  | "live_blocked"
  | "live_not_found"
  | "live_auth_error"
  | "live_transient"
  | "mirror_ok"
  | "mirror_blocked"
  | "mirror_unknown";

export interface GateDecision {
  arm: GateDecisionArm;
  proceed: boolean;
  overridable: boolean;
  /** Human-readable reason in French (UI surfaces verbatim). */
  reason: string;
  /** Snapshot fields for the override row (per §2.1.4). */
  liveVerdictHttpStatus: number;
  liveVerdictCanProceed: boolean | null;
  liveVerdictResponse: unknown | null;
  mirrorStatus: string;
  mirrorSyncedAt: Date;
  /** Truthy when the live verdict was actually attempted. */
  liveAttempted: boolean;
}

interface MirrorSnapshot {
  status: string;
  syncedAt: Date;
  contractorAssignedToLot: boolean;
  hasLot: boolean;
}

/**
 * Mirror-only fallback per task §4.1 — uses the locally-mirrored
 * `archidoc_projects.lotContractors` (LOT-only matching, NOT the broader
 * contractor-trade taxonomy) plus the `contractors.insuranceStatus`
 * mirror.
 *
 * Lot-assignment matches by `lotNumber` (the canonical key both apps
 * agree on for mirror data); the `intendedWorkLot` label is only used on
 * the live verdict wire per G11 case-insensitive-label-match.
 */
async function buildMirrorSnapshot(
  contractorId: number,
  projectArchidocId: string | null,
  lotNumber: string | null,
): Promise<MirrorSnapshot> {
  const contractor = await storage.getContractor(contractorId);
  const status = (contractor?.insuranceStatus ?? "").toString().trim();
  // Architrak's contractor mirror does not carry a syncedAt column today
  // (the contractor-updated webhook from Archidoc rewrites the row).
  // We use NOW() as a conservative best-available timestamp; this field
  // is required NOT NULL on `insurance_overrides.mirror_synced_at_at_override`
  // and exists for audit-trail completeness, not for staleness checks.
  const syncedAt = new Date();

  let contractorAssignedToLot = false;
  const hasLot = lotNumber !== null && lotNumber.trim() !== "";
  if (projectArchidocId) {
    const mirrorProject = await storage.getArchidocProject(projectArchidocId);
    const lotContractors = (mirrorProject?.lotContractors ?? []) as Array<{ lotNumber?: unknown; contractorId?: unknown }>;
    if (Array.isArray(lotContractors) && contractor?.archidocId) {
      contractorAssignedToLot = lotContractors.some((lc) => {
        if (!lc || typeof lc !== "object") return false;
        const lcContractorId = String(lc.contractorId ?? "");
        if (lcContractorId !== contractor.archidocId) return false;
        if (!hasLot) return true; // project-scoped: any assignment counts
        return String(lc.lotNumber ?? "").trim() === lotNumber!.trim();
      });
    }
  }

  return { status, syncedAt, contractorAssignedToLot, hasLot };
}

function evaluateMirror(snapshot: MirrorSnapshot): { ok: boolean; reason: string } {
  // The mirror is advisory by contract — we apply the simplest defensible
  // policy: contractor must (a) carry a non-blocking insurance status on
  // the mirror AND (b) be assigned to the requested lot (or to the
  // project at all when no lot is requested).
  const blockingStatuses = new Set(["expired", "missing", "rejected", "blocked", "non_compliant"]);
  const okStatuses = new Set(["valid", "active", "compliant", "ok", "current"]);
  const normalized = snapshot.status.toLowerCase();
  if (!snapshot.contractorAssignedToLot) {
    return {
      ok: false,
      reason: snapshot.hasLot
        ? "Mirror local : ce contractant n'est pas affecté au lot demandé."
        : "Mirror local : ce contractant n'est pas affecté au projet.",
    };
  }
  if (blockingStatuses.has(normalized)) {
    return { ok: false, reason: `Mirror local : statut d'assurance « ${snapshot.status || "inconnu"} ».` };
  }
  if (okStatuses.has(normalized)) {
    return { ok: true, reason: "Mirror local : assurance valide et affectation lot OK." };
  }
  // Unknown / null status — mirror cannot affirm, so we surface as
  // overridable-but-blocked rather than silently green-lighting.
  return { ok: false, reason: `Mirror local : statut d'assurance non reconnu (« ${snapshot.status || "vide"} »).` };
}

/**
 * Top-level gate evaluator used by both `GET /api/devis/:id/insurance-verdict`
 * (UI freshness check) and the PATCH lifecycle handler at
 * `approved_for_signing → sent_to_client`.
 */
export async function evaluateInsuranceGate(devisId: number): Promise<GateDecision | { error: "devis_not_found" }> {
  const devis = await storage.getDevis(devisId);
  if (!devis) return { error: "devis_not_found" };
  const project = await storage.getProject(devis.projectId);
  const contractor = await storage.getContractor(devis.contractorId);
  let intendedWorkLotLabel: string | null = null;
  let lotNumber: string | null = null;
  if (devis.lotId !== null && devis.lotId !== undefined) {
    const lot = await storage.getLot(devis.lotId);
    if (lot) {
      intendedWorkLotLabel = lot.descriptionFr ?? null;
      lotNumber = lot.lotNumber ?? null;
    }
  }

  const mirror = await buildMirrorSnapshot(devis.contractorId, project?.archidocId ?? null, lotNumber);
  const baseSnapshot = {
    mirrorStatus: mirror.status || "(unknown)",
    mirrorSyncedAt: mirror.syncedAt,
  };

  // Live attempt only when both archidoc IDs exist (otherwise we have no
  // routable identity to pass on the wire — fall through to mirror).
  const canCallLive = !!contractor?.archidocId && !!project?.archidocId;
  let live: LiveCallOutcome;
  if (!canCallLive) {
    live = { kind: "unreachable", httpStatus: 0, reason: "no_archidoc_id" };
  } else {
    live = await callLiveInsuranceVerdict({
      contractorArchidocId: contractor!.archidocId!,
      projectArchidocId: project!.archidocId!,
      intendedWorkLot: intendedWorkLotLabel,
    });
  }

  const liveAttempted = canCallLive && (live.kind !== "unreachable" || (live.kind === "unreachable" && live.reason !== "no_archidoc_config" && live.reason !== "no_archidoc_id"));

  switch (live.kind) {
    case "ok":
      return {
        arm: "live_ok",
        proceed: true,
        overridable: false,
        reason: typeof live.body.reason === "string" && live.body.reason.length > 0 ? live.body.reason : "Live Archidoc : assurance valide pour le contractant et le lot.",
        liveVerdictHttpStatus: live.httpStatus,
        liveVerdictCanProceed: true,
        liveVerdictResponse: live.body,
        ...baseSnapshot,
        liveAttempted,
      };
    case "blocked":
      return {
        arm: "live_blocked",
        proceed: false,
        overridable: true,
        reason: typeof live.body.reason === "string" && live.body.reason.length > 0 ? live.body.reason : "Live Archidoc : ce contractant n'est pas couvert pour le lot demandé.",
        liveVerdictHttpStatus: live.httpStatus,
        liveVerdictCanProceed: false,
        liveVerdictResponse: live.body,
        ...baseSnapshot,
        liveAttempted,
      };
    case "not_found":
      return {
        arm: "live_not_found",
        proceed: false,
        overridable: false,
        reason:
          "Live Archidoc : contractant non affecté au projet (corriger l'affectation côté Archidoc avant de continuer).",
        liveVerdictHttpStatus: 404,
        liveVerdictCanProceed: null,
        liveVerdictResponse: live.body,
        ...baseSnapshot,
        liveAttempted,
      };
    case "auth_error":
      // Per G7: non-503 5xx-class failures (and 401 after the single
      // retry) are uniformly overridable. We surface a distinct reason
      // copy so the architect can see this was an auth error rather
      // than a contractor-data problem.
      return {
        arm: "live_auth_error",
        proceed: false,
        overridable: true,
        reason:
          "Live Archidoc : authentification refusée (401). Vérifier ARCHIDOC_SYNC_API_KEY puis ré-essayer ; override possible avec motif.",
        liveVerdictHttpStatus: 401,
        liveVerdictCanProceed: null,
        liveVerdictResponse: live.body,
        ...baseSnapshot,
        liveAttempted,
      };
    case "transient_error":
      return {
        arm: "live_transient",
        proceed: false,
        overridable: true,
        reason: `Live Archidoc : erreur transitoire (${live.httpStatus}). Override possible avec motif.`,
        liveVerdictHttpStatus: live.httpStatus,
        liveVerdictCanProceed: null,
        liveVerdictResponse: live.body,
        ...baseSnapshot,
        liveAttempted,
      };
    case "config_gap":
      // Per contract §1.3 outcome table: 503 → Red, Overridable with
      // prominent "Archidoc unreachable" warning. The mirror is
      // **explicitly demoted** to advisory ("no longer the gate's
      // source of truth", §1.3 ¶5), so we surface mirror context in
      // the reason but do NOT let it authorise the send.
      return {
        arm: "live_transient",
        proceed: false,
        overridable: true,
        reason: `Live Archidoc indisponible (503 — config gap récepteur). Mirror local : ${evaluateMirror(mirror).reason} Override possible avec motif.`,
        liveVerdictHttpStatus: 503,
        liveVerdictCanProceed: null,
        liveVerdictResponse: live.body,
        ...baseSnapshot,
        liveAttempted,
      };
    case "unreachable": {
      // Two sub-cases: (a) live was actually attempted but failed
      // (timeout / network) — contract §1.3 mandates Red + Overridable;
      // (b) live wasn't attempted at all because env / data lacks the
      // archidoc IDs required to even route the call — this is a
      // dev/staging or never-synced row, where the mirror IS the only
      // signal and we keep the historical mirror-only fall-through
      // (the contract scenario assumes a configured Archidoc; AT2
      // owns the never-synced data path).
      if (live.reason === "timeout" || live.reason === "network_error") {
        return {
          arm: "live_transient",
          proceed: false,
          overridable: true,
          reason:
            live.reason === "timeout"
              ? `Live Archidoc indisponible (timeout 5s). Mirror local : ${evaluateMirror(mirror).reason} Override possible avec motif.`
              : `Live Archidoc indisponible (erreur réseau). Mirror local : ${evaluateMirror(mirror).reason} Override possible avec motif.`,
          liveVerdictHttpStatus: 0,
          liveVerdictCanProceed: null,
          liveVerdictResponse: null,
          ...baseSnapshot,
          liveAttempted,
        };
      }
      // no_archidoc_config / no_archidoc_id — no live attempt was made,
      // mirror is the only signal available.
      const m = evaluateMirror(mirror);
      const fallbackHeading =
        live.reason === "no_archidoc_config"
          ? "Live Archidoc non configuré (dev/staging), bascule mirror local."
          : "Identifiant Archidoc manquant pour le contractant ou le projet, bascule mirror local.";
      return {
        arm: m.ok ? "mirror_ok" : "mirror_blocked",
        proceed: m.ok,
        overridable: !m.ok,
        reason: `${fallbackHeading} ${m.reason}`,
        liveVerdictHttpStatus: 0,
        liveVerdictCanProceed: null,
        liveVerdictResponse: null,
        ...baseSnapshot,
        liveAttempted,
      };
    }
  }
}
