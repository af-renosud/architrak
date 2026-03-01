import { storage } from "../storage";
import { uploadDocument } from "../storage/object-storage";

interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

export async function processInvoiceUpload(devisId: number, file: UploadedFile) {
  const devis = await storage.getDevis(devisId);
  if (!devis) {
    return { success: false, status: 404, data: { message: "Devis not found" } };
  }

  const storageKey = await uploadDocument(devis.projectId, file.originalname, file.buffer, file.mimetype);

  await storage.createProjectDocument({
    projectId: devis.projectId,
    fileName: file.originalname,
    storageKey,
    documentType: "invoice",
    uploadedBy: "manual",
    description: `Invoice PDF upload for devis ${devis.devisCode}: ${file.originalname}`,
  });

  const { parseDocument } = await import("../gmail/document-parser");
  const parsed = await parseDocument(file.buffer, file.originalname);

  const tvaRate = parsed.tvaRate != null ? parsed.tvaRate : parseFloat(devis.tvaRate) || 20;
  const amountHt = parsed.amountHt != null ? String(parsed.amountHt) : "0.00";
  const amountTtc = parsed.amountTtc != null ? String(parsed.amountTtc) :
    (parsed.amountHt != null ? String(parsed.amountHt * (1 + tvaRate / 100)) : "0.00");

  const invoice = await storage.createInvoice({
    devisId,
    projectId: devis.projectId,
    contractorId: devis.contractorId,
    invoiceNumber: parsed.reference || file.originalname.replace(/\.pdf$/i, ""),
    certificateNumber: null,
    amountHt,
    tvaRate: String(tvaRate),
    amountTtc,
    status: "pending",
    dateIssued: parsed.date || null,
    datePaid: null,
    pdfPath: storageKey,
    notes: null,
  });

  return {
    success: true,
    status: 201,
    data: {
      invoice,
      extraction: {
        documentType: parsed.documentType,
        contractorName: parsed.contractorName,
        amountHt: parsed.amountHt,
        amountTtc: parsed.amountTtc,
        reference: parsed.reference,
        date: parsed.date,
        confidence: parsed.amountHt != null ? "high" : "low",
      },
      storageKey,
      fileName: file.originalname,
    },
  };
}
