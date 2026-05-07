import { objectStorageClient } from "../replit_integrations/object_storage";
import { env } from "../env";

function getBucketName(): string {
  const bucketId = env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) {
    throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID not set");
  }
  return bucketId;
}

function getPrivateDir(): string {
  const dir = env.PRIVATE_OBJECT_DIR;
  if (!dir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }
  const parts = dir.startsWith("/") ? dir.slice(1).split("/") : dir.split("/");
  return parts.slice(1).join("/");
}

export async function uploadDocument(
  projectId: number | null,
  fileName: string,
  buffer: Buffer,
  contentType: string = "application/pdf"
): Promise<string> {
  const bucketName = getBucketName();
  const privateDir = getPrivateDir();
  const timestamp = Date.now();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const prefix = projectId ? `projects/${projectId}/documents` : "unmatched/documents";
  const objectName = `${privateDir}/${prefix}/${timestamp}_${safeName}`;

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  await file.save(buffer, {
    contentType,
    metadata: { contentType },
  });

  return `/${bucketName}/${objectName}`;
}

export async function getDocumentBuffer(storageKey: string): Promise<Buffer> {
  const { bucketName, objectName } = parseStorageKey(storageKey);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Document not found: ${storageKey}`);
  }
  const [buffer] = await file.download();
  return buffer;
}

export async function getDocumentStream(storageKey: string) {
  const { bucketName, objectName } = parseStorageKey(storageKey);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(`Document not found: ${storageKey}`);
  }
  const [metadata] = await file.getMetadata();
  return {
    stream: file.createReadStream(),
    contentType: (metadata.contentType as string) || "application/octet-stream",
    size: metadata.size as number,
  };
}

/**
 * Stage a design contract PDF under an explicit, slash-preserving path so
 * the confirm/preview-pdf endpoints can verify ownership by inspecting
 * the staging key segments. Goes around `uploadDocument` because that
 * helper sanitizes "/" → "_" in the supplied filename and forces the
 * `unmatched/documents/` prefix, which would defeat ownership binding.
 */
export async function uploadStagingDesignContract(
  userId: number,
  filename: string,
  buffer: Buffer,
  contentType: string = "application/pdf",
): Promise<string> {
  const bucketName = getBucketName();
  const privateDir = getPrivateDir();
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = Date.now();
  const objectName = `${privateDir}/design-contracts/staging/u${userId}/${ts}_${safeName}`;
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType, metadata: { contentType } });
  return `/${bucketName}/${objectName}`;
}

/** Returns true if the given storage key is a staging key owned by `userId`. */
export function isStagingKeyOwnedBy(storageKey: string, userId: number): boolean {
  return storageKey.includes(`/design-contracts/staging/u${userId}/`);
}

/**
 * Server-side copy + delete of an object. Used by the design-contract
 * confirm flow to move a staged PDF to its final
 * `design-contracts/{projectId}/{timestamp}_{slug}.pdf` location and to
 * archive the prior PDF under `design-contracts/{projectId}/archive/...`.
 *
 * The download → re-upload approach is chosen over a native rename/copy
 * call so we stay on the existing `objectStorageClient` API surface
 * without depending on backend-specific copy semantics. Object sizes
 * are bounded by the upload limit (≤25 MiB) so the in-memory hop is
 * acceptable.
 */
export async function moveDocument(
  sourceKey: string,
  destObjectName: string,
): Promise<string> {
  const bucketName = getBucketName();
  const buf = await getDocumentBuffer(sourceKey);
  const bucket = objectStorageClient.bucket(bucketName);
  const dest = bucket.file(destObjectName);
  await dest.save(buf, { contentType: "application/pdf", metadata: { contentType: "application/pdf" } });
  await deleteDocument(sourceKey);
  return `/${bucketName}/${destObjectName}`;
}

/** Active object name, per task spec: `design-contracts/{projectId}/{ts}_{slug}.pdf`. */
export function buildDesignContractActiveObjectName(projectId: number, filename: string): string {
  const privateDir = getPrivateDir();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = Date.now();
  return `${privateDir}/design-contracts/${projectId}/${ts}_${safe}`;
}

/**
 * Archive object name, per task spec: `design-contracts/{projectId}/archive/{originalKey}`.
 * `originalKey` here is the basename of the previous active object so the
 * archive set is browseable without further metadata.
 */
export function buildDesignContractArchiveObjectName(projectId: number, sourceStorageKey: string): string {
  const privateDir = getPrivateDir();
  const { objectName } = parseStorageKey(sourceStorageKey);
  const basename = objectName.split("/").pop() ?? "archived.pdf";
  return `${privateDir}/design-contracts/${projectId}/archive/${basename}`;
}

export async function deleteDocument(storageKey: string): Promise<void> {
  const { bucketName, objectName } = parseStorageKey(storageKey);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  const [exists] = await file.exists();
  if (exists) {
    await file.delete();
  }
}

function parseStorageKey(key: string): { bucketName: string; objectName: string } {
  const path = key.startsWith("/") ? key.slice(1) : key;
  const parts = path.split("/");
  if (parts.length < 2) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

export function isObjectStorageConfigured(): boolean {
  return !!(env.DEFAULT_OBJECT_STORAGE_BUCKET_ID && env.PRIVATE_OBJECT_DIR);
}
