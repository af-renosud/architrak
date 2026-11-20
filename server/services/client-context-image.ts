import type { Response } from "express";
import { storage } from "../storage";
import { contextDocSchema, collectContextAssetIds } from "../../shared/context-doc";
import { getDocumentStream } from "../storage/object-storage";

/** Called only AFTER the route's operator or bearer-link authorization. */
export async function streamClientContextImage(devisId: number, rawAssetId: string, res: Response) {
  const assetId = Number(rawAssetId);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.sendStatus(404);
  const translation = await storage.getDevisTranslation(devisId);
  if (translation?.status !== "finalised") return res.sendStatus(404);
  const assets = await storage.getDevisLineContextAssetsByDevis(devisId);
  const asset = assets.find(a => a.id === assetId);
  if (!asset || !/^image\/(png|jpeg|webp|gif)$/.test(asset.mimeType)) return res.sendStatus(404);
  const contexts = await storage.getDevisLineContexts(devisId);
  const referenced = contexts.some(c => {
    if (c.devisLineItemId !== asset.devisLineItemId) return false;
    const parsed = contextDocSchema.safeParse(c.document);
    return parsed.success && collectContextAssetIds(parsed.data).includes(assetId);
  });
  if (!referenced) return res.sendStatus(404);
  const doc = await getDocumentStream(asset.storageKey);
  res.setHeader("Content-Type", asset.mimeType);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  doc.stream.on("error", () => res.destroy());
  doc.stream.pipe(res);
}
