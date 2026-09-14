import { describe, expect, it } from "vitest";
import {
  buildDocumentExtractionPrompt,
  mergeChunkedParses,
  type ParsedDocument,
} from "../document-parser";

describe("document-parser — related document references", () => {
  it("documents the evidence-only relationship contract in the extraction prompt", () => {
    const prompt = buildDocumentExtractionPrompt();

    expect(prompt).toContain("relatedDocumentReferences");
    expect(prompt).toContain("exact printed related-document identifier");
    expect(prompt).toContain("short verbatim phrase");
    expect(prompt).toContain("Acompte sur la commande n° CM00000195");
    expect(prompt).toContain("Never put a parent order or quotation number in devisNumber");
    expect(prompt).toContain("Never put this PDF's own identifier in relatedDocumentReferences");
  });

  it("accepts an evidence-bearing typed related reference without replacing the document's own number", () => {
    const parsed: ParsedDocument = {
      documentType: "acompte",
      invoiceNumber: "FD00000125",
      relatedDocumentReferences: [
        {
          kind: "order",
          reference: "CM00000195",
          evidenceText: "Acompte sur la commande n° CM00000195",
          page: 1,
        },
      ],
    };

    expect(parsed.invoiceNumber).toBe("FD00000125");
    expect(parsed.devisNumber).toBeUndefined();
    expect(parsed.relatedDocumentReferences).toEqual([
      {
        kind: "order",
        reference: "CM00000195",
        evidenceText: "Acompte sur la commande n° CM00000195",
        page: 1,
      },
    ]);
  });

  it("unions chunk references, rebases evidence pages, and keeps own document identity", () => {
    const merged = mergeChunkedParses([
      {
        pageOffset: 0,
        pageCount: 2,
        parsed: {
          documentType: "invoice",
          invoiceNumber: "FD00000125",
          relatedDocumentReferences: [
            {
              kind: "order",
              reference: "CM00000195",
              evidenceText: "Acompte sur la commande n° CM00000195",
              page: 2,
            },
          ],
        },
      },
      {
        pageOffset: 2,
        pageCount: 2,
        parsed: {
          documentType: "invoice",
          relatedDocumentReferences: [
            {
              // Duplicate relationship from another chunk must not create two
              // resolver candidates for the same explicitly named document.
              kind: "order",
              reference: "CM00000195",
              evidenceText: "Commande : CM00000195",
              page: 1,
            },
            {
              kind: "quotation",
              reference: "DE00000392",
              evidenceText: "Selon devis DE00000392",
              page: 1,
            },
            {
              // Runtime AI output still needs the evidence-bearing shape.
              kind: "invoice",
              reference: "FA-MISSING-EVIDENCE",
              evidenceText: "",
              page: 2,
            },
          ],
        },
      },
    ]);

    expect(merged.invoiceNumber).toBe("FD00000125");
    expect(merged.devisNumber).toBeUndefined();
    expect(merged.relatedDocumentReferences).toEqual([
      {
        kind: "order",
        reference: "CM00000195",
        evidenceText: "Acompte sur la commande n° CM00000195",
        page: 2,
      },
      {
        kind: "quotation",
        reference: "DE00000392",
        evidenceText: "Selon devis DE00000392",
        page: 3,
      },
    ]);
  });
});