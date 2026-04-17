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
