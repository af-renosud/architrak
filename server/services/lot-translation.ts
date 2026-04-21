import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { storage } from "../storage";
import { env } from "../env";
import { z } from "zod";

const TASK_TYPE = "devis_translation";

const SYSTEM_PROMPT = `You translate French construction (BTP) lot/trade names into the canonical, short English name used on construction documents.

Rules:
- Return the standard English construction trade name (e.g. "Plomberie" -> "Plumbing", "Menuiseries extérieures" -> "Exterior Joinery", "Gros œuvre" -> "Structural Works").
- Keep it short — usually 1 to 4 words. No trailing punctuation.
- Use Title Case.
- Do NOT add explanations, codes, or quotation marks.
- If the French text is itself already English or a proper noun, return it unchanged with normalised casing.`;

const responseSchema = z.object({
  translation: z.string().min(1).max(200),
});

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
    const setting =
      (await storage.getAiModelSetting("document_parsing")) ??
      (await storage.getAiModelSetting(TASK_TYPE));
    if (setting) return { provider: setting.provider, modelId: setting.modelId };
  } catch (err) {
    console.warn(
      `[LotTranslation] Failed to load ai_model_settings, falling back to default:`,
      err instanceof Error ? err.message : err,
    );
  }
  return { provider: "gemini", modelId: "gemini-2.5-flash" };
}

const GEMINI_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    translation: { type: SchemaType.STRING },
  },
  required: ["translation"],
} as const;

function buildPrompt(code: string | undefined, descriptionFr: string): string {
  return JSON.stringify(
    {
      lotCode: code ?? null,
      descriptionFr,
      instructions:
        'Return JSON: { "translation": "<canonical English construction trade name>" }',
    },
    null,
    2,
  );
}

async function translateWithGemini(prompt: string, modelId: string): Promise<string> {
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
  const parsed = responseSchema.parse(JSON.parse(text));
  return parsed.translation.trim();
}

async function translateWithOpenAI(prompt: string, modelId: string): Promise<string> {
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
  const parsed = responseSchema.parse(JSON.parse(content));
  return parsed.translation.trim();
}

export async function translateLotDescription(
  descriptionFr: string,
  code?: string,
): Promise<{ translation: string; provider: string; modelId: string }> {
  const trimmed = descriptionFr.trim();
  if (!trimmed) throw new Error("French description is required");

  const { provider, modelId } = await getActiveModel();
  const prompt = buildPrompt(code, trimmed);

  const translation =
    provider === "openai"
      ? await translateWithOpenAI(prompt, modelId)
      : await translateWithGemini(prompt, modelId);

  return { translation, provider, modelId };
}
