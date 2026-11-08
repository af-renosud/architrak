import { createHash } from "node:crypto";
import type { NextActionExplanation, QuotationNextAction } from "@shared/quotation-next-actions";
import { generateWithGemini } from "./gemini";

// AI selects relevant supporting explanations, but never writes financial facts,
// links or instructions. All rendered sentences come from verified server text.
// This also prevents document content/prompt injection entering the request.
export async function explainQuotationAction(action: QuotationNextAction): Promise<NextActionExplanation> {
  const fallback = `${action.why} ${action.nextStep}`;
  const sentences: Record<string, string> = {
    safety: "Opening this suggestion does not create, send or confirm anything.",
  };
  if (action.certificateId) sentences.evidence = "A certificate and a recorded payment are separate records; the certificate alone is not proof of payment.";
  if (action.actor !== "architect") sentences.waiting = "This is not a request to make or record a payment. Check the existing records if new evidence arrives.";
  if (action.code === "prepare_signature" || action.code === "review_signing") {
    sentences.signing = "The current signing safeguards and any required architect authorisation still apply.";
  }
  if (action.code === "prepare_deposit") sentences.confirmation = "Generating a draft certificate requires a separate confirmation, and sending it is a later action.";
  try {
    const result = await generateWithGemini({
      timeoutMs: 15_000,
      systemPrompt: 'Choose up to two useful supporting explanation IDs for this verified workflow situation. Return ONLY JSON {"ids":["id"]}. Use only provided IDs. Do not generate text, financial advice or new actions.',
      userContent: JSON.stringify({ code: action.code, actor: action.actor, why: action.why, nextStep: action.nextStep, choices: sentences }),
    });
    const parsed = JSON.parse(result.text);
    if (!Array.isArray(parsed.ids) || parsed.ids.length > 2 || parsed.ids.length === 0 ||
        parsed.ids.some((id: unknown) => typeof id !== "string" || !Object.hasOwn(sentences, id))) {
      throw new Error("Invalid explanation selection");
    }
    return { actionId: action.id, source: "ai",
      explanation: `${fallback} ${Array.from(new Set<string>(parsed.ids)).map(id => sentences[id]).join(" ")}` };
  } catch {
    // Explicitly labelled fallback; no provider exception text or credentials leak.
    return { actionId: action.id, source: "fallback", explanation: fallback };
  }
}

/** Facts, not identifiers alone: any workflow change invalidates an explanation. */
export function actionFingerprint(action: QuotationNextAction) {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}
