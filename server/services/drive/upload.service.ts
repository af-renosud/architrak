/**
 * Stream a single object-storage PDF into a Drive folder (Task #198).
 *
 * Returns Drive `fileId` + `webViewLink`. Caller is responsible for
 * persisting those onto the source row (devis / invoice / certificat)
 * and the queue row.
 */

import { Readable } from "stream";
import { getDocumentBuffer } from "../../storage/object-storage";
import { getDriveConfig } from "./client";

export interface UploadResult {
  fileId: string;
  webViewLink: string;
}

export async function uploadPdfToFolder(
  parentFolderId: string,
  displayName: string,
  sourceStorageKey: string,
): Promise<UploadResult> {
  const cfg = getDriveConfig();
  if (!cfg) throw new Error("Drive auto-upload not configured");

  // Pull the PDF out of object storage. PDFs are bounded by the
  // upload limit (~25 MiB) so the in-memory hop is acceptable. If we
  // ever lift that ceiling we should switch to the streaming path
  // returned by `getDocumentStream` instead.
  const buf = await getDocumentBuffer(sourceStorageKey);

  // Drive expects a stream/Buffer for the body. Wrap the Buffer in a
  // Readable so the upload helper can pipe it.
  const body = Readable.from(buf);

  const safeName = displayName.endsWith(".pdf") ? displayName : `${displayName}.pdf`;

  const create = await cfg.client.files.create({
    requestBody: {
      name: safeName,
      parents: [parentFolderId],
      mimeType: "application/pdf",
    },
    media: {
      mimeType: "application/pdf",
      body,
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  const fileId = create.data.id;
  const webViewLink = create.data.webViewLink;
  if (!fileId) throw new Error("Drive create returned no fileId");

  // Drive sometimes omits webViewLink on shared-drive uploads when the
  // service account lacks read on the target folder — we fall back to
  // the canonical /file/d/.../view URL which always works for users
  // who have folder access.
  const link = webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
  return { fileId, webViewLink: link };
}
