/**
 * Archisign envelope orchestration endpoints (AT4, contract §1.2 / §3.5).
 *
 * One architect-facing endpoint — POST /api/devis/:id/send-to-signer —
 * which performs the §1.2 transition `approved_for_signing → sent_to_client`
 * by orchestrating Archisign's two-step `/create` then `/send` flow.
 *
 * Pre-conditions enforced (mirroring the inline gates in
 * `server/routes/devis.ts` PATCH for signOffStage):
 *   - signOffStage MUST be `approved_for_signing` (no skip-from-earlier)
 *   - 0 open contractor checks
 *   - Insurance gate: live verdict green OR override row exists (§1.3)
 *   - Translated PDF must be ready (combined or translation variant)
 *   - Client contact name + email present on the project
 *
 * Failure paths:
 *   - 409 — pre-condition not met (check responses surface the specific reason)
 *   - 502 — Archisign call failed (transient; architect can retry)
 *   - 503 — Archisign config missing (env vars unset)
 *
 * Out of scope for AT4: the resend-after-expiry flow (§3.5.4 second hop)
 * — surfaced in the UI as a stub button per scratchpad.
 */

import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import type { InsertDevis } from "@shared/schema";
import {
  DEVIS_CLIENT_MESSAGE_MIN_LEN,
  DEVIS_CLIENT_MESSAGE_MAX_LEN,
} from "@shared/schema";
import {
  sendDevisSignatureContextEmail,
  type DevisContextEmailResult,
} from "../communications/email-sender";
import { requireAuth } from "../auth/middleware";
import { validateRequest } from "../middleware/validate";
import {
  createEnvelope,
  sendEnvelope,
  ArchisignError,
  assertPdfFetchUrlTtl,
} from "../services/archisign";
import { evaluateInsuranceGate } from "../services/insurance-verdict";
import { mintPdfFetchToken } from "../services/archisign-pdf-token";
import { env } from "../env";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });

// Architect-supplied client-context message. Task #257 made it MANDATORY
// on first send (min length enforced at runtime below, because the resume
// branch — envelopeId already persisted — legitimately omits it and reuses
// the message persisted on the devis). Trimmed and capped; empty/
// whitespace-only is treated as absent.
const sendBody = z.object({
  message: z
    .string()
    .trim()
    .max(
      DEVIS_CLIENT_MESSAGE_MAX_LEN,
      `Message trop long (${DEVIS_CLIENT_MESSAGE_MAX_LEN} caractères maximum).`,
    )
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
}).partial();

const PDF_FETCH_URL_TTL_HOURS = 1; // 1h is comfortably above the §G2 5-min floor

/**
 * Task #258 — architect-facing recovery for a failed devis-signature
 * context email (Task #257 surfaces the failure as a destructive toast,
 * but until now the only fix was re-running the whole send-to-signer
 * resume flow).
 *
 * GET  /api/devis/:id/context-email-status  → is a resend warranted?
 * POST /api/devis/:id/resend-context-email  → re-dispatch it.
 *
 * Both key off the SAME dedupeKey the original dispatch used
 * (`devis-signature-context:{devisId}:{envelopeId}`), so a resend can
 * never double-send: an `already_sent` row short-circuits inside
 * sendDevisSignatureContextEmail, and a previously failed row is retried
 * in place on the same communication row.
 */
router.get(
  "/api/devis/:id/context-email-status",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const d = await storage.getDevis(devisId);
    if (!d) return res.status(404).json({ message: "Devis not found" });

    const envelopeId = d.archisignEnvelopeId ?? null;
    const hasMessage = Boolean((d.archisignSignerMessage ?? "").trim());
    if (!envelopeId || !hasMessage) {
      return res.status(200).json({
        canResend: false,
        emailStatus: null as string | null,
        reason: !envelopeId ? "no_envelope" : "no_message",
      });
    }

    const dedupeKey = `devis-signature-context:${devisId}:${envelopeId}`;
    const existing = await storage.getProjectCommunicationByDedupeKey(dedupeKey);
    const emailStatus = existing?.status ?? null;
    // Resend is warranted when the context email for the CURRENT envelope
    // was never successfully sent: either no communication row exists at
    // all (dispatch crashed before logging) or the row is not `sent`.
    const canResend = emailStatus !== "sent";
    return res.status(200).json({ canResend, emailStatus, reason: null });
  },
);

router.post(
  "/api/devis/:id/resend-context-email",
  requireAuth,
  validateRequest({ params: idParams }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const d = await storage.getDevis(devisId);
    if (!d) return res.status(404).json({ message: "Devis not found" });

    const envelopeId = d.archisignEnvelopeId ?? null;
    if (!envelopeId) {
      return res.status(409).json({
        message:
          "Aucune enveloppe Archisign active pour ce devis — rien à renvoyer.",
        code: "no_envelope",
      });
    }
    const message = (d.archisignSignerMessage ?? "").trim();
    if (!message) {
      return res.status(409).json({
        message:
          "Aucun message d'accompagnement persisté pour ce devis — impossible de renvoyer l'e-mail de contexte.",
        code: "no_message",
      });
    }

    const result = await sendDevisSignatureContextEmail({
      devisId,
      envelopeId,
      message,
    });
    if (result.status === "failed") {
      return res.status(502).json({
        message:
          "L'envoi de l'e-mail de contexte a de nouveau échoué." +
          (result.error ? ` (${result.error})` : ""),
        code: "context_email_failed",
        contextEmail: result,
      });
    }
    return res.status(200).json({ ok: true, contextEmail: result });
  },
);

router.post(
  "/api/devis/:id/send-to-signer",
  requireAuth,
  validateRequest({ params: idParams, body: sendBody }),
  async (req, res) => {
    const devisId = Number(req.params.id);
    const personalMessage = (req.body as { message?: string } | undefined)?.message;
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Authentication required" });

    const d = await storage.getDevis(devisId);
    if (!d) return res.status(404).json({ message: "Devis not found" });

    // ---- Pre-condition checks ------------------------------------------
    if (d.signOffStage !== "approved_for_signing") {
      return res.status(409).json({
        message:
          "Le devis doit être au stade « Approuvé pour signature » avant l'envoi à la signature.",
        code: "wrong_stage",
        currentStage: d.signOffStage,
      });
    }

    // Recovery semantics: if a previous attempt got as far as /create
    // but failed before either /send or the final stage-advance, we MUST
    // be able to retry. The state we look for is "envelopeId persisted
    // AND stage still approved_for_signing" — which can only happen via
    // a partial failure of THIS endpoint. In that case we skip /create
    // and resume from /send (which is idempotent against `sent` /
    // `viewed` / `queried` per Archisign §S9). If a webhook had moved
    // the envelope past `sent` (e.g. expired → stage flipped back) the
    // client would have cleared archisignEnvelopeId via the resend flow
    // — out of scope for AT4 — so we 409 only on the truly
    // unrecoverable shape: stage advanced but envelopeId still set.
    const resumingExistingEnvelope = Boolean(d.archisignEnvelopeId);

    // Task #257 — the written client context is mandatory on first send.
    // The Zod schema can't enforce this conditionally (the resume branch
    // legitimately omits the message and reuses the one persisted on the
    // devis at /create time), so the requirement is checked here, before
    // any external call.
    if (
      !resumingExistingEnvelope &&
      (!personalMessage || personalMessage.length < DEVIS_CLIENT_MESSAGE_MIN_LEN)
    ) {
      return res.status(422).json({
        message:
          `Un message d'accompagnement au client est obligatoire ` +
          `(minimum ${DEVIS_CLIENT_MESSAGE_MIN_LEN} caractères). ` +
          `Rédigez le contexte que le client recevra avant la demande de signature.`,
        code: "client_message_required",
        minLength: DEVIS_CLIENT_MESSAGE_MIN_LEN,
      });
    }

    const openCount = await storage.countOpenDevisChecks(devisId);
    if (openCount > 0) {
      return res.status(409).json({
        message:
          openCount === 1
            ? "Impossible d'envoyer le devis : 1 question contractant est encore ouverte."
            : `Impossible d'envoyer le devis : ${openCount} questions contractant sont encore ouvertes.`,
        code: "open_contractor_checks",
        openChecks: openCount,
      });
    }

    // Insurance gate — green OR override (§1.3). Mirrors the PATCH-time
    // logic in routes/devis.ts so the same assertions hold regardless of
    // which path triggers the transition.
    const decision = await evaluateInsuranceGate(devisId, {});
    if (!("error" in decision) && !decision.proceed) {
      const override = decision.overridable
        ? await storage.getLatestInsuranceOverrideForDevis(devisId)
        : null;
      if (!override) {
        return res.status(409).json({
          message:
            "Impossible d'envoyer le devis : verdict d'assurance défavorable.",
          code: "insurance_gate",
          decision: { arm: decision.arm, reason: decision.reason },
        });
      }
    }

    // ---- Resolve project + signer -------------------------------------
    const project = await storage.getProject(d.projectId);
    if (!project) {
      return res.status(409).json({
        message: "Projet introuvable pour ce devis.",
        code: "project_missing",
      });
    }
    const signerName = (project.clientContactName ?? "").trim();
    const signerEmail = (project.clientContactEmail ?? "").trim();
    if (!signerName || !signerEmail) {
      return res.status(409).json({
        message:
          "Coordonnées du client manquantes : renseignez le nom et l'e-mail du contact client sur le projet.",
        code: "client_contact_missing",
      });
    }

    // ---- Resolve PDF availability + mint a short-TTL fetch URL --------
    const translation = await storage.getDevisTranslation(devisId);
    if (!translation || (translation.status !== "draft" && translation.status !== "edited" && translation.status !== "finalised")) {
      return res.status(409).json({
        message:
          "Le PDF traduit doit être généré avant l'envoi à la signature.",
        code: "pdf_not_ready",
        translationStatus: translation?.status ?? "missing",
      });
    }

    const baseUrl = (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
    if (!baseUrl) {
      return res.status(503).json({
        message: "PUBLIC_BASE_URL non configuré : impossible d'exposer le PDF à Archisign.",
        code: "public_base_url_missing",
      });
    }
    const pdfTtlMs = PDF_FETCH_URL_TTL_HOURS * 60 * 60 * 1000;
    const pdfExpiresAt = new Date(Date.now() + pdfTtlMs);
    const pdfToken = mintPdfFetchToken(devisId, pdfExpiresAt);
    const pdfFetchUrl = `${baseUrl}/api/public/devis-pdf/${pdfToken}`;
    try {
      assertPdfFetchUrlTtl(pdfExpiresAt);
    } catch (err) {
      // Should be impossible — the TTL is hard-coded above the floor.
      return res.status(500).json({ message: (err as Error).message });
    }

    // ---- Outbound: optional createEnvelope, then idempotent send ------
    //
    // Three-step orchestration with recovery semantics:
    //
    //   (1) /create  — skipped on retry if we already have envelopeId.
    //                  Persist the envelopeId+accessUrl IMMEDIATELY so a
    //                  later crash leaves a recoverable state.
    //   (2) /send    — always attempted. Idempotent on Archisign side
    //                  per §S9, so the retry path can re-call freely.
    //   (3) advance  — set signOffStage=sent_to_client. If this fails
    //                  the next architect click will skip /create
    //                  (envelopeId set, stage still approved_for_signing)
    //                  and re-attempt /send + advance.
    //
    let envelopeId = d.archisignEnvelopeId ?? null;
    let accessUrl = d.archisignAccessUrl ?? null;
    let otpDestination = d.archisignOtpDestination ?? null;
    let expiresAtIso: string | null = d.archisignEnvelopeExpiresAt
      ? d.archisignEnvelopeExpiresAt.toISOString()
      : null;

    if (!resumingExistingEnvelope) {
      let createResp;
      try {
        createResp = await createEnvelope({
          externalRef: `devis-${devisId}`,
          signer: { fullName: signerName, email: signerEmail },
          pdfFetchUrl,
          webhookUrl: `${baseUrl}/api/webhooks/archisign`,
          // Default expiresAt = now + 30d (handled inside the client).
          subject: `Signature électronique — devis ${d.devisCode}`,
          // Optional architect note (already trimmed + length-capped by sendBody).
          // On the resume branch we never reach this block, so the message is
          // silently dropped — the FE hides the input in that case.
          body: personalMessage,
        });
      } catch (err) {
        if (err instanceof ArchisignError && err.httpStatus === 503) {
          return res.status(503).json({
            message: "Archisign non configuré (clé API ou URL de base manquante).",
            code: "archisign_unconfigured",
          });
        }
        const detail = err instanceof Error ? err.message : String(err);
        console.error(`[Archisign] createEnvelope failed for devis ${devisId}:`, detail);
        return res.status(502).json({
          message: "Échec de la création de l'enveloppe Archisign.",
          code: "archisign_create_failed",
          detail,
        });
      }

      // Persist BEFORE /send so a /send failure does not orphan the
      // envelopeId. The accessUrl from /create is the ONLY persisted
      // URL (G3 / §3.5.4) — we never re-read /send for URL data.
      const persistCreate: Partial<InsertDevis> = {
        archisignEnvelopeId: createResp.envelopeId,
        archisignAccessUrl: createResp.accessUrl,
        archisignAccessUrlInvalidatedAt: null,
        archisignOtpDestination: createResp.otpDestination,
        archisignEnvelopeExpiresAt: createResp.expiresAt ? new Date(createResp.expiresAt) : null,
        archisignEnvelopeStatus: "sent",
        // Persist the architect's personalised note on first send. We keep our
        // own copy because Archisign does not echo it back and may not render
        // it in the signer email — this closes the audit loop. Written only
        // here (the resume branch skips /create), never overwritten on retry.
        archisignSignerMessage: personalMessage ?? null,
      };
      await storage.updateDevis(devisId, persistCreate);
      envelopeId = createResp.envelopeId;
      accessUrl = createResp.accessUrl;
      otpDestination = createResp.otpDestination;
      expiresAtIso = createResp.expiresAt ?? null;
    }

    if (!envelopeId) {
      // Defensive — should be unreachable.
      return res.status(500).json({ message: "Envelope ID missing after create" });
    }

    try {
      await sendEnvelope(envelopeId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[Archisign] sendEnvelope failed for devis ${devisId} envelope ${envelopeId} (resuming=${resumingExistingEnvelope}):`,
        detail,
      );
      // The envelope exists on Archisign side. Architect can retry this
      // endpoint and we will resume from /send (envelopeId is persisted,
      // stage is still approved_for_signing).
      return res.status(502).json({
        message: "Enveloppe créée mais l'envoi à Archisign a échoué. Réessayez.",
        code: "archisign_send_failed",
        archisignEnvelopeId: envelopeId,
        detail,
      });
    }

    // Advance signOffStage. If this DB write fails, the next architect
    // click will reach this same point: envelopeId set, stage still
    // `approved_for_signing` → resume path skips /create, re-calls
    // /send (no-op on Archisign side), and re-attempts the stage
    // advance. The webhook receiver further mutates
    // archisignEnvelopeStatus on subsequent events.
    let updated;
    try {
      const stageUpdate: Partial<InsertDevis> = {
        signOffStage: "sent_to_client",
      };
      updated = await storage.updateDevis(devisId, stageUpdate);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[Archisign] stage advance failed for devis ${devisId}:`, detail);
      return res.status(502).json({
        message:
          "Enveloppe envoyée à Archisign mais la mise à jour du devis a échoué. Réessayez.",
        code: "stage_advance_failed",
        archisignEnvelopeId: envelopeId,
        detail,
      });
    }

    // Task #257 — deliver the architect's written context to the client via
    // the architect's Gmail, logged in project_communications. Runs AFTER
    // the stage advance: an email failure must never roll back the envelope
    // — it is surfaced to the architect as a visible warning instead.
    // Idempotent per (devis, envelope), so the resume path won't double-send.
    const contextMessage =
      personalMessage ?? d.archisignSignerMessage ?? null;
    let contextEmail: DevisContextEmailResult;
    if (contextMessage) {
      contextEmail = await sendDevisSignatureContextEmail({
        devisId,
        envelopeId,
        message: contextMessage,
      });
    } else {
      // Only reachable on the resume branch for pre-Task-#257 envelopes
      // that were created without a message.
      contextEmail = {
        communicationId: null,
        status: "failed",
        error: "Aucun message d'accompagnement persisté pour ce devis.",
      };
    }

    return res.status(200).json({
      ok: true,
      devisId,
      archisignEnvelopeId: envelopeId,
      archisignAccessUrl: accessUrl,
      otpDestination,
      expiresAt: expiresAtIso,
      signOffStage: updated?.signOffStage ?? "sent_to_client",
      resumed: resumingExistingEnvelope,
      contextEmail,
    });
  },
);

export default router;
