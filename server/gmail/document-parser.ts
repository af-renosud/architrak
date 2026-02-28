import OpenAI from "openai";
import { storage } from "../storage";
import { getDocumentBuffer, uploadDocument } from "../storage/object-storage";
import type { Project, Contractor } from "@shared/schema";

function getOpenAIClient() {
  return new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });
}

interface ParsedDocument {
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

export async function parseDocument(pdfBuffer: Buffer, fileName: string): Promise<ParsedDocument> {
  try {
    const base64 = pdfBuffer.toString("base64");

    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are a document analyzer specializing in French architecture/construction financial documents.
Analyze the PDF and extract structured data. Return valid JSON only.
Document types: quotation (devis), invoice (facture), situation (situation de travaux), avenant (amendment), other.
All amounts should be numbers. Dates in YYYY-MM-DD format.`,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this PDF document "${fileName}" and extract:
- documentType: quotation|invoice|situation|avenant|other|unknown
- contractorName: the company/contractor name
- clientName: the client/maître d'ouvrage name
- projectAddress: site/project address
- reference: document reference number
- date: document date (YYYY-MM-DD)
- amountHt: total amount excluding tax
- amountTtc: total amount including tax
- tvaAmount: TVA amount
- tvaRate: TVA rate percentage
- description: brief description
- lineItems: array of {description, quantity, unitPrice, total}

Return JSON only, no markdown.`,
            },
            {
              type: "image_url",
              image_url: { url: `data:application/pdf;base64,${base64}` },
            },
          ],
        },
      ],
      max_tokens: 2000,
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content || "{}";
    const cleaned = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
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

    const status = match.confidence >= 80 ? "completed" : match.confidence >= 30 ? "needs_review" : "needs_review";

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
