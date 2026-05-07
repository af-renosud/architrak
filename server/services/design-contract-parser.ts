/**
 * Gemini-powered extractor for French architecture design
 * contracts ("Contrat de Maîtrise d'Œuvre"). Reuses the same model
 * selection + retry plumbing as the devis/invoice document-parser, but
 * targets a contract-specific JSON schema: total HT/TVA/TTC, contract
 * date/reference, conception vs planning split, and an ordered payment
 * schedule (label, percentage, amount).
 *
 * The output is consumed by the New Project review modal — the architect
 * always confirms or corrects before persistence (no auto-create path).
 */
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { retry } from "../lib/retry";
import { env } from "../env";
import { roundCurrency } from "../../shared/financial-utils";
import {
  pdfToImages,
  isTransientGeminiError,
} from "../gmail/document-parser";

export interface ExtractedDesignContractMilestone {
  /** 1-indexed sequence as they appear in the schedule. */
  sequence: number;
  /** French label exactly as written in the contract (e.g. "À la signature"). */
  labelFr: string;
  /** English translation if the contract is bilingual; otherwise null. */
  labelEn: string | null;
  /** 0–100. The four-row 50/30/10/10 schedule sums to exactly 100. */
  percentage: number;
  /** TTC amount in euros, 2-decimal rounded. */
  amountTtc: number;
  /** Heuristic mapping to an Architrak lifecycle event; defaults to manual. */
  triggerEvent:
    | "file_opened"
    | "concept_signed"
    | "permit_deposited"
    | "final_plans_signed"
    | "manual";
}

export interface ExtractedDesignContract {
  /**
   * `design_contract` when the model is confident the PDF is an architect/
   * client design contract; otherwise `unknown` and the upload is rejected
   * upstream.
   */
  documentType: "design_contract" | "unknown";
  totalHt: number | null;
  totalTva: number | null;
  totalTtc: number | null;
  tvaRate: number | null;
  conceptionAmountHt: number | null;
  planningAmountHt: number | null;
  contractDate: string | null;
  contractReference: string | null;
  clientName: string | null;
  architectName: string | null;
  projectAddress: string | null;
  milestones: ExtractedDesignContractMilestone[];
  /** Free-form per-field 0-1 confidence map for the review-modal UI. */
  confidence: Record<string, number>;
  /** Raw model warnings — surfaced verbatim in the review modal. */
  warnings: string[];
  /** Set on transient AI failure so the route handler can return 503. */
  transientFailure?: boolean;
  /** Human-readable error if extraction failed entirely. */
  errorMessage?: string;
}

const SYSTEM_PROMPT = `You are a financial-data extraction assistant for a French \
architectural firm (maîtrise d'œuvre). The user uploads a French-language \
design-services contract ("Contrat de maîtrise d'œuvre" / "Contrat d'architecte" \
/ "Contrat de mission") that the architect signs with the project owner. Your \
job is to extract the contracted total amount and the payment schedule.

Strict rules:
- All currency amounts are in euros. Round to 2 decimals.
- "HT" = hors taxes (excl. VAT); "TTC" = toutes taxes comprises (incl. VAT); \
  "TVA" = VAT amount. French TVA on architect services is typically 20%.
- The payment schedule is usually expressed as percentages tied to project \
  milestones. Common French phases: APS (Avant-Projet Sommaire), APD \
  (Avant-Projet Définitif), PC / DP (dépôt du Permis de Construire / \
  Déclaration Préalable), PRO (Projet), DCE (Dossier de Consultation des \
  Entreprises), VISA, DET (Direction de l'Exécution des Travaux), AOR \
  (Assistance aux Opérations de Réception).
- Map each milestone label to ONE of these triggerEvent values:
  - "file_opened" — at signature / opening of the file (e.g. "à la signature", \
    "ouverture du dossier", APS).
  - "concept_signed" — concept design approved by client (APD, PRO).
  - "permit_deposited" — permit lodged with the mairie (dépôt du permis, PC, DP).
  - "final_plans_signed" — final plans / DCE signed off (DCE, VISA).
  - "manual" — anything that doesn't clearly map (DET, AOR, suivi de chantier, \
    réception des travaux).
- Percentages MUST sum to 100. Amounts MUST sum to totalTtc (±0.05€ rounding).
- If the document is NOT a design-services contract (e.g. it's a devis from a \
  builder, an invoice, a permit application), set documentType="unknown" and \
  leave the other fields null/empty.
- If the contract splits the total into "conception" (design) vs "planning" \
  (permit / DPC) sub-totals, populate conceptionAmountHt and planningAmountHt; \
  otherwise leave them null.
- "confidence" is a per-field 0-1 score reflecting how directly each value was \
  read from the PDF (1 = printed verbatim; 0.5 = computed; 0 = guessed).`;

const USER_PROMPT = `Extract the design-services contract metadata and the \
payment schedule. Return JSON only matching the schema.`;

const EXTRACTION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    documentType: {
      type: SchemaType.STRING,
      description: "design_contract or unknown",
      enum: ["design_contract", "unknown"],
      format: "enum",
    },
    totalHt: { type: SchemaType.NUMBER, nullable: true },
    totalTva: { type: SchemaType.NUMBER, nullable: true },
    totalTtc: { type: SchemaType.NUMBER, nullable: true },
    tvaRate: { type: SchemaType.NUMBER, nullable: true },
    conceptionAmountHt: { type: SchemaType.NUMBER, nullable: true },
    planningAmountHt: { type: SchemaType.NUMBER, nullable: true },
    contractDate: { type: SchemaType.STRING, nullable: true, description: "ISO YYYY-MM-DD" },
    contractReference: { type: SchemaType.STRING, nullable: true },
    clientName: { type: SchemaType.STRING, nullable: true },
    architectName: { type: SchemaType.STRING, nullable: true },
    projectAddress: { type: SchemaType.STRING, nullable: true },
    milestones: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          sequence: { type: SchemaType.INTEGER },
          labelFr: { type: SchemaType.STRING },
          labelEn: { type: SchemaType.STRING, nullable: true },
          percentage: { type: SchemaType.NUMBER },
          amountTtc: { type: SchemaType.NUMBER },
          triggerEvent: {
            type: SchemaType.STRING,
            enum: [
              "file_opened",
              "concept_signed",
              "permit_deposited",
              "final_plans_signed",
              "manual",
            ],
            format: "enum",
          },
        },
        required: ["sequence", "labelFr", "percentage", "amountTtc", "triggerEvent"],
      },
    },
    confidence: {
      type: SchemaType.OBJECT,
      description: "Per-field 0-1 confidence map",
      properties: {
        totalTtc: { type: SchemaType.NUMBER, nullable: true },
        totalHt: { type: SchemaType.NUMBER, nullable: true },
        milestones: { type: SchemaType.NUMBER, nullable: true },
        contractDate: { type: SchemaType.STRING, nullable: true },
      },
    },
    warnings: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
  },
  required: ["documentType", "milestones", "warnings"],
};

function getGeminiClient(): GoogleGenerativeAI {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  return new GoogleGenerativeAI(key);
}

async function callGemini(images: Buffer[], modelId: string): Promise<unknown> {
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({
    model: modelId,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: EXTRACTION_SCHEMA,
      temperature: 0,
    },
  });
  const imageParts = images.map((buf) => ({
    inlineData: {
      mimeType: "image/png" as const,
      data: buf.toString("base64"),
    },
  }));
  return retry(
    async () => {
      const result = await model.generateContent([USER_PROMPT, ...imageParts]);
      return JSON.parse(result.response.text());
    },
    {
      retries: 2,
      baseMs: 500,
      maxMs: 6000,
      factor: 3,
      jitter: true,
      shouldRetry: isTransientGeminiError,
    },
  );
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return roundCurrency(value);
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

function normaliseMilestones(raw: unknown, totalTtc: number | null): ExtractedDesignContractMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtractedDesignContractMilestone[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== "object") continue;
    const sequence = typeof r.sequence === "number" && Number.isInteger(r.sequence) ? r.sequence : i + 1;
    const labelFr = asStringOrNull(r.labelFr);
    const percentage = typeof r.percentage === "number" ? Math.max(0, Math.min(100, r.percentage)) : null;
    let amount = asNumberOrNull(r.amountTtc);
    if (amount === null && percentage !== null && totalTtc !== null) {
      amount = roundCurrency((percentage / 100) * totalTtc);
    }
    const triggerEvent = (r.triggerEvent ?? "manual") as ExtractedDesignContractMilestone["triggerEvent"];
    if (!labelFr || percentage === null || amount === null) continue;
    out.push({
      sequence,
      labelFr,
      labelEn: asStringOrNull(r.labelEn),
      percentage: roundCurrency(percentage),
      amountTtc: amount,
      triggerEvent: [
        "file_opened",
        "concept_signed",
        "permit_deposited",
        "final_plans_signed",
        "manual",
      ].includes(triggerEvent) ? triggerEvent : "manual",
    });
  }
  return out;
}

function normaliseConfidence(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.max(0, Math.min(1, v));
    }
  }
  return out;
}

export interface ParseDesignContractDeps {
  pdfToImages?: (pdf: Buffer) => Promise<Buffer[]>;
  callGemini?: (images: Buffer[], modelId: string) => Promise<unknown>;
  modelId?: string;
}

export async function parseDesignContract(
  pdfBuffer: Buffer,
  fileName: string,
  deps: ParseDesignContractDeps = {},
): Promise<ExtractedDesignContract> {
  const _pdfToImages = deps.pdfToImages ?? pdfToImages;
  const _callGemini = deps.callGemini ?? callGemini;
  const modelId = deps.modelId ?? "gemini-2.5-flash";

  let images: Buffer[];
  try {
    console.log(`[design-contract-parser] Converting "${fileName}" to images...`);
    images = await _pdfToImages(pdfBuffer, 8);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyResult({ errorMessage: `Could not render PDF: ${message}` });
  }
  if (images.length === 0) {
    return emptyResult({ errorMessage: "PDF rendered to zero pages" });
  }

  let raw: unknown;
  try {
    raw = await _callGemini(images, modelId);
  } catch (err) {
    const transient = isTransientGeminiError(err);
    const message = err instanceof Error ? err.message : String(err);
    return emptyResult({
      transientFailure: transient,
      errorMessage: `Gemini extraction ${transient ? "temporarily unavailable" : "failed"}: ${message}`,
    });
  }

  const r = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const documentType = r.documentType === "design_contract" ? "design_contract" : "unknown";
  const totalHt = asNumberOrNull(r.totalHt);
  const totalTva = asNumberOrNull(r.totalTva);
  const totalTtc = asNumberOrNull(r.totalTtc);
  const milestones = normaliseMilestones(r.milestones, totalTtc);

  return {
    documentType,
    totalHt,
    totalTva,
    totalTtc,
    tvaRate: asNumberOrNull(r.tvaRate),
    conceptionAmountHt: asNumberOrNull(r.conceptionAmountHt),
    planningAmountHt: asNumberOrNull(r.planningAmountHt),
    contractDate: asStringOrNull(r.contractDate),
    contractReference: asStringOrNull(r.contractReference),
    clientName: asStringOrNull(r.clientName),
    architectName: asStringOrNull(r.architectName),
    projectAddress: asStringOrNull(r.projectAddress),
    milestones,
    confidence: normaliseConfidence(r.confidence),
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

function emptyResult(extra: Partial<ExtractedDesignContract>): ExtractedDesignContract {
  return {
    documentType: "unknown",
    totalHt: null,
    totalTva: null,
    totalTtc: null,
    tvaRate: null,
    conceptionAmountHt: null,
    planningAmountHt: null,
    contractDate: null,
    contractReference: null,
    clientName: null,
    architectName: null,
    projectAddress: null,
    milestones: [],
    confidence: {},
    warnings: [],
    ...extra,
  };
}

/**
 * Cheap server-side validation gate before persistence. Returns an error
 * code (matching `DESIGN_CONTRACT_ERROR_CODES`) or null when the payload
 * passes. Tolerant of small rounding error (±0.05€, ±0.05pp) because the
 * AI output already round-trips through 2-decimal rounding.
 */
export function validateConfirmedSchedule(
  totalTtc: number,
  milestones: ExtractedDesignContractMilestone[],
): { ok: true } | { ok: false; code: "DESIGN_CONTRACT_MILESTONES_PCT_NOT_100" | "DESIGN_CONTRACT_MILESTONES_TOTAL_MISMATCH"; detail: string } {
  if (milestones.length === 0) {
    return { ok: false, code: "DESIGN_CONTRACT_MILESTONES_PCT_NOT_100", detail: "At least one milestone is required" };
  }
  const pctSum = milestones.reduce((acc, m) => acc + m.percentage, 0);
  if (Math.abs(pctSum - 100) > 0.05) {
    return {
      ok: false,
      code: "DESIGN_CONTRACT_MILESTONES_PCT_NOT_100",
      detail: `Milestone percentages sum to ${pctSum.toFixed(2)}%, expected 100.00%`,
    };
  }
  const amountSum = milestones.reduce((acc, m) => acc + m.amountTtc, 0);
  if (Math.abs(amountSum - totalTtc) > 0.05) {
    return {
      ok: false,
      code: "DESIGN_CONTRACT_MILESTONES_TOTAL_MISMATCH",
      detail: `Milestone amounts sum to €${amountSum.toFixed(2)}, expected total TTC €${totalTtc.toFixed(2)}`,
    };
  }
  return { ok: true };
}
