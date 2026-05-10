import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { imageUpload } from "../middleware/upload";
import { uploadDocument, getDocumentStream } from "../storage/object-storage";
import { insertWishListItemSchema, updateWishListItemSchema } from "@shared/schema";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });
const imageParams = z.object({
  id: z.coerce.number().int().positive(),
  idx: z.coerce.number().int().min(0).max(19),
});

router.get("/api/wish-list", async (_req, res) => {
  const items = await storage.getWishListItems();
  res.json(items);
});

router.post(
  "/api/wish-list",
  validateRequest({ body: insertWishListItemSchema }),
  async (req, res) => {
    const item = await storage.createWishListItem(req.body);
    res.status(201).json(item);
  },
);

router.patch(
  "/api/wish-list/:id",
  validateRequest({ params: idParams, body: updateWishListItemSchema }),
  async (req, res) => {
    const item = await storage.updateWishListItem(Number(req.params.id), req.body);
    if (!item) return res.status(404).json({ message: "Wish list item not found" });
    res.json(item);
  },
);

router.delete(
  "/api/wish-list/:id",
  validateRequest({ params: idParams }),
  async (req, res) => {
    await storage.deleteWishListItem(Number(req.params.id));
    res.json({ success: true });
  },
);

// Pasted-from-clipboard image goes straight to object storage; the returned
// storageKey is appended to the draft on the client and committed on submit.
// Orphaned uploads from abandoned drafts are accepted as the trade for
// instant thumbnail feedback.
router.post(
  "/api/wish-list/upload-image",
  imageUpload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const ext = req.file.mimetype.split("/")[1] ?? "bin";
      const storageKey = await uploadDocument(
        null,
        `wishlist_${Date.now()}.${ext}`,
        req.file.buffer,
        req.file.mimetype,
      );
      res.status(201).json({ storageKey });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Upload failed";
      res.status(500).json({ message });
    }
  },
);

// Streams a stored wishlist image by parent-row id + index. Indexing through
// the row prevents the storage key from leaking into the URL and stops
// callers from poking at unrelated objects.
router.get(
  "/api/wish-list/:id/image/:idx",
  validateRequest({ params: imageParams }),
  async (req, res) => {
    try {
      const item = await storage.getWishListItem(Number(req.params.id));
      if (!item) return res.status(404).json({ message: "Wish list item not found" });
      const idx = Number(req.params.idx);
      const key = item.imageStorageKeys[idx];
      if (!key) return res.status(404).json({ message: "Image not found" });
      const { stream, contentType } = await getDocumentStream(key);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "private, max-age=3600");
      stream.pipe(res);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to retrieve image";
      res.status(500).json({ message });
    }
  },
);

export default router;
