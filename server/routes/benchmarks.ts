import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { upload } from "../middleware/upload";
import { processStandaloneBenchmarkUpload } from "../services/benchmark-ingest.service";
import { PdfPasswordProtectedError } from "../gmail/document-parser";
import { getDocumentStream } from "../storage/object-storage";
import { validateRequest } from "../middleware/validate";
import { BENCHMARK_UPLOAD_ERROR_CODES } from "../../shared/benchmark-upload-errors";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });

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
type UploadInput = z.infer<typeof uploadInputSchema>;

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

router.delete(
  "/api/benchmarks/documents/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteBenchmarkDocument(Number(req.params.id));
    res.status(204).send();
  },
);

router.post(
  "/api/benchmarks/upload",
  upload.single("file"),
  validateRequest({ body: uploadInputSchema }),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ message: "No file provided", code: BENCHMARK_UPLOAD_ERROR_CODES.NO_FILE_PROVIDED });
      }
      const body = req.body as UploadInput;
      const result = await processStandaloneBenchmarkUpload(req.file, {
        contractorId: body.contractorId ?? null,
        externalContractorName: body.externalContractorName ?? null,
        externalSiret: body.externalSiret ?? null,
        documentDate: body.documentDate ?? null,
        notes: body.notes ?? null,
      });
      res.status(result.status).json(result.data);
    } catch (err: unknown) {
      if (err instanceof PdfPasswordProtectedError) {
        return res
          .status(422)
          .json({ message: err.message, code: BENCHMARK_UPLOAD_ERROR_CODES.PDF_PASSWORD_PROTECTED });
      }
      const message = err instanceof Error ? err.message : String(err);
      // assertPdfMagic and similar guards attach a numeric `.status` (e.g. 415)
      // on the thrown Error. Preserve it so the client sees the right HTTP
      // status and stable code instead of a collapsed 500.
      const statusFromErr =
        err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : null;
      if (statusFromErr === 415) {
        return res
          .status(415)
          .json({ message, code: BENCHMARK_UPLOAD_ERROR_CODES.PDF_INVALID_MAGIC });
      }
      console.error("[Benchmark Upload] Error:", message);
      res
        .status(statusFromErr ?? 500)
        .json({
          message: `Upload failed: ${message}`,
          code: BENCHMARK_UPLOAD_ERROR_CODES.BENCHMARK_UPLOAD_FAILED,
        });
    }
  },
);

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
type SearchQuery = z.infer<typeof searchQuerySchema>;

router.get(
  "/api/benchmarks/search",
  validateRequest({ query: searchQuerySchema }),
  async (req, res) => {
    const q = req.query as unknown as SearchQuery;
    const filters = {
      q: q.q,
      tagIds: q.tagIds ? q.tagIds.split(",").map((s) => Number(s)).filter((n) => Number.isFinite(n)) : undefined,
      contractorId: q.contractorId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      normalizedUnit: q.normalizedUnit,
      minPrice: q.minPrice,
      maxPrice: q.maxPrice,
      needsReview: q.needsReview === "true" ? true : q.needsReview === "false" ? false : undefined,
      limit: q.limit,
    };
    const [results, aggregates] = await Promise.all([
      storage.searchBenchmarkItems(filters),
      storage.aggregateBenchmarkPrices(filters),
    ]);
    res.json({ results, aggregates });
  },
);

const editTagsSchema = z.object({
  tagIds: z.array(z.number().int().positive()).max(3, "At most 3 tags per item"),
});

router.put(
  "/api/benchmarks/items/:id/tags",
  validateRequest({ params: idParams, body: editTagsSchema }),
  async (req, res) => {
    const id = Number(req.params.id);
    const { tagIds } = req.body as { tagIds: number[] };
    await storage.setBenchmarkItemTags(id, tagIds);
    const tags = await storage.getBenchmarkItemTags(id);
    res.json({ itemId: id, tags });
  },
);

router.delete(
  "/api/benchmarks/items/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteBenchmarkItem(Number(req.params.id));
    res.status(204).send();
  },
);

export default router;
