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
import { decideEmailDocRetry, EMAIL_DOC_MAX_ATTEMPTS } from "../services/email-doc-retry";
import { evaluateEmailPrefilter, UNMATCHED_SENDER_STATUS } from "./email-prefilter";
import { countItemRowCandidates, mergeContinuationFragments } from "../services/extraction-completeness";

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
  documentType: "quotation" | "invoice" | "situation" | "avenant" | "acompte" | "other" | "unknown";
  contractorName?: string;
  clientName?: string;
  projectAddress?: string;
  reference?: string;
  invoiceNumber?: string;
  devisNumber?: string;
  siret?: string;
  tvaIntracom?: string;
  // Audit trail of the deterministic text-layer safeguard (not AI-produced):
  // records whether the extracted SIRET was verified/corrected against the
  // PDF's embedded text layer, and why.
  siretCrossCheck?: {
    corrected: boolean;
    originalSiret?: string | null;
    originalTvaIntracom?: string | null;
    reason: string;
  };
  // Audit note set by the validator when the line-item totals sum to the TTC
  // (VAT-inclusive) figure rather than HT — a common quotation layout, not an
  // extraction error. Recorded so operators can see why no advisory was raised.
  lineItemsVatCheck?: {
    vatInclusive: boolean;
    lineItemsTotal: number;
    matchedAgainst: "ttc" | "ht_plus_tva" | "ht_times_rate";
    note: string;
  };
  date?: string;
  amountHt?: number;
  amountTtc?: number;
  tvaAmount?: number;
  tvaRate?: number;
  autoLiquidation?: boolean;
  retenueDeGarantie?: number;
  netAPayer?: number;
  paymentTerms?: string;
  // Task #215 — Acompte (deposit) workflow. Best-effort signal extracted
  // from the devis payment-terms / down-payment clause. acompteRequired
  // is true iff the document explicitly demands a deposit on order or
  // signature; downstream the devis-upload service decides whether to
  // flip the gate on. acompteAmountHt is taken verbatim when stated;
  // otherwise the upload service derives it from acomptePercent and the
  // devis HT total (rounded). acompteTrigger is the verbatim phrase
  // that justified detection, kept for audit.
  acompteRequired?: boolean;
  acomptePercent?: number;
  acompteAmountHt?: number;
  acompteTrigger?: string;
  lotReferences?: string[];
  description?: string;
  // Task #225 — Banking details printed on the supplier devis/facture.
  // Compared against contractor.iban (sourced from ArchiDoc) at
  // certificat-issue time; a mismatch blocks issuance until an architect
  // records a banking_mismatch_overrides row. Raw verbatim — downstream
  // normalisation/validation runs through @shared/iban.
  iban?: string;
  bic?: string;
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
  // Task #350 — extraction completeness metadata, stamped by parseDocument
  // (deterministic, not AI-produced) and persisted with aiExtractedData so
  // the completeness validation is auditable on every stored extraction.
  extractionCoverage?: ExtractionCoverage;
}

export interface ExtractionCoverage {
  /** Authoritative page count from pdfinfo; null when the PDF was too broken
   *  for pdfinfo (legacy lenient path). */
  pdfPageCount: number | null;
  /** Number of page images actually rendered and sent to the AI. */
  renderedPageCount: number;
  /** Number of AI requests the pages were split across (1 = single-shot). */
  chunkCount: number;
  /** Per-page text-layer evidence: candidateRows counts deterministic
   *  item-row-looking lines found in the page's text layer. hasTextLayer is
   *  false for scanned pages (which must never false-block). */
  pageEvidence?: Array<{ page: number; candidateRows: number; hasTextLayer: boolean }>;
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

// French SIRET/SIREN numbers are Luhn-validated. A 14-digit number that
// fails the checksum CANNOT be a real SIRET — it is almost certainly an
// AI/OCR misread (e.g. 5→2, 6→8), which is exactly the failure mode that
// parked a valid AT PISCINES devis as "unknown contractor".
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// FR intracom VAT key is derivable from the SIREN: (12 + 3 × (SIREN mod 97)) mod 97.
export function tvaIntracomFromSiren(siren: string): string {
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return `FR${String(key).padStart(2, "0")}${siren}`;
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
- Distinguish Acompte (deposit invoice / deposit clause on a devis) from Situation (progress claim with cumulative percentages). On a devis, an acompte is announced via payment-terms wording such as "Acompte de 30% à la commande", "30 % à la signature", "Versement à la réservation", etc. — when present, set acompteRequired=true, capture acomptePercent and/or acompteAmountHt, and copy the verbatim phrase into acompteTrigger. On a facture, the document itself is an "acompte" when the title/header includes "FACTURE D'ACOMPTE" or "ACOMPTE Nº" — use documentType="acompte" in that case (do NOT confuse with progress invoices).

Extraction Rules:
- All monetary amounts must be numbers with exactly 2 decimal precision (e.g., 15000.00 not 15000).
- TVA rate must be a percentage number (e.g., 20 for 20%, not 0.20).
- If auto-liquidation applies, set tvaRate to 0 and autoLiquidation to true.
- Dates in YYYY-MM-DD format.
- For line items, extract description, quantity, unit (e.g. m2, m3, ml, u, forfait), unitPrice, and total for each visible line.
- For each line item, also populate "pageHint": the 1-indexed page number of the PDF on which that line appears. Pages are provided to you as separate images in order — the first image is page 1, the second is page 2, and so on. If you cannot determine the page with confidence, omit pageHint for that line.
- For each line item, also populate "bbox": the rectangle on the page image that visually contains that line's row in the table. Coordinates MUST be normalized to the [0, 1] range of the page image (x and w as a fraction of the image width; y and h as a fraction of the image height; origin at the top-left of the image). Make the box tight to the line row, including the description and the amount, but not neighbouring rows. If you cannot determine the box with confidence, omit bbox for that line — do not guess.
- A single numbered item's description often spans MULTIPLE paragraphs or wrapped lines. All descriptive text between one priced row and the next belongs to the SAME line item — append it to that item's description. NEVER emit a separate line item for a continuation paragraph: a row that has no printed unit price and no printed total of its own is not a new line item.
- If a field is not visible on the document, omit it (do not guess).`;

const USER_PROMPT = `Analyze this French construction document and extract the following fields:

- documentType: "quotation" (devis), "invoice" (facture), "situation" (situation de travaux), "avenant" (amendment), "acompte" (facture d'acompte / deposit invoice), "other", or "unknown"
- acompteRequired: boolean — true if this devis explicitly requires a deposit on order/signature (look at payment-terms and any "Conditions de règlement" block). Omit on factures.
- acomptePercent: number 0..100 — the deposit percentage if stated (e.g. 30 for "30%"). Omit if not stated.
- acompteAmountHt: number — the deposit amount HT if stated as a euro amount on the devis. Omit if only a percentage is given.
- acompteTrigger: string — the VERBATIM phrase from the document that announces the deposit (e.g. "Acompte de 30% à la commande"). Omit when no deposit clause is present.
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
- lineItems: array of line items, each with {description, quantity, unit, unitPrice, total, pageHint, bbox}. IMPORTANT: unitPrice and total must be the pre-tax (HT / hors taxes) amounts for each line — French quotations list line amounts HT in the body and only add TVA at the bottom, where the final total is TTC (tax-inclusive). Never copy TTC/tax-inclusive figures into line items. Multi-paragraph descriptions belong to ONE item: only create a new array entry when the document shows a new priced row — a paragraph without its own price is part of the previous item's description, never a new entry.
- iban: contractor IBAN printed on the document if visible (typically in a "Coordonnées bancaires" / RIB block). Copy verbatim — preserve all characters including spaces; downstream code normalises and validates.
- bic: contractor BIC / SWIFT code printed on the document if visible. Copy verbatim.

Return ONLY valid JSON, no markdown, no code blocks.`;

const EXTRACTION_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    documentType: {
      type: SchemaType.STRING,
      format: "enum",
      description: "Type of document: quotation, invoice, situation, avenant, acompte, other, or unknown",
      enum: ["quotation", "invoice", "situation", "avenant", "acompte", "other", "unknown"],
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
    acompteRequired: {
      type: SchemaType.BOOLEAN,
      description: "True when this devis explicitly requires a deposit (acompte) on order or signature. Omit on factures.",
      nullable: true,
    },
    acomptePercent: {
      type: SchemaType.NUMBER,
      description: "Acompte percentage (0..100) if stated on the devis (e.g. 30 for 30%).",
      nullable: true,
    },
    acompteAmountHt: {
      type: SchemaType.NUMBER,
      description: "Acompte amount HT in euros if stated as a fixed amount on the devis.",
      nullable: true,
    },
    acompteTrigger: {
      type: SchemaType.STRING,
      description: "Verbatim payment-terms phrase that justifies the deposit (e.g. 'Acompte de 30% à la commande').",
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
    iban: {
      type: SchemaType.STRING,
      description: "Contractor IBAN printed on the document (Coordonnées bancaires / RIB block). Copy verbatim, including spaces.",
      nullable: true,
    },
    bic: {
      type: SchemaType.STRING,
      description: "Contractor BIC / SWIFT code printed on the document. Copy verbatim.",
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

const PDF_RASTER_TIMEOUT_MS = 120000;

// Rendering DPI ladder. 200 DPI is the quality target; when a rasteriser hits
// the per-strategy time cap (huge page boxes / pathologically heavy vector
// content) or the rendered pages blow past Gemini's inline-image budget, we
// drop a rung and re-render instead of dead-ending. 72 DPI is still readable
// for the vision model and renders ~8x faster than 200 DPI.
const PDF_RASTER_DPI_LADDER = [200, 100, 72] as const;

// Floor for dynamically computed "fit" DPI rungs (see computeFitDpi) and cap
// on how many such extra rungs may be appended — keeps the ladder finite.
const MIN_RASTER_DPI = 24;
const MAX_EXTRA_FIT_RUNGS = 2;

// Overall wall-clock budget for the whole rasterisation attempt (all
// strategies, all DPI rungs). The intake sweeper reclaims stale in_flight
// jobs after 10 minutes — if rasterisation could outlive that window the
// job would be reclaimed and re-run concurrently. 8 minutes leaves headroom
// for the Gemini call and DB writes that follow.
const PDF_RASTER_TOTAL_BUDGET_MS = 8 * 60 * 1000;

// Guard rails for what we hand to Gemini as inlineData. Oversized images are
// one documented cause of an opaque "[400 Bad Request] Unable to process
// input image" — which is classified permanent and parks the document.
const MAX_IMAGE_DIMENSION_PX = 6000;
const MAX_TOTAL_IMAGE_BYTES = 14 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A rasteriser killed at the time cap can leave a partially-written PNG on
// disk. Sending such a truncated file to Gemini yields a permanent-looking
// 400 ("Unable to process input image") and parks the document, so every
// collected page must prove it is a complete PNG: correct 8-byte signature
// AND the mandatory IEND trailer chunk (always the last 12 bytes of a
// well-formed PNG stream).
function isCompletePng(buf: Buffer): boolean {
  if (buf.length < 33) return false; // signature (8) + IHDR chunk (25) minimum
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  return buf.subarray(buf.length - 8, buf.length - 4).toString("latin1") === "IEND";
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  // IHDR is required to be the first chunk: length at 8-11, type at 12-15,
  // then 4-byte big-endian width and height.
  if (buf.length < 24) return null;
  if (buf.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Task #350 — the byte budget applies PER AI REQUEST, and extraction sends at
// most EXTRACTION_CHUNK_PAGES pages per request. Judging the whole document's
// aggregate payload would force needless DPI downgrades (or outright failure)
// on long PDFs whose individual chunks fit comfortably. Exported for tests.
export function maxChunkImageBytes(images: Buffer[], chunkPages: number): number {
  let max = 0;
  for (let i = 0; i < images.length; i += chunkPages) {
    let windowBytes = 0;
    for (let j = i; j < Math.min(i + chunkPages, images.length); j++) {
      windowBytes += images[j].length;
    }
    max = Math.max(max, windowBytes);
  }
  return max;
}

function exceedsGeminiImageLimits(images: Buffer[]): string | null {
  for (const img of images) {
    const dims = pngDimensions(img);
    if (dims && (dims.width > MAX_IMAGE_DIMENSION_PX || dims.height > MAX_IMAGE_DIMENSION_PX)) {
      return `page image ${dims.width}x${dims.height}px exceeds the ${MAX_IMAGE_DIMENSION_PX}px limit`;
    }
  }
  const chunkBytes = maxChunkImageBytes(images, EXTRACTION_CHUNK_PAGES);
  if (chunkBytes > MAX_TOTAL_IMAGE_BYTES) {
    const mb = (chunkBytes / (1024 * 1024)).toFixed(1);
    return `largest ${EXTRACTION_CHUNK_PAGES}-page extraction chunk totals ${mb}MB, exceeding the ${MAX_TOTAL_IMAGE_BYTES / (1024 * 1024)}MB per-request budget`;
  }
  return null;
}

// Given complete-but-oversized pages rendered at `currentDpi`, compute a
// smaller DPI at which the SAME pages will deterministically fit Gemini's
// limits: pixel dimensions scale linearly with DPI and PNG byte size scales
// roughly quadratically. A 10% safety margin avoids landing exactly on the
// boundary. Returns null when no smaller rung can help (already at/below the
// floor).
function computeFitDpi(images: Buffer[], currentDpi: number): number | null {
  let scale = 1;
  let maxDim = 0;
  // Mirror exceedsGeminiImageLimits: the byte budget is per extraction chunk
  // (per AI request), not for the whole document.
  const totalBytes = maxChunkImageBytes(images, EXTRACTION_CHUNK_PAGES);
  for (const img of images) {
    const dims = pngDimensions(img);
    if (dims) maxDim = Math.max(maxDim, dims.width, dims.height);
  }
  if (maxDim > MAX_IMAGE_DIMENSION_PX) {
    scale = Math.min(scale, MAX_IMAGE_DIMENSION_PX / maxDim);
  }
  if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
    scale = Math.min(scale, Math.sqrt(MAX_TOTAL_IMAGE_BYTES / totalBytes));
  }
  const fit = Math.max(Math.floor(currentDpi * scale * 0.9), MIN_RASTER_DPI);
  return fit < currentDpi ? fit : null;
}

function runRasterCommand(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; timedOut: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: PDF_RASTER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        // execFile sets killed=true when it SIGTERMs the child at the
        // timeout. A timed-out rasteriser may have written partial output,
        // and lowering the DPI (not switching backend) is the right retry.
        const timedOut = Boolean(err && (err.killed || err.signal === "SIGTERM"));
        const detail = (stderr || (err ? err.message : "") || "").toString().trim();
        resolve({ ok: !err, timedOut, detail });
      },
    );
  });
}

// Sort rendered pages by their trailing page number, NOT lexically. pdftoppm
// zero-pads its numbering so a lexical sort happens to work, but ghostscript's
// `page-%d.png` pattern does not (page-10 sorts before page-2 lexically) —
// which silently reorders pages on any document past 9 pages.
function pageNumberOf(fileName: string): number {
  const m = fileName.match(/(\d+)\.png$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

async function collectPngPages(dir: string, maxPages: number): Promise<Buffer[]> {
  const files = await readdir(dir);
  const pngFiles = files
    .filter((f) => f.endsWith(".png"))
    .sort((a, b) => pageNumberOf(a) - pageNumberOf(b) || a.localeCompare(b));
  const images: Buffer[] = [];
  for (const pngFile of pngFiles.slice(0, maxPages)) {
    images.push(await readFile(join(dir, pngFile)));
  }
  return images;
}

async function clearPngPages(dir: string): Promise<void> {
  const files = await readdir(dir);
  await Promise.all(
    files
      .filter((f) => f.endsWith(".png"))
      .map((f) => unlink(join(dir, f)).catch(() => undefined)),
  );
}

// ── Authoritative PDF page count (Task #350) ───────────────────────────────
// pdfinfo reads the page count from the PDF catalog without rendering — the
// authoritative back-check for extraction completeness. Returns null when the
// PDF is too broken for pdfinfo (rasterisation then proceeds leniently, as
// before, rather than dead-ending on the counter itself).
export async function getPdfPageCountFromFile(pdfPath: string): Promise<number | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("pdfinfo", [pdfPath], { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  } catch (err) {
    console.warn("[document-parser] pdfinfo failed — page-count back-check unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getPdfPageCount(pdfBuffer: Buffer): Promise<number | null> {
  const dir = await mkdtemp(join(tmpdir(), "architrak-pdfinfo-"));
  const p = join(dir, "doc.pdf");
  try {
    await writeFile(p, pdfBuffer);
    return await getPdfPageCountFromFile(p);
  } finally {
    try {
      await unlink(p);
      const { rmdir } = await import("fs/promises");
      await rmdir(dir);
    } catch {}
  }
}

// Extract the text layer of a single page (1-indexed) with layout preserved.
// Used for deterministic corroboration of extraction completeness. Returns
// null when the page has no text layer or pdftotext fails (scanned PDFs must
// never false-block).
export async function getPdfPageText(pdfPath: string, page: number): Promise<string | null> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "pdftotext",
        ["-f", String(page), "-l", String(page), "-layout", pdfPath, "-"],
        { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
        (err, out) => {
          if (err) reject(err);
          else resolve(out);
        },
      );
    });
    return stdout;
  } catch {
    return null;
  }
}

// Default getPageTexts dep: writes the buffer once and runs pdftotext per
// page. Any failure yields nulls (scanned/broken PDFs must never block on
// evidence gathering).
async function getPageTextsFromBuffer(pdfBuffer: Buffer, pageCount: number): Promise<Array<string | null>> {
  const dir = await mkdtemp(join(tmpdir(), "architrak-pagetext-"));
  const p = join(dir, "doc.pdf");
  try {
    await writeFile(p, pdfBuffer);
    const texts: Array<string | null> = [];
    for (let page = 1; page <= pageCount; page++) {
      texts.push(await getPdfPageText(p, page));
    }
    return texts;
  } catch {
    return Array.from({ length: pageCount }, () => null);
  } finally {
    try {
      await unlink(p);
      const { rmdir } = await import("fs/promises");
      await rmdir(dir);
    } catch {}
  }
}

// ── SIRET cross-check against the PDF text layer ──────────────────────────
// The vision models occasionally hallucinate digits when reading a SIRET off
// a page image. Most French devis PDFs are digitally generated and carry an
// embedded text layer with the exact characters — a deterministic secondary
// source we can trust over the model. Returns "" when there is no usable
// text layer (scanned documents) or pdftotext is unavailable.
export async function extractPdfTextLayer(pdfBuffer: Buffer): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "architrak-pdftext-"));
  const pdfPath = join(tempDir, "input.pdf");
  const txtPath = join(tempDir, "output.txt");
  try {
    await writeFile(pdfPath, pdfBuffer);
    const ok = await new Promise<boolean>((resolve) => {
      execFile(
        "pdftotext",
        ["-q", pdfPath, txtPath],
        { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (err) => resolve(!err),
      );
    });
    if (!ok) return "";
    return await readFile(txtPath, "utf8").catch(() => "");
  } catch {
    return "";
  } finally {
    await unlink(pdfPath).catch(() => undefined);
    await unlink(txtPath).catch(() => undefined);
  }
}

// All Luhn-valid 14-digit numbers present in the text, tolerating the usual
// "905 077 673 00010" spacing. Only MAXIMAL digit runs are considered so a
// 14-digit window inside a longer number (IBAN, phone+ref concatenations)
// can't produce a false candidate.
export function findSiretCandidatesInText(text: string): string[] {
  const out = new Set<string>();
  const runs = text.match(/\d(?:[ .\u00A0\u202F-]?\d)*/g) ?? [];
  for (const run of runs) {
    const digits = run.replace(/\D/g, "");
    if (digits.length === 14 && luhnValid(digits) && luhnValid(digits.slice(0, 9))) {
      out.add(digits);
    }
  }
  return Array.from(out);
}

// Verify (and where possible correct) the AI-extracted SIRET against the
// PDF's own text layer. Mutates `parsed` in place and records what happened
// in parsed.siretCrossCheck so the decision is auditable in extractedData.
export async function crossCheckSiretAgainstTextLayer(
  parsed: ParsedDocument,
  pdfBuffer: Buffer,
  textLayerOverride?: string,
): Promise<void> {
  try {
    const text = textLayerOverride ?? (await extractPdfTextLayer(pdfBuffer));
    const aiSiret = normalizeSiret(parsed.siret);
    const aiValid = aiSiret.length === 14 && luhnValid(aiSiret);
    if (!text.trim()) {
      if (aiSiret.length === 14 && !aiValid) {
        parsed.siretCrossCheck = {
          corrected: false,
          reason: "AI-extracted SIRET fails the Luhn checksum and the PDF has no text layer to verify against (scanned document).",
        };
      }
      return;
    }
    const candidates = findSiretCandidatesInText(text);
    if (aiValid && candidates.includes(aiSiret)) {
      parsed.siretCrossCheck = { corrected: false, reason: "Verified against the PDF text layer." };
      return;
    }
    if (candidates.length === 1) {
      const candidate = candidates[0];
      // Only OVERRIDE when the AI value is missing or checksum-invalid — a
      // checksum-valid AI SIRET that simply isn't in the text layer might be
      // legitimate (e.g. printed only in a scanned header image); replacing
      // it would risk swapping a correct read for a wrong candidate.
      if (aiValid && aiSiret !== candidate) {
        parsed.siretCrossCheck = {
          corrected: false,
          reason: `AI-extracted SIRET ${aiSiret} is checksum-valid but was not found in the PDF text layer, which prints ${candidate}. Kept the AI value — verify manually if the contractor match looks wrong.`,
        };
        return;
      }
      if (aiSiret !== candidate) {
        const originalSiret = parsed.siret;
        const originalTva = parsed.tvaIntracom;
        parsed.siret = candidate;
        // Keep the TVA number coherent: if the extracted one doesn't carry
        // the corrected SIREN, derive the correct FR key deterministically.
        if (extractSirenFromTva(parsed.tvaIntracom) !== candidate.slice(0, 9)) {
          parsed.tvaIntracom = tvaIntracomFromSiren(candidate.slice(0, 9));
        }
        parsed.siretCrossCheck = {
          corrected: true,
          originalSiret: originalSiret ?? null,
          originalTvaIntracom: originalTva ?? null,
          reason: aiSiret.length === 14
            ? `AI-extracted SIRET ${aiSiret} fails the Luhn checksum and was not found in the PDF text layer; replaced with the checksum-valid SIRET printed on the document.`
            : "AI extraction missed or mangled the SIRET; filled in from the checksum-valid SIRET printed on the document.",
        };
        console.warn(
          `[DocumentParser] SIRET cross-check corrected ${originalSiret ?? "(none)"} → ${candidate} from the PDF text layer`,
        );
      } else {
        parsed.siretCrossCheck = { corrected: false, reason: "Verified against the PDF text layer." };
      }
      return;
    }
    if (aiSiret.length === 14 && !aiValid) {
      parsed.siretCrossCheck = {
        corrected: false,
        reason: candidates.length === 0
          ? "AI-extracted SIRET fails the Luhn checksum; no checksum-valid SIRET found in the PDF text layer."
          : `AI-extracted SIRET fails the Luhn checksum; multiple checksum-valid SIRETs found in the PDF text layer (${candidates.join(", ")}) — ambiguous, left unchanged.`,
      };
    }
  } catch (err) {
    // Never let the safeguard break extraction itself.
    console.warn("[DocumentParser] SIRET cross-check failed (non-fatal):", err);
  }
}

// Renders a PDF to one PNG per page.
//
// Task #350 — completeness guarantee: when `maxPages` is omitted, ALL pages
// are rendered and the output is back-checked against the authoritative page
// count from pdfinfo. A strategy whose output is missing pages is treated as
// a failure (next backend / DPI rung), and if no strategy can produce the
// complete set the whole conversion throws — a partial extraction is never
// silently accepted (prod DVT0000959 lost pages 6–7 to the old 5-page cap).
// Callers that pass an explicit `maxPages` (e.g. the design-contract parser)
// keep prefix semantics, but the rendered prefix is still verified complete.
export async function pdfToImages(pdfBuffer: Buffer, maxPages?: number): Promise<Buffer[]> {
  const { images } = await pdfToImagesWithCoverage(pdfBuffer, maxPages);
  return images;
}

export async function pdfToImagesWithCoverage(
  pdfBuffer: Buffer,
  maxPages?: number,
): Promise<{ images: Buffer[]; pdfPageCount: number | null }> {
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

    // Authoritative page count (pdfinfo on the decrypted file). When known,
    // the rendered output MUST contain exactly the expected number of pages;
    // when pdfinfo itself fails on a broken PDF we fall back to the legacy
    // lenient behaviour rather than dead-ending on the counter.
    const pdfPageCount = await getPdfPageCountFromFile(pdfToProcess);
    const expectedPages: number | null =
      pdfPageCount != null ? (maxPages != null ? Math.min(maxPages, pdfPageCount) : pdfPageCount) : null;
    // Page limit handed to the rasterisers' -l / -dLastPage flags.
    const renderLimit = expectedPages ?? maxPages ?? 10000;

    // Rasterise with a fallback chain. Some supplier PDFs (protected,
    // oddly linearised, or with malformed xref tables) crash pdftoppm's
    // Splash backend even after qpdf decryption. We fall back to poppler's
    // Cairo backend, then to Ghostscript (repair-and-retry, then direct
    // render), which tolerates a far wider range of broken PDFs. Each
    // strategy runs with a 120s cap (high-res multi-page scans need >30s)
    // and its stderr is captured so a genuine dead-end is diagnosable
    // instead of surfacing an opaque "Command failed".
    //
    // Two failure modes get a DPI downgrade instead of a backend switch:
    //  - a strategy TIMED OUT (the page is too heavy to render at this DPI —
    //    every other backend would burn its own 120s on the same content), or
    //  - the rendered pages exceed Gemini's inline-image limits.
    // In both cases we drop to the next rung of PDF_RASTER_DPI_LADDER and
    // re-run the chain. Hard failures (crash / no output) at a given DPI stay
    // at that DPI and try the next backend; if the whole chain hard-fails,
    // lowering the DPI cannot help and we throw with the diagnostics.
    //
    // A strategy only counts as successful when every collected page is a
    // COMPLETE PNG (signature + IEND). A rasteriser killed at the time cap
    // can leave a truncated PNG on disk; accepting it sends garbage to Gemini
    // which answers with a permanent 400 and parks the document (this is
    // exactly what happened to a production devis rendered at 200 DPI in
    // ~121s — pdftoppm was killed at 120s mid-write and its partial page was
    // treated as success).
    const repairedPath = join(tempDir, "repaired.pdf");
    const gsOutputPattern = join(tempDir, "page-%d.png");

    const buildStrategies = (
      dpi: number,
    ): Array<{ name: string; run: () => Promise<{ ok: boolean; timedOut: boolean; detail: string }> }> => [
      {
        name: "pdftoppm",
        run: () =>
          runRasterCommand("pdftoppm", ["-png", "-r", String(dpi), "-l", String(renderLimit), pdfToProcess, outputPrefix]),
      },
      {
        name: "pdftocairo",
        run: () =>
          runRasterCommand("pdftocairo", ["-png", "-r", String(dpi), "-l", String(renderLimit), pdfToProcess, outputPrefix]),
      },
      {
        name: "ghostscript-repair",
        run: async () => {
          const repair = await runRasterCommand("gs", ["-q", "-o", repairedPath, "-sDEVICE=pdfwrite", pdfToProcess]);
          if (!repair.ok) return repair;
          return runRasterCommand("pdftoppm", ["-png", "-r", String(dpi), "-l", String(renderLimit), repairedPath, outputPrefix]);
        },
      },
      {
        name: "ghostscript-render",
        run: () =>
          runRasterCommand("gs", [
            "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
            "-sDEVICE=png16m", `-r${dpi}`,
            "-dFirstPage=1", `-dLastPage=${renderLimit}`,
            `-sOutputFile=${gsOutputPattern}`,
            pdfToProcess,
          ]),
      },
    ];

    const diagnostics: string[] = [];
    const rasterStartedAt = Date.now();
    // The ladder starts at the static rungs and may be EXTENDED with
    // dynamically computed "fit" DPIs when complete pages still exceed
    // Gemini's image limits at the lowest static rung (bounded by
    // MAX_EXTRA_FIT_RUNGS). Oversized images are never returned.
    const ladder: number[] = [...PDF_RASTER_DPI_LADDER];
    let extraFitRungs = 0;
    for (let rung = 0; rung < ladder.length; rung++) {
      const dpi = ladder[rung];
      let descendDpi = false;

      for (const strategy of buildStrategies(dpi)) {
        if (Date.now() - rasterStartedAt > PDF_RASTER_TOTAL_BUDGET_MS) {
          diagnostics.push(
            `raster time budget of ${PDF_RASTER_TOTAL_BUDGET_MS}ms exhausted before "${strategy.name}"@${dpi}dpi`,
          );
          throw new Error(`PDF rasterisation failed for all strategies — ${diagnostics.join(" | ")}`);
        }

        await clearPngPages(tempDir);
        const { ok, detail, timedOut } = await strategy.run();
        const images = await collectPngPages(tempDir, renderLimit);
        let allComplete = images.length > 0 && images.every(isCompletePng);

        // Task #350 — completeness back-check: when the authoritative page
        // count is known, a strategy that rendered fewer pages than expected
        // is a FAILURE even if every rendered page is a well-formed PNG.
        // Accepting the partial set is exactly how prod DVT0000959 silently
        // lost pages 6–7.
        if (allComplete && expectedPages != null && images.length !== expectedPages) {
          diagnostics.push(
            `${strategy.name}@${dpi}dpi: rendered ${images.length} page(s) but pdfinfo reports ${expectedPages} expected — incomplete output discarded`,
          );
          allComplete = false;
          if (timedOut) {
            descendDpi = true;
            break;
          }
          continue;
        }

        if (allComplete && timedOut) {
          // The rasteriser was killed at the cap AFTER finishing these pages
          // but possibly BEFORE rendering the rest — coverage may be partial.
          // Timed-out output is never accepted; re-render at a lower DPI (or,
          // past the last rung, fail with diagnostics).
          diagnostics.push(
            `${strategy.name}@${dpi}dpi: timed out after ${PDF_RASTER_TIMEOUT_MS}ms with ${images.length} complete page(s) — coverage may be partial, discarded`,
          );
          descendDpi = true;
          break;
        }

        if (allComplete && !ok) {
          // The command exited non-zero without being killed at the cap: it
          // failed on something AFTER writing these pages (later page, font,
          // resource). Exit status is honoured — the output is discarded and
          // the next backend runs at the same DPI.
          diagnostics.push(
            `${strategy.name}@${dpi}dpi: exited non-zero with ${images.length} complete page(s) on disk — output discarded (${detail.slice(0, 300) || "no stderr"})`,
          );
          continue;
        }

        if (allComplete) {
          const limitViolation = exceedsGeminiImageLimits(images);
          if (!limitViolation) {
            if (strategy.name !== "pdftoppm" || dpi !== PDF_RASTER_DPI_LADDER[0]) {
              console.log(
                `[document-parser] rasterised via "${strategy.name}" at ${dpi} DPI (${images.length} page(s))`,
              );
            }
            return { images, pdfPageCount };
          }
          diagnostics.push(`${strategy.name}@${dpi}dpi: ${limitViolation} — retrying at reduced DPI`);
          if (rung === ladder.length - 1 && extraFitRungs < MAX_EXTRA_FIT_RUNGS) {
            const fitDpi = computeFitDpi(images, dpi);
            if (fitDpi !== null) {
              ladder.push(fitDpi);
              extraFitRungs++;
            }
          }
          descendDpi = true;
          break;
        }

        if (images.length > 0) {
          diagnostics.push(
            `${strategy.name}@${dpi}dpi: produced truncated/corrupt PNG output${timedOut ? ` after ${PDF_RASTER_TIMEOUT_MS}ms timeout` : ""} — discarded`,
          );
        } else {
          diagnostics.push(
            `${strategy.name}@${dpi}dpi: ${timedOut ? `timed out after ${PDF_RASTER_TIMEOUT_MS}ms` : detail.slice(0, 300) || "no output"}`,
          );
        }

        if (timedOut) {
          descendDpi = true;
          break;
        }
      }

      if (!descendDpi) {
        // Every backend hard-failed at this DPI (crashes, not slowness) —
        // rendering smaller cannot fix a structurally unreadable PDF.
        break;
      }
    }

    throw new Error(`PDF rasterisation failed for all strategies — ${diagnostics.join(" | ")}`);
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

// Task #350 — chunked extraction. Long PDFs are split into contiguous chunks
// of at most this many pages, each extracted in its own AI request, then
// merged with global page offsets. Keeps per-request image payloads at the
// size the extraction prompt was tuned for (and under Gemini inline limits)
// while guaranteeing every page is actually shown to the model.
export const EXTRACTION_CHUNK_PAGES = 5;

// Merge per-chunk parses into a single ParsedDocument.
//  - lineItems: concatenated in chunk order; pageHint is rebased from
//    chunk-relative (the AI only sees the chunk's images) to global 1-indexed
//    pages via each chunk's page offset.
//  - identity fields (contractor, client, reference, SIRET, date, banking…):
//    first non-empty value wins — they live on page 1.
//  - totals / financial summary fields: LAST non-null value wins — French
//    devis print the totals block on the final page(s).
//  - documentType: first chunk that is not "unknown"/"other" wins.
export function mergeChunkedParses(
  chunks: Array<{ parsed: ParsedDocument; pageOffset: number; pageCount: number }>,
): ParsedDocument {
  if (chunks.length === 1 && chunks[0].pageOffset === 0) return chunks[0].parsed;

  const FIRST_WINS = [
    "contractorName", "clientName", "projectAddress", "reference", "invoiceNumber",
    "devisNumber", "siret", "tvaIntracom", "date", "paymentTerms", "iban", "bic",
    "description",
  ] as const;
  const LAST_WINS = [
    "amountHt", "amountTtc", "tvaAmount", "tvaRate", "autoLiquidation",
    "retenueDeGarantie", "netAPayer", "acompteRequired", "acomptePercent",
    "acompteAmountHt", "acompteTrigger",
  ] as const;

  const merged: ParsedDocument = { documentType: "unknown" };
  for (const { parsed } of chunks) {
    if (
      merged.documentType === "unknown" || merged.documentType === "other"
    ) {
      if (parsed.documentType && parsed.documentType !== "unknown") {
        merged.documentType = parsed.documentType;
      }
    }
    for (const key of FIRST_WINS) {
      const v = parsed[key];
      if (merged[key] == null && v != null && (typeof v !== "string" || v.trim() !== "")) {
        (merged as unknown as Record<string, unknown>)[key] = v;
      }
    }
    for (const key of LAST_WINS) {
      const v = parsed[key];
      if (v != null) (merged as unknown as Record<string, unknown>)[key] = v;
    }
  }

  // lotReferences: union in order, de-duplicated.
  const lotRefs: string[] = [];
  for (const { parsed } of chunks) {
    for (const ref of parsed.lotReferences ?? []) {
      if (!lotRefs.includes(ref)) lotRefs.push(ref);
    }
  }
  if (lotRefs.length > 0) merged.lotReferences = lotRefs;

  const lineItems: NonNullable<ParsedDocument["lineItems"]> = [];
  for (const { parsed, pageOffset, pageCount } of chunks) {
    for (const item of parsed.lineItems ?? []) {
      const rebased = { ...item };
      if (typeof item.pageHint === "number" && Number.isFinite(item.pageHint)) {
        // The AI was told "the first image is page 1" — for a chunk starting
        // at global page pageOffset+1, hint N maps to pageOffset+N. Hints
        // outside the chunk's own range are unreliable; drop them rather
        // than rebasing garbage.
        if (item.pageHint >= 1 && item.pageHint <= pageCount) {
          rebased.pageHint = item.pageHint + pageOffset;
        } else {
          delete rebased.pageHint;
          delete rebased.bbox;
        }
      }
      lineItems.push(rebased);
    }
  }
  if (lineItems.length > 0) merged.lineItems = lineItems;

  const rawTexts = chunks.map((c) => c.parsed.rawText).filter(Boolean);
  if (rawTexts.length > 0) merged.rawText = rawTexts.join("\n");

  return merged;
}

export interface ParseDocumentDeps {
  pdfToImages?: (pdfBuffer: Buffer) => Promise<Buffer[]>;
  /** Task #350 — preferred raster dep: returns the authoritative page count
   *  alongside the rendered pages. Falls back to pdfToImages when absent. */
  pdfToImagesWithCoverage?: (pdfBuffer: Buffer) => Promise<{ images: Buffer[]; pdfPageCount: number | null }>;
  /** Task #350 — per-page text-layer extraction for completeness evidence. */
  getPageTexts?: (pdfBuffer: Buffer, pageCount: number) => Promise<Array<string | null>>;
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
  const _getActiveModel = deps.getActiveModel ?? getActiveModel;
  const _parseWithGemini = deps.parseWithGemini ?? parseWithGemini;
  const _parseWithOpenAI = deps.parseWithOpenAI ?? parseWithOpenAI;
  const _getOpenAIFallbackModelId = deps.getOpenAIFallbackModelId ?? getOpenAIFallbackModelId;
  const _hasOpenAIKey = deps.hasOpenAIKey ?? hasOpenAIKey;
  const _pdfToImagesWithCoverage: (buf: Buffer) => Promise<{ images: Buffer[]; pdfPageCount: number | null }> =
    deps.pdfToImagesWithCoverage
      ?? (deps.pdfToImages
        ? async (buf: Buffer) => {
            const images = await deps.pdfToImages!(buf);
            return { images, pdfPageCount: images.length };
          }
        : (buf: Buffer) => pdfToImagesWithCoverage(buf));
  const _getPageTexts = deps.getPageTexts ?? getPageTextsFromBuffer;

  let images: Buffer[];
  let pdfPageCount: number | null;
  try {
    console.log(`[DocumentParser] Converting PDF "${fileName}" to images...`);
    ({ images, pdfPageCount } = await _pdfToImagesWithCoverage(pdfBuffer));
  } catch (err: any) {
    console.error("[DocumentParser] PDF conversion error:", err.message);
    return { documentType: "unknown", rawText: `Parse failed: ${err.message}` };
  }
  if (images.length === 0) {
    return { documentType: "unknown", rawText: "PDF conversion produced no images" };
  }
  console.log(`[DocumentParser] Converted ${images.length} page(s) to PNG (pdfinfo reports ${pdfPageCount ?? "unknown"})`);

  const { provider, modelId } = await _getActiveModel();
  console.log(`[DocumentParser] Using ${provider}/${modelId} for extraction`);

  const parseChunk = async (
    chunkImages: Buffer[],
  ): Promise<{ parsed: ParsedDocument | null; err: unknown; transient: boolean }> => {
    let parsed: ParsedDocument | null = null;
    let finalErr: unknown = null;
    let finalErrTransient = false;

    if (provider === "gemini") {
      try {
        parsed = await _parseWithGemini(chunkImages, modelId);
      } catch (err: any) {
        finalErr = err;
        finalErrTransient = isTransientGeminiError(err);
        console.error(`[DocumentParser] Gemini parse error (transient=${finalErrTransient}):`, err.message);
        if (finalErrTransient && _hasOpenAIKey()) {
          const fallbackModelId = await _getOpenAIFallbackModelId();
          console.warn(`[DocumentParser] Falling back to OpenAI/${fallbackModelId} after Gemini transient failure`);
          try {
            parsed = await _parseWithOpenAI(chunkImages, fallbackModelId);
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
        parsed = await _parseWithOpenAI(chunkImages, modelId);
      } catch (err: any) {
        finalErr = err;
        finalErrTransient = isTransientGeminiError(err);
        console.error(`[DocumentParser] OpenAI parse error (transient=${finalErrTransient}):`, err.message);
      }
    }
    return { parsed, err: finalErr, transient: finalErrTransient };
  };

  // Task #350 — chunked extraction: every rendered page is shown to the AI,
  // in contiguous chunks of at most EXTRACTION_CHUNK_PAGES. Any chunk failure
  // fails the whole parse (transiency preserved) — a document with silently
  // missing middle pages must never persist as a partial draft.
  let parsed: ParsedDocument | null = null;
  let finalErr: unknown = null;
  let finalErrTransient = false;
  const chunkCount = Math.ceil(images.length / EXTRACTION_CHUNK_PAGES);

  if (chunkCount <= 1) {
    ({ parsed, err: finalErr, transient: finalErrTransient } = await parseChunk(images));
  } else {
    console.log(`[DocumentParser] Splitting ${images.length} pages into ${chunkCount} extraction chunk(s)`);
    const chunkResults: Array<{ parsed: ParsedDocument; pageOffset: number; pageCount: number }> = [];
    for (let i = 0; i < chunkCount; i++) {
      const pageOffset = i * EXTRACTION_CHUNK_PAGES;
      const chunkImages = images.slice(pageOffset, pageOffset + EXTRACTION_CHUNK_PAGES);
      const result = await parseChunk(chunkImages);
      if (!result.parsed) {
        finalErr = result.err ?? new Error(`chunk ${i + 1}/${chunkCount} returned no result`);
        finalErrTransient = result.transient;
        console.error(`[DocumentParser] Chunk ${i + 1}/${chunkCount} (pages ${pageOffset + 1}–${pageOffset + chunkImages.length}) failed — aborting whole extraction`);
        break;
      }
      chunkResults.push({ parsed: result.parsed, pageOffset, pageCount: chunkImages.length });
    }
    if (chunkResults.length === chunkCount) {
      parsed = mergeChunkedParses(chunkResults);
    } else {
      parsed = null;
    }
  }

  if (parsed) {
    // Task #356 — fold continuation-paragraph fragments (a "line" with no
    // price and no item reference whose predecessor ends mid-enumeration)
    // back into the previous item's description. Prevents phantom numbered
    // entries that shift every later line out of sync (prod DVP0000661).
    if (parsed.lineItems && parsed.lineItems.length > 1) {
      const { lineItems: foldedItems, mergedIndices } = mergeContinuationFragments(parsed.lineItems);
      if (mergedIndices.length > 0) {
        console.log(`[DocumentParser] Merged ${mergedIndices.length} continuation fragment(s) into previous line descriptions (original indices: ${mergedIndices.join(", ")})`);
        parsed.lineItems = foldedItems;
      }
    }
    // Task #350 — stamp deterministic coverage metadata (persisted via
    // aiExtractedData) so completeness validation is auditable downstream.
    let pageEvidence: ExtractionCoverage["pageEvidence"];
    try {
      const evidencePageCount = pdfPageCount ?? images.length;
      const pageTexts = await _getPageTexts(pdfBuffer, evidencePageCount);
      pageEvidence = pageTexts.map((text, idx) => ({
        page: idx + 1,
        hasTextLayer: text != null && text.trim().length > 0,
        candidateRows: text ? countItemRowCandidates(text) : 0,
      }));
    } catch (err) {
      console.warn("[DocumentParser] page text evidence gathering failed (non-fatal):", err instanceof Error ? err.message : err);
    }
    parsed.extractionCoverage = {
      pdfPageCount,
      renderedPageCount: images.length,
      chunkCount,
      ...(pageEvidence ? { pageEvidence } : {}),
    };
    // Secondary safeguard: the vision models occasionally misread SIRET
    // digits off page images. Cross-check (and correct) against the PDF's
    // deterministic text layer before anything downstream matches on it.
    await crossCheckSiretAgainstTextLayer(parsed, pdfBuffer);
    console.log(`[DocumentParser] Extracted: type=${parsed.documentType}, contractor=${parsed.contractorName}, siret=${parsed.siret}, HT=${parsed.amountHt}, TTC=${parsed.amountTtc}, autoLiq=${parsed.autoLiquidation}, lines=${parsed.lineItems?.length ?? 0}`);
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
      message: `SIRET ${parsed.siret ?? parsed.tvaIntracom ?? effectiveSiren} was found on the document but no contractor with this identifier exists in ArchiTrak. Sync from ArchiDoc or create the contractor first.${
        extractedSiret.length === 14 && !luhnValid(extractedSiret)
          ? " Note: this number fails the French SIRET checksum, so it is likely an extraction misread — try Re-analyze before creating a contractor."
          : ""
      }`,
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

export async function processEmailDocument(
  emailDocumentId: number,
  opts?: { bypassPrefilter?: boolean },
): Promise<void> {
  const exists = await storage.getEmailDocument(emailDocumentId);
  if (!exists) {
    throw new Error(`Email document ${emailDocumentId} not found`);
  }

  // Task #322 — intake watermark is enforced at the processing boundary so
  // EVERY caller (background sweeper, manual admin route) respects the
  // beta reset: dumped ('skipped') documents and anything received before
  // the watermark must never consume AI extraction.
  const { getEmailIntakeCutoff } = await import("../services/email-intake-cutoff");
  if (exists.extractionStatus === "skipped") {
    throw new Error("Document abandonné (reset du 2026-08-10) — traitement automatique et manuel désactivé.");
  }
  if (!exists.emailReceivedAt || exists.emailReceivedAt < getEmailIntakeCutoff()) {
    throw new Error("Email reçu avant le point de reprise (2026-08-10 09:00 Europe/Paris) — non traité.");
  }

  // Task #310 — atomic claim. Only the claim winner proceeds; a manual
  // "process" click racing the background sweeper (or a second app
  // instance) becomes a no-op instead of duplicating side effects.
  const emailDoc = await storage.claimEmailDocumentForProcessing(emailDocumentId, getEmailIntakeCutoff());
  if (!emailDoc) {
    console.log(`[DocumentParser] Document ${emailDocumentId} already being processed — skipping.`);
    return;
  }

  try {
    if (!emailDoc.storageKey) {
      throw new Error("No storage key for document");
    }

    const projects = await storage.getProjects({ includeArchived: true });
    const contractors = await storage.getContractors();

    // Task #323 — cheap deterministic pre-filter BEFORE any AI call. Docs
    // with no sender/subject signal tying them to a client project are
    // parked as 'unmatched_sender' (visible + rescuable in the email queue)
    // without spending extraction tokens. Enforced at the processing
    // boundary so every caller respects it; the manual re-analyze route can
    // bypass it explicitly (operator judgement wins).
    if (!opts?.bypassPrefilter) {
      // Linked inboxes are a nice-to-have signal — never let their lookup
      // failure (or absence in a test double) fail the whole document.
      const linkedUsers = await Promise.resolve()
        .then(() => storage.listGmailPollingUsers())
        .catch(() => [] as { email: string | null }[]);
      const pre = evaluateEmailPrefilter(emailDoc, {
        contractors,
        projects,
        knownEmails: linkedUsers.map((u) => u.email),
      });
      if (!pre.pass) {
        await storage.setEmailDocumentRetryState(emailDocumentId, {
          extractionStatus: UNMATCHED_SENDER_STATUS,
          processingAttempts: emailDoc.processingAttempts ?? 0,
          nextProcessAttemptAt: null,
          notes: pre.reason,
        });
        console.log(`[DocumentParser] Document ${emailDocumentId} parked as ${UNMATCHED_SENDER_STATUS} (no AI call): ${pre.reason}`);
        return;
      }
    }

    const buffer = await getDocumentBuffer(emailDoc.storageKey);
    const parsed = await parseDocument(buffer, emailDoc.attachmentFileName || "document.pdf");

    const match = await matchToProject(parsed, projects, contractors);

    const validation = validateExtraction(parsed);
    const lotWarnings = await checkLotReferencesAgainstCatalog(parsed);
    const allWarnings = [...validation.warnings, ...lotWarnings, ...match.warnings];

    // Task #350 — an extraction with blocking completeness errors (missing
    // page coverage / evidenced page without line items) must never be
    // recorded as "completed": force needs_review and record why, so the
    // operator sees the hole before any draft is created from this parse.
    // (The devis/invoice upload services independently hard-gate on the same
    // warnings when a draft is actually created from preParsed data.)
    const { findBlockingCompletenessWarnings } = await import("../services/extraction-completeness");
    const blockingCompleteness = findBlockingCompletenessWarnings(validation.warnings);
    const status = (validation.isValid && blockingCompleteness.length === 0 && match.confidence >= 80)
      ? "completed"
      : "needs_review";

    await storage.updateEmailDocument(emailDocumentId, {
      ...(blockingCompleteness.length > 0
        ? { notes: `Extraction appears incomplete: ${blockingCompleteness.map((w) => w.message).join(" ")}` }
        : {}),
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

    // Idempotency guard (Task #310): a retry after a crash between the
    // project-document insert and the final status write must not file the
    // same attachment (and enqueue its Drive upload) a second time.
    const alreadyFiled = await storage.getProjectDocumentBySourceEmailDocumentId(emailDocumentId);

    if (match.projectId && emailDoc.storageKey && !alreadyFiled) {
      const newStorageKey = await uploadDocument(
        match.projectId,
        emailDoc.attachmentFileName || "document.pdf",
        buffer,
        "application/pdf"
      );

      const projectDoc = await storage.createProjectDocument({
        projectId: match.projectId,
        fileName: emailDoc.attachmentFileName || "document.pdf",
        storageKey: newStorageKey,
        documentType: parsed.documentType || "other",
        uploadedBy: "gmail-monitor",
        description: `Auto-extracted from email: ${emailDoc.emailSubject}`,
        sourceEmailDocumentId: emailDocumentId,
      });

      // Task #198 — mirror gmail-scraped devis/factures into Drive at
      // ingest time. We don't yet have a devis/facture row (those are
      // only created when an operator confirms the draft via the
      // devis/invoice upload services, which themselves enqueue), so
      // we file under doc_kind = "scrape" with the project_document
      // id. The folder lookup still uses the project name; the file
      // lands in the project's `(unassigned-lot)` fallback until the
      // operator promotes the draft and the lot is known. Idempotent
      // on (doc_kind, doc_id). Silent no-op when feature flag off.
      if (parsed.documentType === "quotation" || parsed.documentType === "invoice") {
        try {
          const { enqueueDriveUpload } = await import("../services/drive/upload-queue.service");
          void enqueueDriveUpload({
            docKind: "scrape",
            docId: projectDoc.id,
            projectId: match.projectId,
            lotId: null,
            sourceStorageKey: newStorageKey,
            displayName: emailDoc.attachmentFileName || `scrape-${projectDoc.id}.pdf`,
            seedDevisCode: `scrape-${projectDoc.id}`,
          });
        } catch (err) {
          console.warn(`[Gmail] Drive enqueue at scrape time skipped:`, err);
        }
      }
    }

    console.log(`[DocumentParser] Processed document ${emailDocumentId}: type=${parsed.documentType}, matchConfidence=${match.confidence}%, validationValid=${validation.isValid}, validationScore=${validation.confidenceScore}, status=${status}`);
  } catch (err: any) {
    const isPasswordProtected = err instanceof PdfPasswordProtectedError;
    if (isPasswordProtected) {
      console.warn(`[DocumentParser] Document ${emailDocumentId} is password-protected — cannot extract`);
    } else {
      console.error(`[DocumentParser] Failed to process document ${emailDocumentId}:`, err);
    }
    // Task #310 — transient failures (AI 503s, network blips) go back to
    // "pending" with backoff so the background sweeper retries them;
    // permanent failures (password-protected PDFs, exhausted retries) are
    // terminal "failed". Retry columns are server-authoritative, hence the
    // dedicated storage write instead of updateEmailDocument.
    const attempts = (emailDoc.processingAttempts ?? 0) + 1;
    const transient = !isPasswordProtected && isTransientGeminiError(err);
    const decision = decideEmailDocRetry(attempts, transient);
    await storage.setEmailDocumentRetryState(emailDocumentId, {
      extractionStatus: decision.status,
      processingAttempts: attempts,
      nextProcessAttemptAt: decision.retryInMs != null ? new Date(Date.now() + decision.retryInMs) : null,
      notes: isPasswordProtected
        ? `PDF protégé par mot de passe: ${err.message}`
        : decision.status === "pending"
          ? `Erreur transitoire (tentative ${attempts}/${EMAIL_DOC_MAX_ATTEMPTS}), nouvelle tentative planifiée: ${err.message}`
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
