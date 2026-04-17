import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { storage } from "../storage";
import { getDocumentBuffer, uploadDocument } from "../storage/object-storage";
import type { Project, Contractor } from "@shared/schema";
import { validateExtraction } from "../services/extraction-validator";
import { execFile } from "child_process";
import { writeFile, readFile, readdir, unlink, mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
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
    unitPrice?: number;
    total?: number;
  }>;
  rawText?: string;
}

interface MatchResult {
  projectId: number | null;
  contractorId: number | null;
  confidence: number;
  matchedFields: Record<string, string>;
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
- For line items, extract description, quantity, unitPrice, and total for each visible line.
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
- lineItems: array of line items, each with {description, quantity, unitPrice, total}

Return ONLY valid JSON, no markdown, no code blocks.`;

const EXTRACTION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    documentType: {
      type: SchemaType.STRING,
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
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-pro-latest": "gemini-2.5-pro",
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

  const result = await model.generateContent([
    USER_PROMPT,
    ...imageParts,
  ]);

  const text = result.response.text();
  return JSON.parse(text);
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

export async function parseDocument(pdfBuffer: Buffer, fileName: string): Promise<ParsedDocument> {
  try {
    console.log(`[DocumentParser] Converting PDF "${fileName}" to images...`);
    const images = await pdfToImages(pdfBuffer);
    if (images.length === 0) {
      return { documentType: "unknown", rawText: "PDF conversion produced no images" };
    }
    console.log(`[DocumentParser] Converted ${images.length} page(s) to PNG`);

    const { provider, modelId } = await getActiveModel();
    console.log(`[DocumentParser] Using ${provider}/${modelId} for extraction`);

    let parsed: ParsedDocument;
    if (provider === "gemini") {
      parsed = await parseWithGemini(images, modelId);
    } else {
      parsed = await parseWithOpenAI(images, modelId);
    }

    console.log(`[DocumentParser] Extracted: type=${parsed.documentType}, contractor=${parsed.contractorName}, HT=${parsed.amountHt}, TTC=${parsed.amountTtc}, autoLiq=${parsed.autoLiquidation}, lines=${parsed.lineItems?.length ?? 0}`);
    return parsed;
  } catch (err: any) {
    console.error("[DocumentParser] Parse error:", err.message);
    return { documentType: "unknown", rawText: `Parse failed: ${err.message}` };
  }
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

  for (const contractor of contractors) {
    if (parsed.contractorName && contractor.name) {
      const similarity = fuzzyMatch(parsed.contractorName, contractor.name);
      if (similarity > 0.6) {
        bestContractorId = contractor.id;
        matchedFields.contractorName = `${parsed.contractorName} → ${contractor.name} (${Math.round(similarity * 100)}%)`;
        bestScore += similarity * 40;
      }
    }
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

    const projects = await storage.getProjects();
    const contractors = await storage.getContractors();
    const match = await matchToProject(parsed, projects, contractors);

    const validation = validateExtraction(parsed);

    const status = (validation.isValid && match.confidence >= 80) ? "completed" : "needs_review";

    await storage.updateEmailDocument(emailDocumentId, {
      documentType: parsed.documentType || "unknown",
      extractionStatus: status,
      extractedData: {
        ...parsed,
        validation: {
          isValid: validation.isValid,
          warnings: validation.warnings,
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
