import { storage } from "../storage";
import { db } from "../db";
import { devis as devisTable, benchmarkDocuments, benchmarkItems, benchmarkItemTags } from "@shared/schema";
import { eq } from "drizzle-orm";
import { uploadDocument } from "../storage/object-storage";
import { parseDocument, type ParsedDocument } from "../gmail/document-parser";
import { validateExtraction } from "./extraction-validator";
import { roundCurrency } from "../../shared/financial-utils";
import { normalizeUnit } from "./benchmark-tags";
import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { env } from "../env";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

export interface BenchmarkUploadInput {
  contractorId?: number | null;
  externalContractorName?: string | null;
  externalSiret?: string | null;
  documentDate?: string | null;
  notes?: string | null;
}

interface TagAssignment {
  itemIndex: number;
  tags: string[];
}

async function assignTagsToItems(
  items: Array<{ description: string; rawUnit?: string | null }>,
  tagLabels: string[],
): Promise<TagAssignment[]> {
  if (items.length === 0 || tagLabels.length === 0) return [];

  const setting = await storage.getAiModelSetting("document_parsing").catch(() => undefined);
  const provider = setting?.provider ?? "gemini";
  const modelId = setting?.modelId ?? "gemini-2.5-flash";

  const SYSTEM = `Tu es un expert BTP français. Tu reçois une liste de lignes de devis et un vocabulaire fermé de tags. Pour chaque ligne, tu choisis 1 à 3 tags du vocabulaire qui la décrivent le mieux. Si aucun tag ne convient, retourne un tableau vide.`;
  const userPayload = {
    tags: tagLabels,
    items: items.map((it, i) => ({ index: i, description: it.description, unit: it.rawUnit ?? null })),
  };
  const USER = `Vocabulaire et lignes:\n${JSON.stringify(userPayload)}\n\nRetourne UNIQUEMENT un JSON: {"assignments":[{"itemIndex":0,"tags":["..."]}]} où chaque "tags" est un sous-ensemble (1-3 max) du vocabulaire fourni.`;

  try {
    if (provider === "gemini") {
      const key = env.GEMINI_API_KEY;
      if (!key) return [];
      const genAI = new GoogleGenerativeAI(key);
      const schema: ResponseSchema = {
        type: SchemaType.OBJECT,
        properties: {
          assignments: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                itemIndex: { type: SchemaType.NUMBER },
                tags: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
              },
              required: ["itemIndex", "tags"],
            },
          },
        },
        required: ["assignments"],
      };
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
      const parsed = JSON.parse(result.response.text());
      return parsed.assignments ?? [];
    } else {
      const openai = new OpenAI({
        apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });
      const resp = await openai.chat.completions.create({
        model: modelId || "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: USER },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
      });
      const content = resp.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(content);
      return parsed.assignments ?? [];
    }
  } catch (err) {
    console.warn("[benchmark-ingest] tag assignment failed:", (err as Error).message);
    return [];
  }
}

export async function ingestParsedAsBenchmark(opts: {
  parsed: ParsedDocument;
  validationConfidence: number;
  storageKey: string | null;
  fileName: string | null;
  contractorId: number | null;
  externalContractorName: string | null;
  externalSiret: string | null;
  documentDate: string | null;
  notes: string | null;
  source: "standalone" | "project_devis";
  sourceDevisId: number | null;
}) {
  const {
    parsed, validationConfidence, storageKey, fileName,
    contractorId, externalContractorName, externalSiret,
    documentDate, notes, source, sourceDevisId,
  } = opts;

  const validation = validateExtraction(parsed);
  const docConfidence = Math.min(validationConfidence, validation.confidenceScore);
  const docNeedsReview = docConfidence < 70 || (validation.warnings || []).some(w => w.severity === "error");

  const totalHt = parsed.amountHt != null ? String(roundCurrency(parsed.amountHt)) : null;

  let benchmarkDoc;
  if (sourceDevisId != null) {
    const existing = await storage.getBenchmarkDocumentBySourceDevis(sourceDevisId);
    if (existing) {
      await storage.deleteBenchmarkItemsByDocument(existing.id);
      benchmarkDoc = await storage.updateBenchmarkDocument(existing.id, {
        contractorId: contractorId ?? undefined,
        externalContractorName,
        externalSiret,
        documentDate,
        notes,
        pdfStorageKey: storageKey,
        pdfFileName: fileName,
        totalHt,
        aiExtractedData: parsed,
        aiConfidence: docConfidence,
        validationWarnings: validation.warnings,
        needsReview: docNeedsReview,
      });
    }
  }

  if (!benchmarkDoc) {
    benchmarkDoc = await storage.createBenchmarkDocument({
      source,
      sourceDevisId,
      contractorId,
      externalContractorName,
      externalSiret,
      documentDate,
      notes,
      pdfStorageKey: storageKey,
      pdfFileName: fileName,
      totalHt,
      aiExtractedData: parsed,
      aiConfidence: docConfidence,
      validationWarnings: validation.warnings,
      needsReview: docNeedsReview,
    });
  }

  const lineItems = parsed.lineItems ?? [];
  if (lineItems.length === 0) {
    return { document: benchmarkDoc, itemsCreated: 0 };
  }

  const allTags = await storage.getBenchmarkTags();
  const tagLabels = allTags.map(t => t.label);
  const tagByLabel = new Map(allTags.map(t => [t.label, t.id]));

  const itemsForTagging = lineItems.map(li => ({
    description: li.description ?? "",
    rawUnit: null as string | null,
  }));

  const assignments = await assignTagsToItems(itemsForTagging, tagLabels);
  const tagsByIndex = new Map<number, number[]>();
  for (const a of assignments) {
    const ids = (a.tags || [])
      .slice(0, 3)
      .map(label => tagByLabel.get(label))
      .filter((x): x is number => typeof x === "number");
    if (ids.length > 0) tagsByIndex.set(a.itemIndex, ids);
  }

  let itemsCreated = 0;
  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    const rawUnit: string | null = li.unit ?? null;
    const normUnit = normalizeUnit(rawUnit);

    const rawQty = li.quantity != null ? Number(li.quantity) : null;
    const rawUnitPrice = li.unitPrice != null ? roundCurrency(li.unitPrice) : null;
    const rawTotal = li.total != null ? roundCurrency(li.total) : null;

    let normUnitPrice: number | null = null;
    if (normUnit && rawUnitPrice != null) {
      normUnitPrice = rawUnitPrice;
    } else if (normUnit && rawQty != null && rawQty > 0 && rawTotal != null) {
      normUnitPrice = roundCurrency(rawTotal / rawQty);
    }

    const itemConfidence = docConfidence;
    const itemTags = tagsByIndex.get(i) ?? [];
    const itemNeedsReview =
      docNeedsReview ||
      itemConfidence < 70 ||
      itemTags.length === 0 ||
      rawUnitPrice == null;

    try {
      const created = await storage.createBenchmarkItem({
        documentId: benchmarkDoc.id,
        lineNumber: i + 1,
        description: li.description || `Line ${i + 1}`,
        rawQuantity: rawQty != null ? String(rawQty) : null,
        rawUnit,
        rawUnitPriceHt: rawUnitPrice != null ? String(rawUnitPrice) : null,
        rawTotalHt: rawTotal != null ? String(rawTotal) : null,
        normalizedUnit: normUnit,
        normalizedUnitPriceHt: normUnitPrice != null ? String(normUnitPrice) : null,
        aiConfidence: itemConfidence,
        needsReview: itemNeedsReview,
      });
      if (itemTags.length > 0) {
        await storage.setBenchmarkItemTags(created.id, itemTags);
      }
      itemsCreated++;
    } catch (e) {
      console.warn(`[benchmark-ingest] failed to create item ${i + 1}:`, (e as Error).message);
    }
  }

  return { document: benchmarkDoc, itemsCreated };
}

export async function processStandaloneBenchmarkUpload(file: UploadedFile, input: BenchmarkUploadInput) {
  if (!input.contractorId && !input.externalContractorName?.trim()) {
    return {
      success: false,
      status: 400,
      data: { message: "Either contractorId or externalContractorName must be provided." },
    };
  }

  const storageKey = await uploadDocument(0, file.originalname, file.buffer, file.mimetype);
  const parsed = await parseDocument(file.buffer, file.originalname);

  if (parsed.documentType === "unknown" && !parsed.amountHt && !parsed.lineItems?.length) {
    return {
      success: false,
      status: 422,
      data: {
        message: "Could not extract meaningful data from this PDF.",
        extraction: parsed,
        storageKey,
        fileName: file.originalname,
      },
    };
  }

  const validation = validateExtraction(parsed);

  const result = await ingestParsedAsBenchmark({
    parsed,
    validationConfidence: validation.confidenceScore,
    storageKey,
    fileName: file.originalname,
    contractorId: input.contractorId ?? null,
    externalContractorName: input.externalContractorName?.trim() || null,
    externalSiret: input.externalSiret?.trim() || null,
    documentDate: input.documentDate || parsed.date || null,
    notes: input.notes?.trim() || null,
    source: "standalone",
    sourceDevisId: null,
  });

  return {
    success: true,
    status: 201,
    data: {
      document: result.document,
      itemsCreated: result.itemsCreated,
      extraction: { documentType: parsed.documentType, contractorName: parsed.contractorName },
      validation: {
        warnings: validation.warnings,
        confidenceScore: validation.confidenceScore,
      },
    },
  };
}

/**
 * Atomically: update the devis row with the given partial updates AND
 * upsert/replace the corresponding benchmark_document + benchmark_items by
 * sourceDevisId. Tag assignment is intentionally performed AFTER the
 * transaction commits (it makes a network call to the AI provider and must
 * not hold a DB transaction open).
 */
export async function confirmDevisAndMirror(
  devisId: number,
  devisUpdates: Record<string, unknown>,
): Promise<{
  devis: typeof devisTable.$inferSelect | undefined;
  benchmarkDocId: number | null;
  inserted: Array<{ id: number; index: number; description: string; rawUnit: string | null }>;
  parsed: ParsedDocument | null;
}> {
  return await db.transaction(async (tx) => {
    const [updatedDevis] = await tx
      .update(devisTable)
      .set(devisUpdates)
      .where(eq(devisTable.id, devisId))
      .returning();

    if (!updatedDevis) {
      return { devis: undefined, benchmarkDocId: null, inserted: [], parsed: null };
    }

    const aiData = (updatedDevis.aiExtractedData as ParsedDocument | null) ?? null;
    if (!aiData) {
      return { devis: updatedDevis, benchmarkDocId: null, inserted: [], parsed: null };
    }

    const validation = validateExtraction(aiData);
    const docConfidence = Math.min(updatedDevis.aiConfidence ?? 50, validation.confidenceScore);
    const docNeedsReview = docConfidence < 70 || (validation.warnings || []).some(w => w.severity === "error");
    const totalHt = aiData.amountHt != null ? String(roundCurrency(aiData.amountHt)) : null;

    const docPayload = {
      source: "project_devis",
      sourceDevisId: updatedDevis.id,
      contractorId: updatedDevis.contractorId,
      externalContractorName: null,
      externalSiret: null,
      documentDate: updatedDevis.dateSent ?? aiData.date ?? null,
      notes: `Auto-mirrored from project devis ${updatedDevis.devisCode}`,
      pdfStorageKey: updatedDevis.pdfStorageKey,
      pdfFileName: updatedDevis.pdfFileName,
      totalHt,
      aiExtractedData: aiData,
      aiConfidence: docConfidence,
      validationWarnings: validation.warnings,
      needsReview: docNeedsReview,
    };

    const [existing] = await tx
      .select()
      .from(benchmarkDocuments)
      .where(eq(benchmarkDocuments.sourceDevisId, devisId))
      .limit(1);

    let benchmarkDocId: number;
    if (existing) {
      benchmarkDocId = existing.id;
      await tx.update(benchmarkDocuments).set(docPayload).where(eq(benchmarkDocuments.id, benchmarkDocId));
      await tx.delete(benchmarkItems).where(eq(benchmarkItems.documentId, benchmarkDocId));
    } else {
      const [created] = await tx.insert(benchmarkDocuments).values(docPayload).returning({ id: benchmarkDocuments.id });
      benchmarkDocId = created.id;
    }

    const lineItems = aiData.lineItems ?? [];
    const inserted: Array<{ id: number; index: number; description: string; rawUnit: string | null }> = [];

    for (let i = 0; i < lineItems.length; i++) {
      const li = lineItems[i];
      const rawUnit: string | null = li.unit ?? null;
      const normUnit = normalizeUnit(rawUnit);
      const rawQty = li.quantity != null ? Number(li.quantity) : null;
      const rawUnitPrice = li.unitPrice != null ? roundCurrency(li.unitPrice) : null;
      const rawTotal = li.total != null ? roundCurrency(li.total) : null;

      let normUnitPrice: number | null = null;
      if (normUnit && rawUnitPrice != null) normUnitPrice = rawUnitPrice;
      else if (normUnit && rawQty != null && rawQty > 0 && rawTotal != null) normUnitPrice = roundCurrency(rawTotal / rawQty);

      const description = li.description || `Line ${i + 1}`;
      const [row] = await tx.insert(benchmarkItems).values({
        documentId: benchmarkDocId,
        lineNumber: i + 1,
        description,
        rawQuantity: rawQty != null ? String(rawQty) : null,
        rawUnit,
        rawUnitPriceHt: rawUnitPrice != null ? String(rawUnitPrice) : null,
        rawTotalHt: rawTotal != null ? String(rawTotal) : null,
        normalizedUnit: normUnit,
        normalizedUnitPriceHt: normUnitPrice != null ? String(normUnitPrice) : null,
        aiConfidence: docConfidence,
        needsReview: docNeedsReview || docConfidence < 70 || rawUnitPrice == null,
      }).returning({ id: benchmarkItems.id });
      inserted.push({ id: row.id, index: i, description, rawUnit });
    }

    return { devis: updatedDevis, benchmarkDocId, inserted, parsed: aiData };
  });
}

/**
 * Post-transaction tag assignment for items inserted by confirmDevisAndMirror.
 * Safe to call without a transaction; failures are logged but not raised.
 */
export async function assignTagsForInsertedItems(
  inserted: Array<{ id: number; index: number; description: string; rawUnit: string | null }>,
): Promise<void> {
  if (inserted.length === 0) return;
  try {
    const allTags = await storage.getBenchmarkTags();
    if (allTags.length === 0) return;
    const tagLabels = allTags.map(t => t.label);
    const tagByLabel = new Map(allTags.map(t => [t.label, t.id]));
    const items = inserted.map(it => ({ description: it.description, rawUnit: it.rawUnit }));
    const assignments = await assignTagsToItems(items, tagLabels);
    for (const a of assignments) {
      const target = inserted.find(it => it.index === a.itemIndex);
      if (!target) continue;
      const ids = (a.tags || [])
        .slice(0, 3)
        .map(label => tagByLabel.get(label))
        .filter((x): x is number => typeof x === "number");
      if (ids.length === 0) continue;
      await db.delete(benchmarkItemTags).where(eq(benchmarkItemTags.itemId, target.id));
      await db.insert(benchmarkItemTags).values(ids.map(tagId => ({ itemId: target.id, tagId })));
    }
  } catch (err) {
    console.warn("[benchmark-mirror] post-tx tag assignment failed:", (err as Error).message);
  }
}

export async function mirrorDevisToBenchmark(devisId: number) {
  const devis = await storage.getDevis(devisId);
  if (!devis) return { skipped: true, reason: "devis not found" };
  const aiData = (devis.aiExtractedData as ParsedDocument | null) ?? null;
  if (!aiData) return { skipped: true, reason: "no extraction data" };

  try {
    const result = await ingestParsedAsBenchmark({
      parsed: aiData,
      validationConfidence: devis.aiConfidence ?? 50,
      storageKey: devis.pdfStorageKey,
      fileName: devis.pdfFileName,
      contractorId: devis.contractorId,
      externalContractorName: null,
      externalSiret: null,
      documentDate: devis.dateSent ?? aiData.date ?? null,
      notes: `Auto-mirrored from project devis ${devis.devisCode}`,
      source: "project_devis",
      sourceDevisId: devis.id,
    });
    return { skipped: false, documentId: result.document.id, itemsCreated: result.itemsCreated };
  } catch (err) {
    console.error("[benchmark-mirror] failed:", (err as Error).message);
    return { skipped: true, reason: (err as Error).message };
  }
}

export async function seedBenchmarkTags(tags: Array<{ label: string; category: string }>) {
  for (const tag of tags) {
    try {
      await storage.upsertBenchmarkTag(tag);
    } catch (e) {
      console.warn(`[benchmark-seed] failed to seed tag ${tag.label}:`, (e as Error).message);
    }
  }
}
