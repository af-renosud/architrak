// Task #231 — Gemini reasoning layer.
//
// Given a primary devis and a set of candidate member devis (surfaced by
// the arithmetic and/or semantic layers), ask Gemini to classify the
// relationship and cite the specific scope lines that justify it. This is
// the disambiguation step: it tells a real consolidation apart from a
// coincidental subset-sum, and produces human-readable citations.
//
// AI-OPTIONAL: returns null when GEMINI_API_KEY is absent. Callers must
// degrade to deterministic arithmetic-only verdicts in that case.

import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { env } from "../../env";
import { storage } from "../../storage";
import { OVERLAP_RELATIONSHIP_TYPES, type OverlapRelationshipType } from "@shared/schema";
import type { DevisScope } from "./scope-lines";

export interface ReasoningCitation {
  devisId: number;
  lineNumber: number | null;
  description: string;
}

export interface ReasoningResult {
  relationshipType: OverlapRelationshipType;
  confidence: number; // 0..1
  reasoning: string;
  citations: ReasoningCitation[];
}

const RELATIONSHIP_SET = new Set<string>(OVERLAP_RELATIONSHIP_TYPES);

const SYSTEM = `Tu es un expert en finances de chantier (maîtrise d'œuvre française). On te donne un devis "primaire" et un ou plusieurs devis "candidats" du même projet. Détermine la relation du devis primaire envers l'ENSEMBLE des candidats:
- "aggregates": le primaire est un devis consolidé qui REGROUPE/ABSORBE les candidats (risque de double comptage).
- "contains": le primaire inclut intégralement le périmètre d'un ou plusieurs candidats.
- "supersedes": le primaire remplace une version antérieure (même périmètre, devis mis à jour).
- "duplicate": le primaire est un doublon quasi identique d'un candidat.
- "unrelated": aucune relation dangereuse (la correspondance arithmétique est fortuite).
Cite les lignes précises qui justifient ta conclusion. Sois prudent: en cas de doute, baisse la confiance.`;

const schema: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    relationshipType: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
    reasoning: { type: SchemaType.STRING },
    citations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          devisId: { type: SchemaType.NUMBER },
          lineNumber: { type: SchemaType.NUMBER },
          description: { type: SchemaType.STRING },
        },
        required: ["devisId", "description"],
      },
    },
  },
  required: ["relationshipType", "confidence", "reasoning", "citations"],
};

function serializeScope(scope: DevisScope, role: "primary" | "candidate") {
  return {
    role,
    devisId: scope.devisId,
    devisCode: scope.devisCode,
    totalHt: (scope.totalCents / 100).toFixed(2),
    lines: scope.lines.map((l) => ({
      lineNumber: l.lineNumber,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      totalHt: (l.totalCents / 100).toFixed(2),
    })),
  };
}

/**
 * Classify the relationship of `primary` against `members`. Returns null
 * when AI is unavailable or the model output is unusable.
 */
export async function classifyRelationship(
  primary: DevisScope,
  members: DevisScope[],
): Promise<ReasoningResult | null> {
  const key = env.GEMINI_API_KEY;
  if (!key || members.length === 0) return null;

  const setting = await storage.getAiModelSetting("document_parsing").catch(() => undefined);
  const modelId = setting?.modelId ?? "gemini-2.5-flash";

  const payload = {
    primary: serializeScope(primary, "primary"),
    candidates: members.map((m) => serializeScope(m, "candidate")),
  };
  const USER = `Devis à analyser:\n${JSON.stringify(payload)}\n\nRetourne UNIQUEMENT le JSON demandé.`;

  try {
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: SYSTEM,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0,
      },
    });
    const result = await model.generateContent(USER);
    const parsed = JSON.parse(result.response.text()) as {
      relationshipType?: string;
      confidence?: number;
      reasoning?: string;
      citations?: Array<{ devisId?: number; lineNumber?: number; description?: string }>;
    };

    const relationshipType = RELATIONSHIP_SET.has(parsed.relationshipType ?? "")
      ? (parsed.relationshipType as OverlapRelationshipType)
      : "unrelated";
    const confidenceRaw = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    const confidence = Math.min(1, Math.max(0, confidenceRaw));
    const validIds = new Set<number>([primary.devisId, ...members.map((m) => m.devisId)]);
    const citations: ReasoningCitation[] = (parsed.citations ?? [])
      .filter((c) => typeof c.devisId === "number" && validIds.has(c.devisId) && typeof c.description === "string")
      .map((c) => ({
        devisId: c.devisId as number,
        lineNumber: typeof c.lineNumber === "number" ? c.lineNumber : null,
        description: String(c.description),
      }));

    return {
      relationshipType,
      confidence,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      citations,
    };
  } catch (err) {
    console.warn("[reconciliation] reasoning failed:", (err as Error).message);
    return null;
  }
}
