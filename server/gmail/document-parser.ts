import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { storage } from "../storage";
import { getDocumentBuffer, uploadDocument } from "../storage/object-storage";
import type { Project, Contractor } from "@shared/schema";
import { validateExtraction, type ValidationWarning } from "../services/extraction-validator";
import { checkLotReferencesAgainstCatalog } from "../services/lot-reference-validator";
import { retry } from "../lib/retry";
import { execFile } from "child_process";
import { writeFile, readFile, readdir, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { env } from "../env";

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  // If the error message embeds an explicit HTTP status, trust it: transient
  // statuses retry, all other statuses (esp. 4xx like 400/401/403/404) fail
  // fast even if the message happens to contain a transient-sounding phrase.
  const bracketed = msg.match(/\[(\d{3})\b/);
  if (bracketed) {
    return TRANSIENT_HTTP_STATUSES.has(Number(bracketed[1]));
  }
  // No HTTP status in the message — fall back to network/transient keywords.
  return /service unavailable|currently experiencing high demand|rate limit|too many requests|temporarily unavailable|deadline exceeded|fetch failed|network error|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg);
}

function getOpenAIClient() {
  return new OpenAI({
    apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

function getGeminiClient() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  return new GoogleGenerativeAI(key);
}

export interface ParsedDocument {
  documentType: "quotation" | "invoice" | "situation" | "avenant" | "other" | "unknown";
  contractorName?: string;
  clientName?: string;
  projectAddress?: string;
  reference?: string;
  invoiceNumber?: string;
  devisNumber?: string;
  siret?: string;
  tvaIntracom?: string;
  date?: string;
  amountHt?: number;
  amountTtc?: number;
  tvaAmount?: number;
  tvaRate?: number;
  autoLiquidation?: boolean;
  retenueDeGarantie?: number;
  netAPayer?: number;
  paymentTerms?: string;
  lotReferences?: string[];
  description?: string;
  lineItems?: Array<{
    description: string;
    quantity?: number;
    unit?: string;
    unitPrice?: number;
    total?: number;
    /** 1-indexed PDF page number this line was extracted from. Best-effort
     *  AI signal — coerced/validated downstream (Task #111). */
    pageHint?: number;
    /** Bounding box of the line on its PDF page, normalized to [0,1] of the
     *  page width / height (origin = top-left). Best-effort AI signal —
     *  coerced/validated downstream (Task #113). Powers the per-line
     *  highlight rectangle in the contractor portal pdf.js viewer. */
    bbox?: { x: number; y: number; w: number; h: number };
  }>;
  rawText?: string;
}

interface MatchResult {
  projectId: number | null;
  contractorId: number | null;
  confidence: number;
  matchedFields: Record<string, string>;
  warnings: ValidationWarning[];
}

export function normalizeSiret(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.replace(/\D/g, "");
}

export function extractSirenFromTva(raw: string | null | undefined): string {
  // French intracom VAT: FR<2-char key><9-digit SIREN>. Tolerate spaces and
  // missing key digits — fall back to the last 9 digits.
  if (!raw) return "";
  const digits = raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  const m = digits.match(/^FR[0-9A-Z]{2}(\d{9})$/);
  if (m) return m[1];
  const onlyDigits = raw.replace(/\D/g, "");
  if (onlyDigits.length === 11) return onlyDigits.slice(2);
  if (onlyDigits.length === 9) return onlyDigits;
  return "";
}

function sirenOf(contractor: Contractor): string {
  return normalizeSiret(contractor.siret).slice(0, 9);
}

const SYSTEM_PROMPT = `You are an Expert-Comptable specialise BTP (French Construction Accountant) with deep expertise in analyzing financial documents from the French architecture and construction industry.

Your role is to extract structured financial data from scanned construction documents (devis, factures, situations de travaux, avenants) with accounting-grade precision.

Domain Knowledge:
- Auto-liquidation de TVA (Article 283-2 nonies du CGI): When a subcontractor invoices a main contractor, TVA is reverse-charged. The document will state "TVA due par le preneur" or "Auto-liquidation de TVA". In this case, set tvaRate to 0 and autoLiquidation to true.
- Retenue de Garantie: Per Loi n°71-584, a 5% holdback is standard on construction contracts. Look for "Retenue de garantie" line items.
- Net a payer vs Montant TTC: The net payable amount may differ from TTC when retenue de garantie or other deductions apply. Net a payer = TTC - retenue de garantie - other deductions.
- SIRET: 14-digit identifier for French companies, often on letterhead.
- RCS: Registre du Commerce et des Societes registration.
- Lot references: Construction projects are divided into lots (e.g., "Lot 1 - Gros Oeuvre", "Lot 7 - Electricite"). Extract all lot codes visible.
- Distinguish Acompte (deposit invoice) from Situation (progress claim with cumulative percentages).

Extraction Rules:
- All monetary amounts must be numbers with exactly 2 decimal precision (e.g., 15000.00 not 15000).
- TVA rate must be a percentage number (e.g., 20 for 20%, not 0.20).
- If auto-liquidation applies, set tvaRate to 0 and autoLiquidation to true.
- Dates in YYYY-MM-DD format.
- For line items, extract description, quantity, unit (e.g. m2, m3, ml, u, forfait), unitPrice, and total for each visible line.
- For each line item, also populate "pageHint": the 1-indexed page number of the PDF on which that line appears. Pages are provided to you as separate images in order — the first image is page 1, the second is page 2, and so on. If you cannot determine the page with confidence, omit pageHint for that line.
- For each line item, also populate "bbox": the rectangle on the page image that visually contains that line's row in the table. Coordinates MUST be normalized to the [0, 1] range of the page image (x and w as a fraction of the image width; y and h as a fraction of the image height; origin at the top-left of the image). Make the box tight to the line row, including the description and the amount, but not neighbouring rows. If you cannot determine the box with confidence, omit bbox for that line — do not guess.
- If a field is not visible on the document, omit it (do not guess).`;

const USER_PROMPT = `Analyze this French construction document and extract the following fields:

- documentType: "quotation" (devis), "invoice" (facture), "situation" (situation de travaux), "avenant" (amendment), "other", or "unknown"
- contractorName: the company/contractor name (the entity providing the service/goods, often at the top of the document)
- clientName: the client/maitre d'ouvrage name (the entity receiving the service)
- projectAddress: site/project address if visible
- reference: primary document reference number
- invoiceNumber: specific invoice number if this is a facture (e.g., "FA-2024-001")
- devisNumber: specific devis number if this is a devis (e.g., "DEV-2024-042")
- siret: contractor SIRET number (14-digit identifier) if visible on the document
- tvaIntracom: contractor's intra-community VAT number if visible (e.g., "FR75820466761") — copy the full string including the FR prefix
- date: document date in YYYY-MM-DD format
- amountHt: total amount excluding tax (Montant HT) as a number with 2 decimal places
- amountTtc: total amount including tax (Montant TTC) as a number with 2 decimal places
- tvaAmount: TVA amount as a number with 2 decimal places
- tvaRate: TVA rate as a percentage number (e.g., 20 for 20%). If auto-liquidation, set to 0.
- autoLiquidation: true if TVA auto-liquidation applies (Article 283-2 nonies CGI), false otherwise
- retenueDeGarantie: retenue de garantie holdback amount if present, as a number with 2 decimal places
- netAPayer: net payable amount (after deductions) if visible, as a number with 2 decimal places
- paymentTerms: payment conditions text if visible (e.g., "30 jours fin de mois")
- lotReferences: array of lot codes/references visible on the document (e.g., ["Lot 1", "Lot 7 - Electricite"])
- description: brief description of the work/service
- lineItems: array of line items, each with {description, quantity, unit, unitPrice, total, pageHint, bbox}

Return ONLY valid JSON, no markdown, no code blocks.`;

const EXTRACTION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    documentType: {
      type: SchemaType.STRING,
      format: "enum",
      description: "Type of document: quotation, invoice, situation, avenant, other, or unknown",
      enum: ["quotation", "invoice", "situation", "avenant", "other", "unknown"],
    },
    contractorName: {
      type: SchemaType.STRING,
      description: "Company/contractor name providing the service",
      nullable: true,
    },
    clientName: {
      type: SchemaType.STRING,
      description: "Client/maitre d'ouvrage name",
      nullable: true,
    },
    projectAddress: {
      type: SchemaType.STRING,
      description: "Site/project address",
      nullable: true,
    },
    reference: {
      type: SchemaType.STRING,
      description: "Primary document reference number",
      nullable: true,
    },
    invoiceNumber: {
      type: SchemaType.STRING,
      description: "Specific invoice number for factures",
      nullable: true,
    },
    devisNumber: {
      type: SchemaType.STRING,
      description: "Specific devis number for quotations",
      nullable: true,
    },
    siret: {
      type: SchemaType.STRING,
      description: "Contractor SIRET number (14-digit identifier)",
      nullable: true,
    },
    tvaIntracom: {
      type: SchemaType.STRING,
      description: "Contractor intra-community VAT number (e.g., FR75820466761)",
      nullable: true,
    },
    date: {
      type: SchemaType.STRING,
      description: "Document date in YYYY-MM-DD format",
      nullable: true,
    },
    amountHt: {
      type: SchemaType.NUMBER,
      description: "Total amount excluding tax (HT) with 2 decimal precision",
      nullable: true,
    },
    amountTtc: {
      type: SchemaType.NUMBER,
      description: "Total amount including tax (TTC) with 2 decimal precision",
      nullable: true,
    },
    tvaAmount: {
      type: SchemaType.NUMBER,
      description: "TVA amount with 2 decimal precision",
      nullable: true,
    },
    tvaRate: {
      type: SchemaType.NUMBER,
      description: "TVA rate as percentage (e.g., 20 for 20%). Set to 0 if auto-liquidation.",
      nullable: true,
    },
    autoLiquidation: {
      type: SchemaType.BOOLEAN,
      description: "True if TVA auto-liquidation applies (Article 283-2 nonies CGI)",
      nullable: true,
    },
    retenueDeGarantie: {
      type: SchemaType.NUMBER,
      description: "Retenue de garantie holdback amount with 2 decimal precision",
      nullable: true,
    },
    netAPayer: {
      type: SchemaType.NUMBER,
      description: "Net payable amount after deductions with 2 decimal precision",
      nullable: true,
    },
    paymentTerms: {
      type: SchemaType.STRING,
      description: "Payment conditions text",
      nullable: true,
    },
    lotReferences: {
      type: SchemaType.ARRAY,
      description: "Array of lot codes/references visible on the document",
      items: { type: SchemaType.STRING },
      nullable: true,
    },
    description: {
      type: SchemaType.STRING,
      description: "Brief description of the work/service",
      nullable: true,
    },
    lineItems: {
      type: SchemaType.ARRAY,
      description: "Array of line items extracted from the document",
      nullable: true,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          description: {
            type: SchemaType.STRING,
            description: "Line item description",
          },
          quantity: {
            type: SchemaType.NUMBER,
            description: "Quantity",
            nullable: true,
          },
          unit: {
            type: SchemaType.STRING,
            description: "Unit of measure as written (e.g. m2, m3, ml, u, forfait, h)",
            nullable: true,
          },
          unitPrice: {
            type: SchemaType.NUMBER,
            description: "Unit price",
            nullable: true,
          },
          total: {
            type: SchemaType.NUMBER,
            description: "Line total",
            nullable: true,
          },
          pageHint: {
            type: SchemaType.NUMBER,
            description: "1-indexed PDF page number this line appears on (1 = first page). Omit if unknown.",
            nullable: true,
          },
          bbox: {
            type: SchemaType.OBJECT,
            description: "Bounding box of this line on its page image. All four values normalized to [0,1] of the image dimensions, origin top-left. Omit if unknown.",
            nullable: true,
            properties: {
              x: { type: SchemaType.NUMBER, description: "Left edge as a fraction of the page width (0..1)" },
              y: { type: SchemaType.NUMBER, description: "Top edge as a fraction of the page height (0..1)" },
              w: { type: SchemaType.NUMBER, description: "Width as a fraction of the page width (0..1)" },
              h: { type: SchemaType.NUMBER, description: "Height as a fraction of the page height (0..1)" },
            },
            required: ["x", "y", "w", "h"],
          },
        },
        required: ["description"],
      },
    },
  },
  required: ["documentType"],
};

export class PdfPasswordProtectedError extends Error {
  constructor() {
    super(
      "Ce PDF est protégé par un mot de passe utilisateur et ne peut pas être traité automatiquement. " +
      "Veuillez ouvrir le PDF dans votre logiciel de comptabilité, l'imprimer en PDF (sans protection), " +
      "puis re-télécharger le fichier résultant."
    );
    this.name = "PdfPasswordProtectedError";
  }
}

async function decryptPdf(inputPath: string, outputPath: string): Promise<{ decrypted: boolean; wasProtected: boolean }> {
  return new Promise((resolve, reject) => {
    execFile("qpdf", ["--decrypt", inputPath, outputPath], { timeout: 15000 }, (err, _stdout, stderr) => {
      if (!err) {
        resolve({ decrypted: true, wasProtected: false });
        return;
      }
      const msg = (stderr || "").toLowerCase();
      if (msg.includes("invalid password") || msg.includes("password required")) {
        reject(new PdfPasswordProtectedError());
      } else {
        resolve({ decrypted: false, wasProtected: false });
      }
    });
  });
}

async function pdfToImages(pdfBuffer: Buffer, maxPages: number = 5): Promise<Buffer[]> {
  const tempDir = await mkdtemp(join(tmpdir(), "architrak-pdf-"));
  const pdfPath = join(tempDir, "input.pdf");
  const decryptedPath = join(tempDir, "decrypted.pdf");
  const outputPrefix = join(tempDir, "page");

  try {
    await writeFile(pdfPath, pdfBuffer);

    let pdfToProcess = pdfPath;
    try {
      const { decrypted } = await decryptPdf(pdfPath, decryptedPath);
      if (decrypted) {
        pdfToProcess = decryptedPath;
        console.log("[document-parser] PDF had security restrictions — stripped with qpdf before extraction");
      }
    } catch (err) {
      if (err instanceof PdfPasswordProtectedError) {
        throw err;
      }
      console.warn("[document-parser] qpdf pre-processing failed, proceeding with original PDF:", err);
    }

    await new Promise<void>((resolve, reject) => {
      execFile("pdftoppm", [
        "-png", "-r", "200",
        "-l", String(maxPages),
        pdfToProcess, outputPrefix,
      ], { timeout: 30000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const files = await readdir(tempDir);
    const pngFiles = files.filter(f => f.endsWith(".png")).sort();

    const images: Buffer[] = [];
    for (const pngFile of pngFiles.slice(0, maxPages)) {
      images.push(await readFile(join(tempDir, pngFile)));
    }

    return images;
  } finally {
    try {
      const files = await readdir(tempDir);
      for (const f of files) await unlink(join(tempDir, f));
      const { rmdir } = await import("fs/promises");
      await rmdir(tempDir);
    } catch {}
  }
}

const RETIRED_GEMINI_MODELS: Record<string, string> = {
  "gemini-2.0-flash": "gemini-2.5-flash",
  "gemini-2.0-flash-001": "gemini-2.5-flash",
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-1.5-flash-latest": "gemini-2.5-flash",
  "gemini-1.5-pro": "gemini-2.5-flash",
  "gemini-1.5-pro-latest": "gemini-2.5-flash",
  "gemini-pro": "gemini-2.5-flash",
  "gemini-pro-vision": "gemini-2.5-flash",
};

function upgradeRetiredModel(provider: string, modelId: string): string {
  if (provider !== "gemini") return modelId;
  const replacement = RETIRED_GEMINI_MODELS[modelId];
  if (replacement) {
    console.warn(`[document-parser] Configured model "${modelId}" is retired by Google; auto-upgrading to "${replacement}". Update ai_model_settings to silence this warning.`);
    return replacement;
  }
  return modelId;
}

async function getActiveModel(): Promise<{ provider: string; modelId: string }> {
  try {
    const setting = await storage.getAiModelSetting("document_parsing");
    if (setting) {
      return {
        provider: setting.provider,
        modelId: upgradeRetiredModel(setting.provider, setting.modelId),
      };
    }
  } catch {}
  return { provider: "gemini", modelId: "gemini-2.5-flash" };
}

async function parseWithGemini(images: Buffer[], modelId: string): Promise<ParsedDocument> {
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

  const imageParts = images.map(buf => ({
    inlineData: {
      mimeType: "image/png" as const,
      data: buf.toString("base64"),
    },
  }));

  return retry(
    async () => {
      const result = await model.generateContent([
        USER_PROMPT,
        ...imageParts,
      ]);
      const text = result.response.text();
      return JSON.parse(text) as ParsedDocument;
    },
    {
      retries: 2,
      baseMs: 500,
      maxMs: 6000,
      factor: 3,
      jitter: true,
      shouldRetry: isTransientGeminiError,
      onRetry: (err, attempt) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[document-parser] Gemini transient error on attempt ${attempt}, retrying: ${msg}`);
      },
    },
  );
}

async function parseWithOpenAI(images: Buffer[], modelId: string): Promise<ParsedDocument> {
  const openai = getOpenAIClient();

  const imageContent = images.map(buf => ({
    type: "image_url" as const,
    image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
  }));

  const response = await openai.chat.completions.create({
    model: modelId || "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          ...imageContent,
        ],
      },
    ],
    max_tokens: 4000,
    temperature: 0,
  });

  const content = response.choices[0]?.message?.content || "{}";
  const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
}

function hasOpenAIKey(): boolean {
  return Boolean(env.AI_INTEGRATIONS_OPENAI_API_KEY);
}

async function getOpenAIFallbackModelId(): Promise<string> {
  // Prefer an explicit fallback task setting if the operator configured one,
  // then any OpenAI-provider document_parsing setting (covers the case where
  // OpenAI is the primary), and finally a safe vision-capable default.
  try {
    const fallback = await storage.getAiModelSetting("document_parsing_fallback");
    if (fallback?.provider === "openai" && fallback.modelId) return fallback.modelId;
    const primary = await storage.getAiModelSetting("document_parsing");
    if (primary?.provider === "openai" && primary.modelId) return primary.modelId;
  } catch {}
  return "gpt-4o";
}

export interface ParseDocumentDeps {
  pdfToImages?: (pdfBuffer: Buffer) => Promise<Buffer[]>;
  getActiveModel?: () => Promise<{ provider: string; modelId: string }>;
  parseWithGemini?: (images: Buffer[], modelId: string) => Promise<ParsedDocument>;
  parseWithOpenAI?: (images: Buffer[], modelId: string) => Promise<ParsedDocument>;
  getOpenAIFallbackModelId?: () => Promise<string>;
  hasOpenAIKey?: () => boolean;
}

export async function parseDocument(
  pdfBuffer: Buffer,
  fileName: string,
  deps: ParseDocumentDeps = {},
): Promise<ParsedDocument> {
  const _pdfToImages = deps.pdfToImages ?? pdfToImages;
  const _getActiveModel = deps.getActiveModel ?? getActiveModel;
  const _parseWithGemini = deps.parseWithGemini ?? parseWithGemini;
  const _parseWithOpenAI = deps.parseWithOpenAI ?? parseWithOpenAI;
  const _getOpenAIFallbackModelId = deps.getOpenAIFallbackModelId ?? getOpenAIFallbackModelId;
  const _hasOpenAIKey = deps.hasOpenAIKey ?? hasOpenAIKey;

  let images: Buffer[];
  try {
    console.log(`[DocumentParser] Converting PDF "${fileName}" to images...`);
    images = await _pdfToImages(pdfBuffer);
  } catch (err: any) {
    console.error("[DocumentParser] PDF conversion error:", err.message);
    return { documentType: "unknown", rawText: `Parse failed: ${err.message}` };
  }
  if (images.length === 0) {
    return { documentType: "unknown", rawText: "PDF conversion produced no images" };
  }
  console.log(`[DocumentParser] Converted ${images.length} page(s) to PNG`);

  const { provider, modelId } = await _getActiveModel();
  console.log(`[DocumentParser] Using ${provider}/${modelId} for extraction`);

  let parsed: ParsedDocument | null = null;
  let finalErr: unknown = null;
  let finalErrTransient = false;

  if (provider === "gemini") {
    try {
      parsed = await _parseWithGemini(images, modelId);
    } catch (err: any) {
      finalErr = err;
      finalErrTransient = isTransientGeminiError(err);
      console.error(`[DocumentParser] Gemini parse error (transient=${finalErrTransient}):`, err.message);
      if (finalErrTransient && _hasOpenAIKey()) {
        const fallbackModelId = await _getOpenAIFallbackModelId();
        console.warn(`[DocumentParser] Falling back to OpenAI/${fallbackModelId} after Gemini transient failure`);
        try {
          parsed = await _parseWithOpenAI(images, fallbackModelId);
          // OpenAI fallback succeeded — clear the prior error.
          finalErr = null;
          finalErrTransient = false;
        } catch (fallbackErr: any) {
          // Replace the Gemini error with the actual final cause and
          // re-classify so a permanent OpenAI failure (e.g., bad key)
          // surfaces as permanent, not transient.
          finalErr = fallbackErr;
          finalErrTransient = isTransientGeminiError(fallbackErr);
          console.error(`[DocumentParser] OpenAI fallback also failed (transient=${finalErrTransient}):`, fallbackErr.message);
        }
      }
    }
  } else {
    try {
      parsed = await _parseWithOpenAI(images, modelId);
    } catch (err: any) {
      finalErr = err;
      finalErrTransient = isTransientGeminiError(err);
      console.error(`[DocumentParser] OpenAI parse error (transient=${finalErrTransient}):`, err.message);
    }
  }

  if (parsed) {
    console.log(`[DocumentParser] Extracted: type=${parsed.documentType}, contractor=${parsed.contractorName}, HT=${parsed.amountHt}, TTC=${parsed.amountTtc}, autoLiq=${parsed.autoLiquidation}, lines=${parsed.lineItems?.length ?? 0}`);
    return parsed;
  }

  const message = finalErr instanceof Error ? finalErr.message : String(finalErr);
  return {
    documentType: "unknown",
    rawText: `Parse failed${finalErrTransient ? " (transient)" : ""}: ${message}`,
  };
}

export function isTransientParseFailure(parsed: ParsedDocument): boolean {
  return parsed.documentType === "unknown"
    && typeof parsed.rawText === "string"
    && parsed.rawText.startsWith("Parse failed (transient):");
}

export function getParseFailureMessage(parsed: ParsedDocument): string | null {
  if (parsed.documentType !== "unknown" || typeof parsed.rawText !== "string") return null;
  const m = parsed.rawText.match(/^Parse failed(?:\s*\(transient\))?:\s*(.+)$/);
  return m ? m[1] : null;
}

export async function matchToProject(
  parsed: ParsedDocument,
  projects: Project[],
  contractors: Contractor[]
): Promise<MatchResult> {
  let bestProjectId: number | null = null;
  let bestContractorId: number | null = null;
  let bestScore = 0;
  const matchedFields: Record<string, string> = {};
  const warnings: ValidationWarning[] = [];

  // ── Tier 1: SIRET / SIREN match (deterministic legal-entity ID) ───────────
  // SIRET (14 digits) is authoritative — short, brand-style names like
  // "AT TRAVAUX" vs "AT PISCINES" cannot collide on the legal-entity ID.
  const extractedSiret = normalizeSiret(parsed.siret);
  const extractedSirenFromTva = extractSirenFromTva(parsed.tvaIntracom);
  // Some extractors put the TVA into the siret field (or vice-versa); accept
  // either source for SIREN derivation.
  const sirenFromSiretField = extractedSiret.length === 9
    ? extractedSiret
    : extractSirenFromTva(parsed.siret);
  const effectiveSiren = extractedSirenFromTva || sirenFromSiretField || extractedSiret.slice(0, 9);

  let siretMatchedContractor: Contractor | null = null;
  let siretSignal: "siret" | "siren" | null = null;

  if (extractedSiret.length === 14) {
    const exact = contractors.filter((c) => normalizeSiret(c.siret) === extractedSiret);
    if (exact.length === 1) {
      siretMatchedContractor = exact[0];
      siretSignal = "siret";
    } else if (exact.length > 1) {
      warnings.push({
        field: "contractor_siret_collision",
        expected: exact.map((c) => c.name).join(", "),
        actual: extractedSiret,
        message: `Multiple contractors share SIRET ${extractedSiret}: ${exact.map((c) => `${c.name} (id ${c.id})`).join(", ")}. Resolve duplicates before relying on SIRET matching.`,
        severity: "warning",
      });
    }
  }

  if (!siretMatchedContractor && effectiveSiren.length === 9) {
    const sirenMatches = contractors.filter((c) => sirenOf(c) === effectiveSiren);
    if (sirenMatches.length === 1) {
      siretMatchedContractor = sirenMatches[0];
      siretSignal = "siren";
    }
  }

  // Did the document carry a usable legal-entity ID at all?
  const hasExtractedSiretOrSiren = extractedSiret.length === 14 || effectiveSiren.length === 9;

  if (siretMatchedContractor) {
    bestContractorId = siretMatchedContractor.id;
    matchedFields.contractorSiret =
      `${parsed.siret ?? parsed.tvaIntracom ?? effectiveSiren} → ${siretMatchedContractor.name} (id ${siretMatchedContractor.id}, signal=${siretSignal})`;
    bestScore += 100;
    console.log(`[matchToProject] Contractor matched by ${siretSignal}=${extractedSiret || effectiveSiren} → ${siretMatchedContractor.name} (id ${siretMatchedContractor.id})`);
  } else if (hasExtractedSiretOrSiren) {
    // SIRET / TVA was extracted from the document but no contractor in the DB
    // has it on file — surface as a warning. The fuzzy-name fallback is
    // intentionally SKIPPED here: a SIRET that doesn't match any known
    // contractor is authoritative evidence that the right contractor isn't
    // in the master list yet, and silently falling back to a name guess is
    // exactly the AT TRAVAUX / AT PISCINES regression this task fixes.
    warnings.push({
      field: "unknown_contractor",
      expected: "known contractor",
      actual: parsed.siret ?? parsed.tvaIntracom ?? effectiveSiren,
      message: `SIRET ${parsed.siret ?? parsed.tvaIntracom ?? effectiveSiren} was found on the document but no contractor with this identifier exists in ArchiTrak. Sync from ArchiDoc or create the contractor first.`,
      severity: "warning",
    });
  }

  // ── Tier 2: Name fuzzy match (only when no SIRET/SIREN was extracted) ─────
  // Threshold raised from 0.6 → 0.8 to avoid AT PISCINES / AT TRAVAUX style
  // collisions. Very short names need an even higher bar so that pure substring
  // overlaps (which trip the 0.9 `includes()` branch in fuzzyMatch) don't
  // promote a 4-letter brand collision into a "match".
  let bestNameContractor: Contractor | null = null;
  let bestNameScore = 0;
  if (parsed.contractorName) {
    for (const contractor of contractors) {
      if (!contractor.name) continue;
      const similarity = fuzzyMatch(parsed.contractorName, contractor.name);
      const minLen = Math.min(
        parsed.contractorName.replace(/\s+/g, "").length,
        contractor.name.replace(/\s+/g, "").length,
      );
      // For short names (under ~10 chars), require an exact normalised match
      // (fuzzyMatch returns exactly 1.0 for a normalised equality) rather than
      // accepting the 0.9 substring/inclusion bonus.
      const requiredScore = minLen < 10 ? 1.0 : 0.8;
      if (similarity >= requiredScore && similarity > bestNameScore) {
        bestNameContractor = contractor;
        bestNameScore = similarity;
      }
    }
  }

  if (siretMatchedContractor && bestNameContractor && bestNameContractor.id !== siretMatchedContractor.id) {
    // SIRET and name disagree → keep the SIRET pick, surface advisory.
    warnings.push({
      field: "contractor_identity_mismatch",
      expected: siretMatchedContractor.name,
      actual: parsed.contractorName,
      message: `Document name "${parsed.contractorName}" fuzzy-matches contractor "${bestNameContractor.name}" (id ${bestNameContractor.id}), but SIRET ${parsed.siret ?? parsed.tvaIntracom ?? effectiveSiren} belongs to "${siretMatchedContractor.name}" (id ${siretMatchedContractor.id}). Auto-corrected to the SIRET-matched contractor.`,
      severity: "warning",
    });
    matchedFields.contractorName = `${parsed.contractorName} → ${bestNameContractor.name} (${Math.round(bestNameScore * 100)}% — overridden by SIRET)`;
  } else if (!siretMatchedContractor && !hasExtractedSiretOrSiren && bestNameContractor) {
    // Only fall back to fuzzy name when NO legal-entity ID was extracted at
    // all — never when a SIRET/SIREN was present but unmatched.
    bestContractorId = bestNameContractor.id;
    matchedFields.contractorName = `${parsed.contractorName} → ${bestNameContractor.name} (${Math.round(bestNameScore * 100)}%)`;
    bestScore += bestNameScore * 40;
    console.log(`[matchToProject] Contractor matched by name=${bestNameContractor.name}@${Math.round(bestNameScore * 100)}%`);
  }

  for (const project of projects) {
    let projectScore = 0;

    if (parsed.clientName && project.clientName) {
      const similarity = fuzzyMatch(parsed.clientName, project.clientName);
      if (similarity > 0.5) {
        projectScore += similarity * 30;
        matchedFields.clientName = `${parsed.clientName} → ${project.clientName} (${Math.round(similarity * 100)}%)`;
      }
    }

    if (parsed.projectAddress && project.siteAddress) {
      const similarity = fuzzyMatch(parsed.projectAddress, project.siteAddress);
      if (similarity > 0.4) {
        projectScore += similarity * 20;
        matchedFields.address = `${parsed.projectAddress} → ${project.siteAddress} (${Math.round(similarity * 100)}%)`;
      }
    }

    if (parsed.clientName && project.name) {
      const similarity = fuzzyMatch(parsed.clientName, project.name);
      if (similarity > 0.4) {
        projectScore += similarity * 10;
      }
    }

    if (projectScore > 0 && projectScore >= bestScore - (bestContractorId ? 40 : 0)) {
      bestProjectId = project.id;
      bestScore = projectScore + (bestContractorId ? 40 : 0);
    }
  }

  const confidence = Math.min(bestScore, 100);

  return {
    projectId: confidence >= 30 ? bestProjectId : null,
    contractorId: bestContractorId,
    confidence,
    matchedFields,
    warnings,
  };
}

export async function processEmailDocument(emailDocumentId: number): Promise<void> {
  const emailDoc = await storage.getEmailDocument(emailDocumentId);
  if (!emailDoc) {
    throw new Error(`Email document ${emailDocumentId} not found`);
  }

  await storage.updateEmailDocument(emailDocumentId, {
    extractionStatus: "processing",
  });

  try {
    if (!emailDoc.storageKey) {
      throw new Error("No storage key for document");
    }

    const buffer = await getDocumentBuffer(emailDoc.storageKey);
    const parsed = await parseDocument(buffer, emailDoc.attachmentFileName || "document.pdf");

    const projects = await storage.getProjects({ includeArchived: true });
    const contractors = await storage.getContractors();
    const match = await matchToProject(parsed, projects, contractors);

    const validation = validateExtraction(parsed);
    const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);
    const allWarnings = [...validation.warnings, ...lotWarnings, ...match.warnings];

    const status = (validation.isValid && match.confidence >= 80) ? "completed" : "needs_review";

    await storage.updateEmailDocument(emailDocumentId, {
      documentType: parsed.documentType || "unknown",
      extractionStatus: status,
      extractedData: {
        ...parsed,
        validation: {
          isValid: validation.isValid,
          warnings: allWarnings,
          correctedValues: validation.correctedValues,
          confidenceScore: validation.confidenceScore,
        },
      },
      projectId: match.projectId,
      contractorId: match.contractorId,
      matchConfidence: String(match.confidence),
      matchedFields: match.matchedFields,
    });

    if (match.projectId && emailDoc.storageKey) {
      const newStorageKey = await uploadDocument(
        match.projectId,
        emailDoc.attachmentFileName || "document.pdf",
        buffer,
        "application/pdf"
      );

      await storage.createProjectDocument({
        projectId: match.projectId,
        fileName: emailDoc.attachmentFileName || "document.pdf",
        storageKey: newStorageKey,
        documentType: parsed.documentType || "other",
        uploadedBy: "gmail-monitor",
        description: `Auto-extracted from email: ${emailDoc.emailSubject}`,
        sourceEmailDocumentId: emailDocumentId,
      });
    }

    console.log(`[DocumentParser] Processed document ${emailDocumentId}: type=${parsed.documentType}, matchConfidence=${match.confidence}%, validationValid=${validation.isValid}, validationScore=${validation.confidenceScore}, status=${status}`);
  } catch (err: any) {
    const isPasswordProtected = err instanceof PdfPasswordProtectedError;
    if (isPasswordProtected) {
      console.warn(`[DocumentParser] Document ${emailDocumentId} is password-protected — cannot extract`);
    } else {
      console.error(`[DocumentParser] Failed to process document ${emailDocumentId}:`, err);
    }
    await storage.updateEmailDocument(emailDocumentId, {
      extractionStatus: "failed",
      notes: isPasswordProtected
        ? `PDF protégé par mot de passe: ${err.message}`
        : err.message,
    });
  }
}

function fuzzyMatch(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const na = normalize(a);
  const nb = normalize(b);

  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const wordsA = na.split(/\s+/);
  const wordsB = nb.split(/\s+/);
  let matches = 0;
  for (const wa of wordsA) {
    if (wa.length < 3) continue;
    for (const wb of wordsB) {
      if (wb.length < 3) continue;
      if (wa === wb || wa.includes(wb) || wb.includes(wa)) {
        matches++;
        break;
      }
    }
  }

  const total = Math.max(wordsA.filter(w => w.length >= 3).length, 1);
  return matches / total;
}
