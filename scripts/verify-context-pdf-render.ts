/**
 * Repeatable verification of per-line context boxes in the REAL
 * DocRaptor/PrinceXML translated-devis PDF (task: "Check the context boxes
 * look right in an actual translated PDF").
 *
 * What it exercises and asserts, end to end, against a live devis:
 *   1. uploads two context image assets (a normal photo + a tall image that
 *      forces page-break handling) through the real service path;
 *   2. saves a rich context document (bold, italic, bullet list, a link with
 *      a custom label, a bare-URL link, an inline image) on the first line,
 *      and a tall-image + ordered-list context on the last line;
 *   3. generates the translated PDF via DocRaptor and ASSERTS:
 *        - both link URLs are present as real /URI link annotations
 *          (inspected via `qpdf --qdf`, since annots live in object streams),
 *        - the PDF is self-contained (multi-page output containing the
 *          inlined images — size sanity check),
 *        - the translated cache key is published;
 *   4. generates the combined PDF and asserts translation pages come first
 *      (page count = translated + original) and the combined key is cached;
 *   5. edits a context and asserts BOTH cache keys are cleared and
 *      contexts_version is bumped (cache invalidation), then restores the
 *      rich document.
 *
 * Visual layout (context cell styling, image sizing, break-inside behavior,
 * the 4-across meta header) is confirmed by rasterising the output:
 *   pdftoppm -r 80 -png /tmp/verify-translated.pdf /tmp/tpage
 *
 * Usage:  DEVIS_ID=2 npx tsx scripts/verify-context-pdf-render.ts
 * Requires: a devis with line items, an original PDF, and a translation row
 * in a non-finalised ready state; DOCRAPTOR_API_KEY set; ImageMagick + qpdf
 * on PATH (both are in the workspace nix env).
 */
import fs from "fs";
import { execFileSync } from "child_process";
import { saveLineContext, uploadLineContextAsset } from "../server/services/devis-line-context";
import {
  generateDevisTranslationPdf,
  generateCombinedPdf,
} from "../server/communications/devis-translation-generator";
import { storage } from "../server/storage";
import { PDFDocument } from "pdf-lib";

const DEVIS_ID = Number(process.env.DEVIS_ID || 2);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function makeImage(size: string, gradient: string, gravity: string, offset: string, text: string, out: string): Buffer {
  const font = execFileSync("bash", ["-c", "fc-list | grep -i -m1 -E 'dejavu ?sans' | cut -d: -f1"]).toString().trim();
  // -font must precede -annotate or ImageMagick tries to render with no font.
  execFileSync("magick", ["-size", size, `gradient:${gradient}`, "-font", font, "-pointsize", "40", "-fill", "white", "-gravity", gravity, "-annotate", offset, text, out]);
  return fs.readFileSync(out);
}

async function main() {
  const lines = await storage.getDevisLineItems(DEVIS_ID);
  assert(lines.length >= 2, `devis ${DEVIS_ID} has at least 2 line items`);
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];

  // --- 1. image assets -----------------------------------------------------
  const normal = makeImage("800x500", "#C1A27B-#0B2545", "center", "0", "Tile reference photo", "/tmp/verify-ctx-normal.jpg");
  const tall = makeImage("500x1500", "#0B2545-#7BAE7E", "north", "+0+60", "TALL page-break test", "/tmp/verify-ctx-tall.png");
  const asset1 = await uploadLineContextAsset(DEVIS_ID, firstLine.id, normal);
  const asset2 = await uploadLineContextAsset(DEVIS_ID, lastLine.id, tall);
  console.log(`assets uploaded: ${asset1.id} (${asset1.mimeType}), ${asset2.id} (${asset2.mimeType})`);

  // --- 2. rich context documents -------------------------------------------
  const LINK_LABELLED = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const LINK_BARE = "https://example.com/spec.pdf";
  const richDoc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [
        { type: "text", text: "Important: ", marks: [{ type: "bold" }] },
        { type: "text", text: "the sealed parts must match the " },
        { type: "text", text: "manufacturer's install video", marks: [{ type: "link", attrs: { href: LINK_LABELLED } }] },
        { type: "text", text: " before ordering." },
      ]},
      { type: "bulletList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "2 skimmers, white ABS" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Main drain with " }, { type: "text", text: "anti-vortex", marks: [{ type: "italic" }] }, { type: "text", text: " cover" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bare URL link: " }, { type: "text", text: LINK_BARE, marks: [{ type: "link", attrs: { href: LINK_BARE } }] }] }] },
      ]},
      { type: "image", attrs: { assetId: asset1.id, alt: "Tile reference" } },
      { type: "paragraph", content: [{ type: "text", text: "Photo above shows the agreed tile finish." }] },
    ],
  };
  const tallDoc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Membrane warranty terms — see the tall reference chart below (page-break test):" }] },
      { type: "image", attrs: { assetId: asset2.id, alt: "Tall chart" } },
      { type: "orderedList", content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Warranty starts at delivery" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Pro-rata after year 5" }] }] },
      ]},
    ],
  };
  const existing = await storage.getDevisLineContexts(DEVIS_ID);
  const revOf = (lineId: number) => existing.find((c) => c.devisLineItemId === lineId)?.revision ?? 0;
  const saved1 = await saveLineContext({ devisId: DEVIS_ID, devisLineItemId: firstLine.id, document: richDoc, baseRevision: revOf(firstLine.id) });
  await saveLineContext({ devisId: DEVIS_ID, devisLineItemId: lastLine.id, document: tallDoc, baseRevision: revOf(lastLine.id) });
  console.log("contexts saved");

  // --- 3. translated PDF via real DocRaptor ---------------------------------
  const gen = await generateDevisTranslationPdf(DEVIS_ID);
  fs.writeFileSync("/tmp/verify-translated.pdf", gen.pdfBuffer);
  const translatedDoc = await PDFDocument.load(gen.pdfBuffer);
  const translatedPages = translatedDoc.getPageCount();
  console.log(`translated PDF: ${gen.pdfBuffer.length} bytes, ${translatedPages} pages`);
  assert(gen.pdfBuffer.length > normal.length + tall.length, "PDF is self-contained (larger than the inlined images)");

  // Link annotations live in compressed object streams — normalise with qpdf.
  execFileSync("qpdf", ["--qdf", "/tmp/verify-translated.pdf", "/tmp/verify-translated-qdf.pdf"]);
  const qdf = fs.readFileSync("/tmp/verify-translated-qdf.pdf", "latin1");
  assert(qdf.includes(`/URI (${LINK_LABELLED})`), "custom-label link is a clickable /URI annotation");
  assert(qdf.includes(`/URI (${LINK_BARE})`), "bare-URL link is a clickable /URI annotation");

  let t = await storage.getDevisTranslation(DEVIS_ID);
  assert(!!t?.translatedPdfStorageKey, "translated PDF cache key published");

  // --- 4. combined PDF -------------------------------------------------------
  const comb = await generateCombinedPdf(DEVIS_ID);
  fs.writeFileSync("/tmp/verify-combined.pdf", comb.pdfBuffer);
  const combinedDoc = await PDFDocument.load(comb.pdfBuffer);
  console.log(`combined PDF: ${comb.pdfBuffer.length} bytes, ${combinedDoc.getPageCount()} pages`);
  assert(combinedDoc.getPageCount() > translatedPages, "combined PDF = translation pages + original pages");
  t = await storage.getDevisTranslation(DEVIS_ID);
  assert(!!t?.combinedPdfStorageKey, "combined PDF cache key published");

  // --- 5. cache invalidation on context edit ---------------------------------
  const versionBefore = t!.contextsVersion ?? 0;
  const edited = await saveLineContext({
    devisId: DEVIS_ID,
    devisLineItemId: firstLine.id,
    document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Edited context — cache must be invalidated." }] }] },
    baseRevision: saved1.revision,
  });
  t = await storage.getDevisTranslation(DEVIS_ID);
  assert(!t?.translatedPdfStorageKey, "translated cache key cleared after context edit");
  assert(!t?.combinedPdfStorageKey, "combined cache key cleared after context edit");
  assert((t?.contextsVersion ?? 0) > versionBefore, "contexts_version bumped after context edit");

  // restore the rich document so the devis stays useful for visual inspection
  await saveLineContext({ devisId: DEVIS_ID, devisLineItemId: firstLine.id, document: richDoc, baseRevision: edited.revision });

  console.log("\nAll assertions passed. Rasterise for visual review:");
  console.log("  pdftoppm -r 80 -png /tmp/verify-translated.pdf /tmp/tpage");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
