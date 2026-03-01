import archiver from "archiver";
import { storage } from "../storage";
import { getDocumentBuffer } from "../storage/object-storage";
import { generateCertificatPdf } from "../communications/certificat-generator";

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 200);
}

function padLot(lotNumber: string | null | undefined): string {
  if (!lotNumber) return "LOT_00";
  const num = lotNumber.replace(/\D/g, "");
  return `LOT_${num.padStart(2, "0")}`;
}

export async function generateProjectFolder(projectId: number): Promise<Buffer> {
  const project = await storage.getProject(projectId);
  if (!project) throw new Error("Project not found");

  const folderName = sanitizeFilename(`${project.code}_${project.name}`);

  const allDevis = await storage.getDevisByProject(projectId);
  const approvedDevis = allDevis.filter(
    (d) => d.status === "approved" || d.status === "signed"
  );

  const allInvoices = await storage.getInvoicesByProject(projectId);
  const approvedInvoices = allInvoices.filter(
    (i) => i.status === "approved" || i.status === "paid"
  );

  const allCertificats = await storage.getCertificatsByProject(projectId);
  const generatedCerts = allCertificats.filter(
    (c) => c.status === "ready" || c.status === "sent" || c.status === "paid"
  );

  const lots = await storage.getLotsByProject(projectId);
  const lotsMap = new Map(lots.map((l) => [l.id, l]));

  const contractors = await storage.getContractors();
  const contractorsMap = new Map(contractors.map((c) => [c.id, c]));

  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", (err: Error) => reject(err));

    const addFiles = async () => {
      for (const d of approvedDevis) {
        if (!d.pdfStorageKey) continue;
        try {
          const buffer = await getDocumentBuffer(d.pdfStorageKey);
          const lot = d.lotId ? lotsMap.get(d.lotId) : null;
          const lotPrefix = padLot(lot?.lotNumber);
          const fileName = sanitizeFilename(
            `${lotPrefix}_${d.devisCode}`
          );
          archive.append(buffer, {
            name: `${folderName}/01_Devis/${fileName}.pdf`,
          });
        } catch {
        }
      }

      for (const inv of approvedInvoices) {
        if (!inv.pdfPath) continue;
        try {
          const buffer = await getDocumentBuffer(inv.pdfPath);
          const contractor = contractorsMap.get(inv.contractorId);
          const contractorName = contractor?.name ?? "Unknown";
          const parentDevis = allDevis.find((d) => d.id === inv.devisId);
          const lot = parentDevis?.lotId ? lotsMap.get(parentDevis.lotId) : null;
          const lotPrefix = padLot(lot?.lotNumber);
          const fileName = sanitizeFilename(
            `${lotPrefix}_${inv.invoiceNumber}_${contractorName}`
          );
          archive.append(buffer, {
            name: `${folderName}/02_Factures/${fileName}.pdf`,
          });
        } catch {
        }
      }

      for (const cert of generatedCerts) {
        try {
          const { pdfBuffer } = await generateCertificatPdf(cert.id);
          const contractor = contractorsMap.get(cert.contractorId);
          const contractorName = contractor?.name ?? "Unknown";
          const dateStr = cert.dateIssued
            ? cert.dateIssued.replace(/-/g, "")
            : "NoDate";
          const fileName = sanitizeFilename(
            `${cert.certificateRef}_${contractorName}_${dateStr}`
          );
          archive.append(pdfBuffer, {
            name: `${folderName}/03_Certificats/${fileName}.pdf`,
          });
        } catch {
        }
      }

      archive.finalize();
    };

    addFiles().catch((err) => reject(err));
  });
}
