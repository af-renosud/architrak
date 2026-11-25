import { createHash } from "node:crypto";
import type { Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  clientQuotationReleases,
  type ClientQuotationRelease,
  type Devis,
} from "@shared/schema";
import { getDocumentBuffer, getDocumentStream, uploadDocument } from "../storage/object-storage";
import {
  generateCombinedPdf,
  getValidatedCachedPdfKey,
} from "../communications/devis-translation-generator";
import {
  quotationPackageVersion,
  readQuotationDecisionSnapshot,
} from "./quotation-decision-snapshot";
import {
  buildClientPortalPayload,
  type ClientPortalDataPayload,
} from "../routes/public-client-checks";

/**
 * Sealed client releases.
 *
 * Everything a client can see for a quotation (page content, English
 * translation, context notes + images, cost analysis, figures and the
 * EN+FR "complete package" PDF) is served from an immutable release row,
 * never from live data. A release is prepared outside any lock (PDF
 * generation can take a minute) and committed inside the caller's locked
 * transaction only if the quotation's content version is unchanged, so the
 * sealed bytes provably match the sealed version.
 */

export type ClientReleaseReason = "publish" | "update" | "client_link" | "backfill";

/** Placeholder used for context-image URLs in the frozen payload; replaced
 * per surface at serve time so one release serves every client link. */
export const RELEASE_ASSET_BASE = "__CLIENT_RELEASE_ASSETS__";
const ASSET_REF = new RegExp(`${RELEASE_ASSET_BASE}/context-assets/(\\d+)`, "g");

export type FrozenClientPayload = Omit<ClientPortalDataPayload, "client" | "checks" | "agreed" | "rejected">;

export interface ReleaseImage {
  assetId: number;
  storageKey: string;
  mimeType: string;
  sha256: string;
}

export interface PreparedClientRelease {
  projectId: number;
  devisId: number;
  devisCode: string;
  contentVersion: string;
  payload: FrozenClientPayload;
  images: ReleaseImage[];
  packageStorageKey: string | null;
  packageSha256: string | null;
  packageBytes: number | null;
  originalStorageKey: string | null;
  originalSha256: string | null;
}

export class ClientReleaseChangedError extends Error {
  constructor() {
    super("The quotation changed while its client copy was being sealed. Please try again.");
  }
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

type Reader = Pick<typeof db, "select" | "execute">;

/** Current content version of the quotation, as used to verify a seal. */
export async function readClientContentVersion(reader: Reader, devisId: number): Promise<string | null> {
  const snapshot = await readQuotationDecisionSnapshot(reader, devisId);
  return snapshot ? quotationPackageVersion(snapshot) : null;
}

/**
 * Build the frozen artefacts for the quotation's CURRENT content. Reads the
 * content version first so any concurrent change after this point is
 * caught by the version check at commit time.
 */
export async function prepareClientRelease(devisId: number): Promise<PreparedClientRelease> {
  const contentVersion = await readClientContentVersion(db, devisId);
  const devis = await storage.getDevis(devisId);
  if (!contentVersion || !devis) throw new Error(`Quotation ${devisId} not found`);

  const live = await buildClientPortalPayload(devis, null, RELEASE_ASSET_BASE);
  if (!live) throw new Error(`Quotation ${devisId} not found`);
  const { client: _client, checks: _checks, agreed: _agreed, rejected: _rejected, ...payload } = live;

  // Copy every image the frozen page references into release-owned objects
  // (context assets can be deleted later; the release must not depend on them).
  const referenced = new Set<number>();
  const serialized = JSON.stringify(payload);
  let match: RegExpExecArray | null;
  ASSET_REF.lastIndex = 0;
  while ((match = ASSET_REF.exec(serialized)) !== null) referenced.add(Number(match[1]));
  const assets = referenced.size ? await storage.getDevisLineContextAssetsByDevis(devisId) : [];
  const images: ReleaseImage[] = [];
  for (const assetId of Array.from(referenced).sort((a, b) => a - b)) {
    const asset = assets.find(a => a.id === assetId);
    if (!asset) throw new ClientReleaseChangedError();
    const bytes = await getDocumentBuffer(asset.storageKey);
    const storageKey = await uploadDocument(devis.projectId, `client-copy-${devis.devisCode}-image-${assetId}`, bytes, asset.mimeType);
    images.push({ assetId, storageKey, mimeType: asset.mimeType, sha256: sha256(bytes) });
  }

  let originalStorageKey: string | null = null;
  let originalSha256: string | null = null;
  if (devis.pdfStorageKey) {
    const original = await getDocumentBuffer(devis.pdfStorageKey);
    originalStorageKey = await uploadDocument(devis.projectId, `client-copy-${devis.devisCode}-original-FR.pdf`, original);
    originalSha256 = sha256(original);
  }

  let packageStorageKey: string | null = null;
  let packageSha256: string | null = null;
  let packageBytes: number | null = null;
  if (payload.packageAvailable) {
    const cached = await getValidatedCachedPdfKey(devisId, "combined");
    const bytes = cached
      ? await getDocumentBuffer(cached)
      : (await generateCombinedPdf(devisId, { includeExplanations: false })).pdfBuffer;
    packageStorageKey = await uploadDocument(devis.projectId, `client-copy-${devis.devisCode}-EN-FR.pdf`, bytes);
    packageSha256 = sha256(bytes);
    packageBytes = bytes.length;
  }

  return {
    projectId: devis.projectId,
    devisId,
    devisCode: devis.devisCode,
    contentVersion,
    payload,
    images,
    packageStorageKey,
    packageSha256,
    packageBytes,
    originalStorageKey,
    originalSha256,
  };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Lock the rows whose edits change client-visible content. */
export async function lockClientContent(tx: Tx, devisId: number) {
  await tx.execute(sql`SELECT id FROM devis WHERE id=${devisId} FOR UPDATE`);
  await tx.execute(sql`SELECT id FROM devis_line_items WHERE devis_id=${devisId} FOR SHARE`);
  await tx.execute(sql`SELECT devis_id FROM devis_translations WHERE devis_id=${devisId} FOR SHARE`);
}

/**
 * Insert the release inside the caller's transaction, AFTER
 * lockClientContent. Refuses when the content changed since preparation.
 */
export async function commitClientRelease(
  tx: Tx,
  prepared: PreparedClientRelease,
  reason: ClientReleaseReason,
  actorUserId: number | null,
): Promise<ClientQuotationRelease> {
  const current = await readClientContentVersion(tx, prepared.devisId);
  if (current !== prepared.contentVersion) throw new ClientReleaseChangedError();
  const [row] = await tx.insert(clientQuotationReleases).values({
    projectId: prepared.projectId,
    devisId: prepared.devisId,
    devisCode: prepared.devisCode,
    reason,
    contentVersion: prepared.contentVersion,
    payload: prepared.payload,
    images: prepared.images,
    packageStorageKey: prepared.packageStorageKey,
    packageSha256: prepared.packageSha256,
    packageBytes: prepared.packageBytes,
    originalStorageKey: prepared.originalStorageKey,
    originalSha256: prepared.originalSha256,
    sealedByUserId: actorUserId,
  }).returning();
  return row;
}

export async function getLatestClientRelease(devisId: number, reader: Reader = db): Promise<ClientQuotationRelease | null> {
  const [row] = await reader.select().from(clientQuotationReleases)
    .where(eq(clientQuotationReleases.devisId, devisId))
    .orderBy(desc(clientQuotationReleases.id)).limit(1);
  return row ?? null;
}

export async function getClientRelease(devisId: number, releaseId: number): Promise<ClientQuotationRelease | null> {
  const [row] = await db.select().from(clientQuotationReleases)
    .where(and(eq(clientQuotationReleases.devisId, devisId), eq(clientQuotationReleases.id, releaseId)));
  return row ?? null;
}

export async function listClientReleasesForProject(projectId: number): Promise<ClientQuotationRelease[]> {
  return db.select().from(clientQuotationReleases)
    .where(eq(clientQuotationReleases.projectId, projectId))
    .orderBy(desc(clientQuotationReleases.id));
}

export async function listClientReleasesForDevis(devisId: number): Promise<ClientQuotationRelease[]> {
  return db.select().from(clientQuotationReleases)
    .where(eq(clientQuotationReleases.devisId, devisId))
    .orderBy(desc(clientQuotationReleases.id));
}

/** True when the client is seeing an older sealed version than the live content. */
export async function isClientReleaseOutdated(devisId: number): Promise<boolean> {
  const latest = await getLatestClientRelease(devisId);
  if (!latest) return true;
  return (await readClientContentVersion(db, devisId)) !== latest.contentVersion;
}

/** Per-quotation sealed-copy summary for the project's share panel. */
export async function summarizeClientReleasesForProject(projectId: number): Promise<Record<number, {
  count: number; outdated: boolean; clientVisible: boolean;
}>> {
  const rows = await db.execute(sql`
    SELECT r.devis_id, count(*)::int AS count,
      (array_agg(r.content_version ORDER BY r.id DESC))[1] AS latest_version,
      (EXISTS (SELECT 1 FROM client_project_share_devis m JOIN client_project_share_tokens t ON t.id=m.token_id
         WHERE m.devis_id=r.devis_id AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()))
       OR EXISTS (SELECT 1 FROM client_check_tokens c
         WHERE c.devis_id=r.devis_id AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now()))) AS visible
    FROM client_quotation_releases r WHERE r.project_id=${projectId} GROUP BY r.devis_id`);
  const out: Record<number, { count: number; outdated: boolean; clientVisible: boolean }> = {};
  for (const row of rows.rows) {
    const devisId = Number(row.devis_id);
    const visible = row.visible === true;
    // Only compute the (heavier) live version for quotations a client can reach.
    const outdated = visible ? (await readClientContentVersion(db, devisId)) !== row.latest_version : false;
    out[devisId] = { count: Number(row.count), outdated, clientVisible: visible };
  }
  return out;
}

/**
 * Seal a new release for the current content unless the latest release
 * already matches it. Used outside the share-link publish flow (client
 * links, explicit "update the client's copy", backfill).
 */
export async function ensureCurrentClientRelease(
  devisId: number,
  reason: ClientReleaseReason,
  actorUserId: number | null,
): Promise<{ release: ClientQuotationRelease; created: boolean }> {
  const latest = await getLatestClientRelease(devisId);
  if (latest && latest.contentVersion === await readClientContentVersion(db, devisId)) {
    return { release: latest, created: false };
  }
  const prepared = await prepareClientRelease(devisId);
  const release = await db.transaction(async tx => {
    await lockClientContent(tx, devisId);
    return commitClientRelease(tx, prepared, reason, actorUserId);
  });
  return { release, created: true };
}

/** Client-facing payload: frozen content + live identity and dialogue. */
export function releasePayloadForClient(
  release: ClientQuotationRelease,
  live: Pick<ClientPortalDataPayload, "client" | "checks" | "agreed" | "rejected">,
  assetBase: string,
): ClientPortalDataPayload & { sealedAt: string; releaseId: number } {
  const frozen = JSON.parse(
    JSON.stringify(release.payload).split(RELEASE_ASSET_BASE).join(assetBase),
  ) as FrozenClientPayload;
  return { ...frozen, ...live, sealedAt: new Date(release.sealedAt).toISOString(), releaseId: release.id };
}

/** Live dialogue state (questions/replies) — never sealed. */
export async function liveClientDialogue(
  devis: Devis,
  tokenContext: { clientName: string | null; clientEmail: string } | null,
) {
  const live = await buildClientPortalPayload(devis, tokenContext);
  if (!live) return null;
  return { client: live.client, checks: live.checks, agreed: live.agreed, rejected: live.rejected };
}

async function sendStream(res: Response, key: string, contentType: string, disposition: string) {
  const doc = await getDocumentStream(key);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", disposition);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (doc.size) res.setHeader("Content-Length", String(doc.size));
  doc.stream.on("error", () => res.destroy());
  doc.stream.pipe(res);
}

export async function streamReleasePackage(release: ClientQuotationRelease | null, res: Response, inline = false) {
  if (!release?.packageStorageKey) {
    res.status(404).json({ message: "The complete package is not available yet." });
    return;
  }
  const name = `DEVIS-${release.devisCode}-COMPLETE.pdf`.replace(/[^\w.-]/g, "_");
  try {
    await sendStream(res, release.packageStorageKey, "application/pdf", `${inline ? "inline" : "attachment"}; filename="${name}"`);
  } catch {
    if (!res.headersSent) res.status(500).json({ message: "The complete package is temporarily unavailable." });
  }
}

export async function streamReleaseOriginal(release: ClientQuotationRelease | null, res: Response) {
  if (!release?.originalStorageKey) {
    res.status(404).json({ message: "PDF unavailable" });
    return;
  }
  const name = `devis-${release.devisCode}.pdf`.replace(/[^\w.-]/g, "_");
  try {
    await sendStream(res, release.originalStorageKey, "application/pdf", `inline; filename="${name}"`);
  } catch {
    if (!res.headersSent) res.status(500).json({ message: "PDF temporarily unavailable" });
  }
}

export async function streamReleaseImage(release: ClientQuotationRelease | null, rawAssetId: string, res: Response) {
  const assetId = Number(rawAssetId);
  const image = release && Number.isSafeInteger(assetId)
    ? (release.images as ReleaseImage[]).find(i => i.assetId === assetId)
    : undefined;
  if (!image || !/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType)) {
    res.sendStatus(404);
    return;
  }
  try {
    await sendStream(res, image.storageKey, image.mimeType, "inline");
  } catch {
    if (!res.headersSent) res.sendStatus(404);
  }
}

/**
 * One-time catch-up for quotations clients could already see before
 * releases existed: seal their CURRENT content (reason "backfill"). What a
 * client saw before this seal cannot be reconstructed.
 */
export async function backfillClientReleases(): Promise<void> {
  const rows = await db.execute(sql`
    SELECT DISTINCT devis_id FROM (
      SELECT m.devis_id FROM client_project_share_devis m
        JOIN client_project_share_tokens t ON t.id = m.token_id
        WHERE t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())
      UNION
      SELECT c.devis_id FROM client_check_tokens c
        WHERE c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now())
    ) x
    WHERE NOT EXISTS (SELECT 1 FROM client_quotation_releases r WHERE r.devis_id = x.devis_id)
      AND EXISTS (SELECT 1 FROM devis d WHERE d.id = x.devis_id)
    ORDER BY devis_id`);
  for (const row of rows.rows) {
    const devisId = Number(row.devis_id);
    try {
      await ensureCurrentClientRelease(devisId, "backfill", null);
      console.log(`[ClientRelease] Sealed backfill client copy for devis ${devisId}`);
    } catch (err) {
      console.error(`[ClientRelease] Backfill seal failed for devis ${devisId}:`, err instanceof Error ? err.message : err);
    }
  }
}

export function startClientReleaseBackfill(delayMs = 30_000, retryMs = 60 * 60_000) {
  const run = () => backfillClientReleases().catch(err => console.error("[ClientRelease] backfill failed:", err));
  setTimeout(run, delayMs).unref?.();
  setInterval(run, retryMs).unref?.();
}
