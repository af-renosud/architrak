import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { recoverPosteTable } from "./quotation-poste-table";
import { codedLotDescriptionMatches, recoverCodedLotTable } from "./quotation-coded-lot-table";
import { correctionCents, previewCorrectionTotals, type ArchitectCorrectionSnapshot } from "../../shared/architect-quotation";

const identity = (text: string) => {
  const normalized = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const code = normalized.match(/\b([a-z]{2,4})\s*\.\s*(\d+)/);
  return code ? `${code[1]}.${Number(code[2])}` : normalized.replace(/[^a-z0-9]/g, "");
};
/** Suggestions only: never writes money, descriptions, or approval state. */
export function recoverSourceVat(pages: string[], snapshot: ArchitectCorrectionSnapshot) {
  const poste = recoverPosteTable(pages);
  const coded = poste ? null : recoverCodedLotTable(pages);
  const source = poste ?? coded;
  if (!source || !snapshot.baseline) throw new Error("The PDF table could not be verified. Review the missing rates beside the original PDF.");
  const lines = snapshot.draft.lines.filter(row => row.kind === "priced" && row.included);
  if (lines.length !== source.rows.length) throw new Error("Source and working items differ. VAT recovery needs manual review.");
  const used = new Set<number>();
  const rates = lines.map(line => {
    const matches = source.rows.map((row, index) => ({ row, index })).filter(({ row, index }) =>
      (coded ? codedLotDescriptionMatches(coded.evidence[index], line.descriptionFr) : identity(row.description) === identity(line.descriptionFr))
      && correctionCents(String(row.total)) === correctionCents(line.totalHt));
    if (matches.length !== 1 || used.has(matches[0].index)) throw new Error("An item cannot be uniquely matched to the PDF. No rates were applied.");
    const { index } = matches[0]; used.add(index);
    const raw = coded ? coded.evidence[index].vatRate : source.evidence[index].priceText.match(/(\d+[,.]\d+)\s*$/)?.[1];
    if (!raw) throw new Error("The printed VAT rate could not be read.");
    const vatRate = raw.replace(",", ".");
    if (line.vatRate && Number(line.vatRate) !== Number(vatRate)) throw new Error("An existing VAT rate differs from the PDF. Review it manually.");
    return { clientKey: line.clientKey, vatRate, pages: source.evidence[index].pages };
  });
  const draft = { ...snapshot.draft, lines: snapshot.draft.lines.map(line => ({
    ...line, vatRate: line.vatRate || rates.find(rate => rate.clientKey === line.clientKey)?.vatRate || "",
  })) };
  const totals = previewCorrectionTotals(draft);
  if (correctionCents(totals.ttc) !== correctionCents(snapshot.baseline.ttc)
    || correctionCents(totals.ht) !== correctionCents(String(source.amountHt))
    || correctionCents(totals.ttc) !== correctionCents(String(source.amountTtc)))
    throw new Error("Recovered VAT does not reconcile with the original totals. No rates were applied.");
  return { expectedVersion: snapshot.version, rates, totals };
}
export async function readSourceVat(bytes: Buffer, snapshot: ArchitectCorrectionSnapshot) {
  if (!snapshot.baseline || createHash("sha256").update(bytes).digest("hex") !== snapshot.baseline.sourceDigest)
    throw new Error("Original PDF does not match the confirmed source.");
  const dir = await mkdtemp(join(tmpdir(), "quotation-vat-"));
  try {
    const path = join(dir, "original.pdf");
    await writeFile(path, bytes);
    const { stdout } = await promisify(execFile)("pdftotext", ["-layout", path, "-"], { timeout: 30000, maxBuffer: 2000000 });
    const pages = stdout.split("\f");
    if (!pages.at(-1)?.trim()) pages.pop();
    if (pages.length !== (await PDFDocument.load(bytes)).getPageCount()) throw new Error("PDF pages are incomplete.");
    return recoverSourceVat(pages, snapshot);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
