import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { upload } from "../middleware/upload";
import { processStandaloneBenchmarkUpload } from "../services/benchmark-ingest.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { getDocumentStream } from "../storage/object-storage";

const router = Router();

const uploadInputSchema = z.object({
  contractorId: z.coerce.number().int().positive().optional(),
  externalContractorName: z.string().trim().min(1).optional(),
  externalSiret: z.string().trim().optional(),
  documentDate: z.string().optional(),
  notes: z.string().optional(),
}).refine(
  (v) => v.contractorId != null || (v.externalContractorName && v.externalContractorName.length > 0),
  { message: "Either contractorId or externalContractorName is required" },
);

router.get("/api/benchmarks/tags", async (_req, res) => {
  const tags = await storage.getBenchmarkTags();
  res.json(tags);
});

router.get("/api/benchmarks/documents", async (_req, res) => {
  const docs = await storage.getBenchmarkDocuments();
  res.json(docs);
});

router.get("/api/benchmarks/documents/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
  const doc = await storage.getBenchmarkDocument(id);
  if (!doc) return res.status(404).json({ message: "Not found" });
  res.json(doc);
});

router.get("/api/benchmarks/documents/:id/pdf", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const doc = await storage.getBenchmarkDocument(id);
    if (!doc?.pdfStorageKey) return res.status(404).json({ message: "No PDF" });
    const { stream, contentType, size } = await getDocumentStream(doc.pdfStorageKey);
    res.setHeader("Content-Type", contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${doc.pdfFileName || "benchmark.pdf"}"`);
    if (size) res.setHeader("Content-Length", String(size));
    stream.pipe(res);
  } catch (err) {
    res.status(500).json({ message: (err as Error).message });
  }
});

router.delete("/api/benchmarks/documents/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
  await storage.deleteBenchmarkDocument(id);
  res.status(204).send();
});

router.post("/api/benchmarks/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });
    const parsed = uploadInputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid input", errors: parsed.error.flatten() });

    const result = await processStandaloneBenchmarkUpload(req.file, {
      contractorId: parsed.data.contractorId ?? null,
      externalContractorName: parsed.data.externalContractorName ?? null,
      externalSiret: parsed.data.externalSiret ?? null,
      documentDate: parsed.data.documentDate ?? null,
      notes: parsed.data.notes ?? null,
    });
    res.status(result.status).json(result.data);
  } catch (err: unknown) {
    if (err instanceof PdfPasswordProtectedError) {
      return res.status(422).json({ message: err.message, code: "PDF_PASSWORD_PROTECTED" });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Benchmark Upload] Error:", message);
    res.status(500).json({ message: `Upload failed: ${message}` });
  }
});

const searchQuerySchema = z.object({
  q: z.string().optional(),
  tagIds: z.string().optional(),
  contractorId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  normalizedUnit: z.string().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  needsReview: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

router.get("/api/benchmarks/search", async (req, res) => {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ message: "Invalid query", errors: parsed.error.flatten() });
  const filters = {
    q: parsed.data.q,
    tagIds: parsed.data.tagIds ? parsed.data.tagIds.split(",").map(s => Number(s)).filter(n => Number.isFinite(n)) : undefined,
    contractorId: parsed.data.contractorId,
    dateFrom: parsed.data.dateFrom,
    dateTo: parsed.data.dateTo,
    normalizedUnit: parsed.data.normalizedUnit,
    minPrice: parsed.data.minPrice,
    maxPrice: parsed.data.maxPrice,
    needsReview: parsed.data.needsReview === "true" ? true : parsed.data.needsReview === "false" ? false : undefined,
    limit: parsed.data.limit,
  };
  const [results, aggregates] = await Promise.all([
    storage.searchBenchmarkItems(filters),
    storage.aggregateBenchmarkPrices(filters),
  ]);
  res.json({ results, aggregates });
});

const editTagsSchema = z.object({
  tagIds: z.array(z.number().int().positive()).max(3, "At most 3 tags per item"),
});

router.put("/api/benchmarks/items/:id/tags", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
  const parsed = editTagsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
  await storage.setBenchmarkItemTags(id, parsed.data.tagIds);
  const tags = await storage.getBenchmarkItemTags(id);
  res.json({ itemId: id, tags });
});

router.delete("/api/benchmarks/items/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: "Invalid id" });
  await storage.deleteBenchmarkItem(id);
  res.status(204).send();
});

export default router;
