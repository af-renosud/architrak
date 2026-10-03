import { PDFDocument, StandardFonts } from "pdf-lib";

/** Entirely fictional supplier cards. Includes equal prices and a continuation. */
export function supplierPages(priceFirst = false): string[] {
  const pages = [100, 100, 300].map((price, i) => [
    "DEVIS - SYNTHETIC SUPPLIER",
    `${priceFirst ? "Référence produit" : "Repère"} : WIN-0${i + 1}`,
    "Dessin technique - dimensions 800 x 1100 mm",
    priceFirst
      ? `P.U. HT : ${price},00   Qté : 1   Montant HT : ${price},00`
      : `Quantité : 1   Prix unitaire HT : ${price},00   Total HT : ${price},00`,
  ].join("\n"));
  pages.splice(1, 0, "Repère : WIN-01 (suite)\nVitrage isolant et finition grise; poignée blanche.");
  pages[3] += "\nTOTAL GENERAL HT : 500,00";
  return pages;
}

/** Disposable PDF bytes: embedded text plus a window drawing, no external assets. */
export async function supplierPdf(pages: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([595, 842]);
    page.drawText(text, { x: 40, y: 780, size: 10, font, lineHeight: 22 });
    page.drawRectangle({ x: 60, y: 300, width: 160, height: 220, borderWidth: 1 });
    page.drawLine({ start: { x: 140, y: 300 }, end: { x: 140, y: 520 }, thickness: 1 });
  }
  return Buffer.from(await doc.save());
}