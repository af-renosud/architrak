import { Router } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { validateRequest } from "../middleware/validate";
import { insertWishListItemSchema, updateWishListItemSchema } from "@shared/schema";

const router = Router();

const idParams = z.object({ id: z.coerce.number().int().positive() });

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

export default router;
