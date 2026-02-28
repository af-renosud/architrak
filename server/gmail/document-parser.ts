import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { storage } from "../storage";
import { getDocumentBuffer, uploadDocument } from "../storage/object-storage";
import type { Project, Contractor } from "@shared/schema";
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
  date?: string;
  amountHt?: number;
  amountTtc?: number;
  tvaAmount?: number;
  tvaRate?: number;
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

const SYSTEM_PROMPT = `You are a document analyzer specializing in French architecture/construction financial documents.
Analyze the document images and extract structured data. Return valid JSON only.
Document types: quotation (devis), invoice (facture), situation (situation de travaux), avenant (amendment), other.
All amounts should be numbers (not strings). Dates in YYYY-MM-DD format.
For line items, extract as many as you can see — each with description, quantity, unitPrice, and total.`;

const USER_PROMPT = `Analyze this document and extract the following fields as JSON:
- documentType: quotation|invoice|situation|avenant|other|unknown
- contractorName: the company/contractor name (the one providing the service/goods)
- clientName: the client/maître d'ouvrage name
- projectAddress: site/project address if visible
- reference: document reference number (e.g. devis number, invoice number)
- date: document date (YYYY-MM-DD)
- amountHt: total amount excluding tax (number)
- amountTtc: total amount including tax (number)
- tvaAmount: TVA amount (number)
- tvaRate: TVA rate percentage (number, e.g. 20 for 20%)
- description: brief description of the work/service
- lineItems: array of {description, quantity, unitPrice, total}

Return ONLY valid JSON, no markdown, no code blocks.`;

async function pdfToImages(pdfBuffer: Buffer, maxPages: number = 5): Promise<Buffer[]> {
  const tempDir = await mkdtemp(join(tmpdir(), "architrak-pdf-"));
  const pdfPath = join(tempDir, "input.pdf");
  const outputPrefix = join(tempDir, "page");

  try {
    await writeFile(pdfPath, pdfBuffer);

    await new Promise<void>((resolve, reject) => {
      execFile("pdftoppm", [
        "-png", "-r", "200",
        "-l", String(maxPages),
        pdfPath, outputPrefix,
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

async function getActiveModel(): Promise<{ provider: string; modelId: string }> {
  try {
    const setting = await storage.getAiModelSetting("document_parsing");
    if (setting) return { provider: setting.provider, modelId: setting.modelId };
  } catch {}
  return { provider: "gemini", modelId: "gemini-2.0-flash" };
}

async function parseWithGemini(images: Buffer[], modelId: string): Promise<ParsedDocument> {
  const genAI = getGeminiClient();
  const model = genAI.getGenerativeModel({ model: modelId });

  const imageParts = images.map(buf => ({
    inlineData: {
      mimeType: "image/png" as const,
      data: buf.toString("base64"),
    },
  }));

  const result = await model.generateContent([
    SYSTEM_PROMPT + "\n\n" + USER_PROMPT,
    ...imageParts,
  ]);

  const text = result.response.text();
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned);
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

    console.log(`[DocumentParser] Extracted: type=${parsed.documentType}, contractor=${parsed.contractorName}, HT=${parsed.amountHt}, lines=${parsed.lineItems?.length ?? 0}`);
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

    const status = match.confidence >= 80 ? "completed" : "needs_review";

    await storage.updateEmailDocument(emailDocumentId, {
      documentType: parsed.documentType || "unknown",
      extractionStatus: status,
      extractedData: parsed,
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

    console.log(`[DocumentParser] Processed document ${emailDocumentId}: type=${parsed.documentType}, confidence=${match.confidence}%`);
  } catch (err: any) {
    console.error(`[DocumentParser] Failed to process document ${emailDocumentId}:`, err);
    await storage.updateEmailDocument(emailDocumentId, {
      extractionStatus: "failed",
      notes: err.message,
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
