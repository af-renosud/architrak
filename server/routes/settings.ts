import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { upload } from "../middleware/upload";
import { uploadDocument, getDocumentStream } from "../storage/object-storage";
import { validateRequest } from "../middleware/validate";
import { buildCertificatPreviewHtml } from "../communications/certificat-generator";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const taskTypeParams = z.object({ taskType: z.string().min(1) });
const aiModelBodySchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
});
const templateAssetUploadBodySchema = z.object({
  assetType: z.string().min(1),
});

router.get("/api/settings/ai-models", async (_req, res) => {
  let settings = await storage.getAiModelSettings();
  if (settings.length === 0) {
    await storage.upsertAiModelSetting("document_parsing", "gemini", "gemini-2.0-flash");
    settings = await storage.getAiModelSettings();
  }
  res.json(settings);
});

router.patch(
  "/api/settings/ai-models/:taskType",
  validateRequest({ params: taskTypeParams, body: aiModelBodySchema }),
  async (req, res) => {
    const { provider, modelId } = req.body as { provider: string; modelId: string };
    const setting = await storage.upsertAiModelSetting(String(req.params.taskType), provider, modelId);
    res.json(setting);
  },
);

router.get("/api/settings/template-assets", async (_req, res) => {
  const assets = await storage.getTemplateAssets();
  res.json(assets);
});

router.post(
  "/api/settings/template-assets/upload",
  upload.single("file"),
  validateRequest({ body: templateAssetUploadBodySchema }),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const { assetType } = req.body as { assetType: string };

      const storageKey = await uploadDocument(null, `template_${assetType}_${req.file.originalname}`, req.file.buffer, req.file.mimetype);
      const asset = await storage.upsertTemplateAsset({
        assetType,
        fileName: req.file.originalname,
        storageKey,
        mimeType: req.file.mimetype,
      });
      res.status(201).json(asset);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(500).json({ message });
    }
  },
);

router.delete(
  "/api/settings/template-assets/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteTemplateAsset(Number(req.params.id));
    res.json({ success: true });
  },
);

router.get("/api/template-assets/:type/url", async (req, res) => {
  const asset = await storage.getTemplateAssetByType(req.params.type);
  if (!asset) return res.status(404).json({ message: "Asset not found" });
  res.json({ storageKey: asset.storageKey, fileName: asset.fileName });
});

router.get("/api/template-assets/:type/file", async (req, res) => {
  try {
    const asset = await storage.getTemplateAssetByType(req.params.type);
    if (!asset) return res.status(404).json({ message: "Asset not found" });
    const { stream, contentType } = await getDocumentStream(asset.storageKey);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    stream.pipe(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to retrieve asset";
    res.status(500).json({ message });
  }
});

router.get("/api/settings/templates/certificat-paiement/preview", async (_req, res) => {
  try {
    const html = await buildCertificatPreviewHtml();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to render preview";
    res.status(500).json({ message });
  }
});

export default router;
