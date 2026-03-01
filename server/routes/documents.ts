import { Router } from "express";
import { storage } from "../storage";
import { upload } from "../middleware/upload";
import { uploadDocument, getDocumentStream } from "../storage/object-storage";

const router = Router();

router.get("/api/projects/:projectId/documents", async (req, res) => {
  const docs = await storage.getProjectDocuments(Number(req.params.projectId));
  res.json(docs);
});

router.post("/api/projects/:projectId/documents/upload", upload.single("file"), async (req, res) => {
  try {
    const projectId = Number(req.params.projectId);
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file provided" });

    const storageKey = await uploadDocument(projectId, file.originalname, file.buffer, file.mimetype);
    const doc = await storage.createProjectDocument({
      projectId,
      fileName: file.originalname,
      storageKey,
      documentType: req.body.documentType || "other",
      uploadedBy: req.body.uploadedBy || "manual",
      description: req.body.description || null,
    });
    res.status(201).json(doc);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Upload failed: ${message}` });
  }
});

router.get("/api/documents/:id/download", async (req, res) => {
  try {
    const doc = await storage.getProjectDocument(Number(req.params.id));
    if (!doc) return res.status(404).json({ message: "Document not found" });

    const { stream, contentType, size } = await getDocumentStream(doc.storageKey);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.fileName}"`);
    if (size) res.setHeader("Content-Length", String(size));
    stream.pipe(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Download failed: ${message}` });
  }
});

router.get("/api/email-documents/:id/download", async (req, res) => {
  try {
    const doc = await storage.getEmailDocument(Number(req.params.id));
    if (!doc || !doc.storageKey) return res.status(404).json({ message: "Document not found" });

    const { stream, contentType, size } = await getDocumentStream(doc.storageKey);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.attachmentFileName || "document.pdf"}"`);
    if (size) res.setHeader("Content-Length", String(size));
    stream.pipe(res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ message: `Download failed: ${message}` });
  }
});

export default router;
