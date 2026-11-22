import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

/** Only model-authored fields are allowed through this boundary. */
const number = z.number().finite().nullable().optional().transform(v => v ?? undefined);
const text = z.string().nullable().optional().transform(v => v ?? undefined);
const line = z.object({
  description: z.string(),
  quantity: number, unit: text, unitPrice: number, total: number,
  percentComplete: number, pageHint: number,
  // A guessed/malformed visual hint is not financial evidence. Discard it,
  // rather than inventing coordinates or rejecting otherwise valid figures.
  bbox: z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  }).nullable().optional().catch(undefined),
});
const responseSchema = z.object({
  documentType: z.enum(["quotation", "invoice", "situation", "avenant", "acompte", "commande",
    "architect_fee_invoice", "payment_confirmation", "other", "unknown"]),
  situationNumber: z.number().int().positive().nullable().optional().transform(v => v ?? undefined),
  contractorName: text, clientName: text, projectAddress: text,
  projectName: text, projectReference: text, reference: text, invoiceNumber: text,
  devisNumber: text, siret: text, tvaIntracom: text, date: text, description: text,
  amountHt: number, amountTtc: number, tvaAmount: number, preTaxChargesHt: number,
  tvaRate: number, retenueDeGarantie: number, netAPayer: number,
  acomptePaidAmountTtc: number, acomptePaidEvidenceText: text, openingDepositEvidenceText: text,
  acomptePercent: number, acompteAmountHt: number, acompteTrigger: text,
  paymentTerms: text, iban: text, bic: text,
  autoLiquidation: z.boolean().nullable().optional(),
  acompteRequired: z.boolean().nullable().optional(),
  declaredTvaRates: z.array(z.number().finite()).nullable().optional(),
  lotReferences: z.array(z.string()).nullable().optional(),
  lineItems: z.array(line).nullable().optional(),
  relatedDocumentReferences: z.array(z.object({
    kind: z.enum(["quotation", "order", "invoice"]), reference: z.string(),
    evidenceText: z.string(), page: number,
  })).nullable().optional(),
});

export class ExtractionResponseError extends Error {
  constructor(readonly code: "invalid_json" | "invalid_shape" | "empty_response" | "truncated_response" | "deadline") {
    super({
      invalid_json: "The AI returned invalid JSON.",
      invalid_shape: "The AI returned an invalid document structure.",
      empty_response: "The AI returned no document content.",
      truncated_response: "The AI response was truncated.",
      deadline: "Extraction timed out within its time budget.",
    }[code]);
    this.name = "ExtractionResponseError";
  }
}

export function extractionFailure(error: unknown, stage = "ai_response", chunk?: number) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof ExtractionResponseError ? error.code
    : /402|prepayment credits|billing|quota.*exceed/i.test(message) ? "provider_billing"
    : /401|403|API key/i.test(message) ? "provider_access"
    : /\[400|\[404|image too large/i.test(message) ? "provider_input"
    : /429|rate limit/i.test(message) ? "provider_busy"
    : /timeout|timed out|deadline/i.test(message) ? "deadline"
    : error instanceof SyntaxError ? "invalid_json" : "provider_unavailable";
  return { code, stage, ...(chunk ? { chunk } : {}), message:
    code === "provider_billing" ? "The AI provider has no available credit. Check the provider account before retrying."
    : code === "provider_access" ? "The AI provider rejected access. Check its connection before retrying."
    : code === "provider_input" ? "The AI provider rejected this document or model. Review the PDF and extraction settings."
    : code === "deadline" ? "Extraction timed out. Retry or review the original PDF."
    : code === "invalid_json" || code === "invalid_shape" || code === "truncated_response" || code === "empty_response"
      ? "The AI did not return a complete, readable result. Retry extraction; the original is unchanged."
      : "The AI provider could not complete extraction. Retry when the service is available.",
  };
}

export function decodeExtractionResponse(content: string, finishReason?: string | null) {
  if (finishReason && !["STOP", "stop"].includes(finishReason)) {
    throw new ExtractionResponseError("truncated_response");
  }
  if (!content.trim()) throw new ExtractionResponseError("empty_response");
  let value: unknown;
  try { value = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()); }
  catch { throw new ExtractionResponseError("invalid_json"); }
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) {
    console.warn("[ExtractionResponse] Invalid fields:", parsed.error.issues.map(issue => ({
      field: issue.path.join("."), code: issue.code,
    })));
    throw new ExtractionResponseError("invalid_shape");
  }
  // Models cannot mint source-verification receipts, recovery evidence or audit fields.
  return Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v != null));
}

export const EXTRACTION_BUDGET_MS = 8 * 60_000;
export const EXTRACTION_CALL_MS = 60_000;
const context = new AsyncLocalStorage<{ deadline: number; controller: AbortController }>();

export async function withExtractionBudget<T>(fn: () => Promise<T>, budgetMs = EXTRACTION_BUDGET_MS): Promise<T> {
  const controller = new AbortController();
  return context.run({ deadline: Date.now() + budgetMs, controller }, async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([fn(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ExtractionResponseError("deadline"));
        }, budgetMs);
      })]);
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  });
}

export async function boundedExtractionCall<T>(fn: (signal: AbortSignal, timeout: number) => Promise<T>): Promise<T> {
  const state = context.getStore();
  const remaining = state ? state.deadline - Date.now() : EXTRACTION_CALL_MS;
  if (remaining <= 0 || state?.controller.signal.aborted) throw new ExtractionResponseError("deadline");
  const timeout = Math.min(remaining, EXTRACTION_CALL_MS);
  const controller = new AbortController();
  const abort = () => controller.abort();
  state?.controller.signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(controller.signal, timeout), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ExtractionResponseError("deadline")); }, timeout);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    state?.controller.signal.removeEventListener("abort", abort);
  }
}
