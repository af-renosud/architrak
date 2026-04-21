import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { storage } from "../storage";
import { env } from "../env";
import {
  devisTranslationLineSchema,
  devisTranslationHeaderSchema,
  type DevisTranslationLine,
  type DevisTranslationHeader,
  type Devis,
  type DevisLineItem,
} from "@shared/schema";
import { z } from "zod";

const TASK_TYPE = "devis_translation";

const SYSTEM_PROMPT = `You translate French construction (BTP) quotation documents to English for a Ukrainian/English-speaking architect's client.

For every line item AND the document header you produce TWO fields:

1. "translation": A faithful, conservative literal English translation of the French text. Do NOT add or omit information. Preserve numbers, units, brand names, technical terms unchanged when they have no clean English equivalent. This must be audit-grade — usable in legal/financial review.

2. "explanation" (optional, ≤ 25 words): One short plain-English sentence explaining what the line means in practical terms, ONLY when the French uses BTP jargon, French-specific products, or a non-obvious term. Leave null when the literal translation is already self-explanatory.

NEVER invent numbers, prices, or quantities that are not in the source. NEVER change quantities or units.`;

const responseSchema = z.object({
  header: devisTranslationHeaderSchema,
  lines: z.array(devisTranslationLineSchema),
});

export type DevisTranslationResult = z.infer<typeof responseSchema>;

let geminiClient: GoogleGenerativeAI | null = null;
function getGemini(): GoogleGenerativeAI {
  if (!geminiClient) {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
    geminiClient = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  return geminiClient;
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) {
    if (!env.AI_INTEGRATIONS_OPENAI_API_KEY) throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY not set");
    openaiClient = new OpenAI({ apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY });
  }
  return openaiClient;
}

async function getActiveModel(): Promise<{ provider: string; modelId: string }> {
  try {
    const setting = await storage.getAiModelSetting(TASK_TYPE);
    if (setting) return { provider: setting.provider, modelId: setting.modelId };
  } catch {}
  return { provider: "gemini", modelId: "gemini-2.5-flash" };
}

function buildUserPrompt(devis: Devis, lines: DevisLineItem[]): string {
  const headerText = devis.descriptionFr || "";
  const linesPayload = lines.map((l) => ({
    lineNumber: l.lineNumber,
    description: l.description,
  }));
  return JSON.stringify(
    {
      headerDescriptionFr: headerText,
      lines: linesPayload,
      instructions:
        "Return JSON: { header: { description, descriptionExplanation, summary }, lines: [{ lineNumber, originalDescription, translation, explanation }] }. summary is a 1-2 sentence plain-English overview of the entire document scope.",
    },
    null,
    2,
  );
}

const GEMINI_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    header: {
      type: SchemaType.OBJECT,
      properties: {
        description: { type: SchemaType.STRING },
        descriptionExplanation: { type: SchemaType.STRING },
        summary: { type: SchemaType.STRING },
      },
    },
    lines: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          lineNumber: { type: SchemaType.INTEGER },
          originalDescription: { type: SchemaType.STRING },
          translation: { type: SchemaType.STRING },
          explanation: { type: SchemaType.STRING },
        },
        required: ["lineNumber", "originalDescription", "translation"],
      },
    },
  },
  required: ["header", "lines"],
} as const;

async function translateWithGemini(prompt: string, modelId: string): Promise<DevisTranslationResult> {
  const model = getGemini().getGenerativeModel({
    model: modelId,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: GEMINI_RESPONSE_SCHEMA as never,
      temperature: 0,
    },
  });
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const parsed = JSON.parse(text);
  return responseSchema.parse(parsed);
}

async function translateWithOpenAI(prompt: string, modelId: string): Promise<DevisTranslationResult> {
  const openai = getOpenAI();
  const response = await openai.chat.completions.create({
    model: modelId || "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  const content = response.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);
  return responseSchema.parse(parsed);
}

export interface TranslateDevisOptions {
  force?: boolean;
}

export async function translateDevis(
  devisId: number,
  opts: TranslateDevisOptions = {},
): Promise<{
  translation: { header: DevisTranslationHeader; lines: DevisTranslationLine[] };
  provider: string;
  modelId: string;
}> {
  const devis = await storage.getDevis(devisId);
  if (!devis) throw new Error(`Devis ${devisId} not found`);

  if (!opts.force) {
    const existing = await storage.getDevisTranslation(devisId);
    if (existing && existing.status === "completed") {
      return {
        translation: {
          header: (existing.headerTranslated as DevisTranslationHeader) || {},
          lines: (existing.lineTranslations as DevisTranslationLine[]) || [],
        },
        provider: existing.provider || "gemini",
        modelId: existing.modelId || "gemini-2.5-flash",
      };
    }
  }

  const lines = await storage.getDevisLineItems(devisId);
  await storage.upsertDevisTranslation({
    devisId,
    status: "processing",
    headerTranslated: null,
    lineTranslations: null,
    errorMessage: null,
    translatedPdfStorageKey: null,
    combinedPdfStorageKey: null,
    provider: null,
    modelId: null,
  });

  const { provider, modelId } = await getActiveModel();
  const prompt = buildUserPrompt(devis, lines);

  try {
    const result = provider === "openai"
      ? await translateWithOpenAI(prompt, modelId)
      : await translateWithGemini(prompt, modelId);

    await storage.updateDevisTranslation(devisId, {
      status: "completed",
      provider,
      modelId,
      headerTranslated: result.header,
      lineTranslations: result.lines,
      errorMessage: null,
      translatedPdfStorageKey: null,
      combinedPdfStorageKey: null,
    });

    return { translation: result, provider, modelId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await storage.updateDevisTranslation(devisId, {
      status: "failed",
      errorMessage: message,
    });
    throw err;
  }
}

export function triggerDevisTranslation(devisId: number): void {
  setImmediate(() => {
    translateDevis(devisId).catch((err) => {
      console.warn(`[DevisTranslation] Background translation failed for devis ${devisId}:`, err instanceof Error ? err.message : err);
    });
  });
}
