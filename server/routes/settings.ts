import { Router } from "express";
import { storage } from "../storage";
import { upload } from "../middleware/upload";
import { uploadDocument, getDocumentStream } from "../storage/object-storage";

const router = Router();

router.get("/api/settings/ai-models", async (_req, res) => {
  let settings = await storage.getAiModelSettings();
  if (settings.length === 0) {
    await storage.upsertAiModelSetting("document_parsing", "gemini", "gemini-2.0-flash");
    settings = await storage.getAiModelSettings();
  }
  res.json(settings);
});

router.patch("/api/settings/ai-models/:taskType", async (req, res) => {
  const { provider, modelId } = req.body;
  if (!provider || !modelId) return res.status(400).json({ message: "provider and modelId are required" });
  const setting = await storage.upsertAiModelSetting(req.params.taskType, provider, modelId);
  res.json(setting);
});

router.get("/api/settings/template-assets", async (_req, res) => {
  const assets = await storage.getTemplateAssets();
  res.json(assets);
});

router.post("/api/settings/template-assets/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    const assetType = req.body.assetType;
    if (!assetType) return res.status(400).json({ message: "assetType is required" });

    const storageKey = await uploadDocument(null, `template_${assetType}_${req.file.originalname}`, req.file.buffer, req.file.mimetype);
    const asset = await storage.upsertTemplateAsset({
      assetType,
      fileName: req.file.originalname,
      storageKey,
      mimeType: req.file.mimetype,
    });
    res.status(201).json(asset);
  } catch (error: any) {
    res.status(500).json({ message: error.message || "Upload failed" });
  }
});

router.delete("/api/settings/template-assets/:id", async (req, res) => {
  await storage.deleteTemplateAsset(Number(req.params.id));
  res.json({ success: true });
});

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
  } catch (error: any) {
    res.status(500).json({ message: error.message || "Failed to retrieve asset" });
  }
});

export default router;
