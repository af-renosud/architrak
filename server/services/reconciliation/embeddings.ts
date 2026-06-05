// Task #231 — semantic embedding layer (Gemini + pgvector).
//
// Wraps Gemini's `text-embedding-004` model (768-dim) and the
// per-devis embedding cache. The cache is keyed by devis id with a
// content hash, so a reconciliation re-run only re-embeds devis whose
// canonical text changed. Embeddings are an OPTIONAL enrichment: when
// GEMINI_API_KEY is absent every function degrades to a no-op and the
// engine falls back to deterministic arithmetic-only detection.

import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../env";
import { storage } from "../../storage";
import { DEVIS_EMBEDDING_DIMENSIONS } from "@shared/schema";
import type { DevisScope } from "./scope-lines";

export const EMBEDDING_MODEL = "text-embedding-004";

/** True when the embedding/reasoning AI layers are usable. */
export function isAiAvailable(): boolean {
  return Boolean(env.GEMINI_API_KEY);
}

/**
 * Embed a single text. Returns null when AI is unavailable or the model
 * returns an unexpected dimension (defensive — a dimension mismatch must
 * never reach the pgvector column).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const key = env.GEMINI_API_KEY;
  if (!key) return null;
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent(text);
  const values = result.embedding?.values;
  if (!Array.isArray(values) || values.length !== DEVIS_EMBEDDING_DIMENSIONS) {
    console.warn(
      `[reconciliation] unexpected embedding dimension: ${values?.length ?? "none"} (want ${DEVIS_EMBEDDING_DIMENSIONS})`,
    );
    return null;
  }
  return values;
}

/**
 * Ensure every scope has a current embedding row. Skips devis whose
 * cached contentHash already matches (no model call). Failures for an
 * individual devis are logged and swallowed so one bad embed doesn't
 * abort the whole run. Returns the count of devis that now have a usable
 * (fresh or pre-existing) embedding.
 */
export async function ensureScopeEmbeddings(projectId: number, scopes: DevisScope[]): Promise<number> {
  if (!isAiAvailable()) return 0;
  let ready = 0;
  for (const scope of scopes) {
    try {
      const existing = await storage.getDocumentEmbedding(scope.devisId);
      if (existing && existing.contentHash === scope.contentHash) {
        ready++;
        continue;
      }
      const vector = await generateEmbedding(scope.embeddingText);
      if (!vector) continue;
      await storage.upsertDocumentEmbedding({
        projectId,
        devisId: scope.devisId,
        contentHash: scope.contentHash,
        model: EMBEDDING_MODEL,
        embedding: vector,
      });
      ready++;
    } catch (err) {
      console.warn(`[reconciliation] embed failed for devis ${scope.devisId}:`, (err as Error).message);
    }
  }
  return ready;
}
