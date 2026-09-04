import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { matchToProject, parseDocument, type ParsedDocument } from "../document-parser";

const SOLEA_FIXTURE = resolve(
  process.cwd(),
  "attached_assets/26-7985-34-G2AVP-PRO-Construction_d'une_piscine_propriété_Hein_1788532330364.pdf",
);

describe("SOLEA / TRÜTKEN Gmail intake regression", () => {
  it("renders all seven pages and retains enough extracted identity to match the project and contractor", async () => {
    const pdf = await readFile(SOLEA_FIXTURE);
    const extracted: ParsedDocument = {
      documentType: "quotation",
      contractorName: "SOLEA BTP",
      clientName: "M Heinz",
      projectAddress: "406 chemin de la grange - Verfeuil",
      devisNumber: "EP 26-7985-34-G2AVP/PRO",
      amountHt: 5800,
      amountTtc: 6960,
      tvaAmount: 1160,
      tvaRate: 20,
    };
    const parseWithOpenAI = vi
      .fn()
      .mockResolvedValueOnce({ ...extracted })
      .mockRejectedValueOnce(new SyntaxError("Unexpected token 'I', \"I'm sorry,\" is not valid JSON"));
    const parseWithGemini = vi.fn(async () => ({ ...extracted }));

    const parsed = await parseDocument(pdf, "solea-trutken.pdf", {
      getActiveModel: async () => ({ provider: "openai", modelId: "gpt-4o" }),
      parseWithGemini,
      parseWithOpenAI,
      getOpenAIFallbackModelId: async () => "gpt-4o",
      getDenseCompletenessFallbackModelId: async () => null,
      hasOpenAIKey: () => false,
      hasGeminiKey: () => true,
      getGeminiFallbackModelId: () => "gemini-2.5-flash",
    });

    expect(parsed.documentType).toBe("quotation");
    expect(parsed.extractionCoverage).toMatchObject({
      pdfPageCount: 7,
      renderedPageCount: 7,
    });
    expect(parseWithOpenAI).toHaveBeenCalledTimes(2);
    expect(parseWithGemini).toHaveBeenCalledTimes(1);

    const match = await matchToProject(
      parsed,
      [
        {
          id: 9,
          name: "TRÜTKEN (VERFEUIL) 1358",
          clientName: "Heinz Hermann Trütken",
          siteAddress: "406 chemin de la grange 30630 Verfeuil",
          archivedAt: null,
        },
      ] as any,
      [
        {
          id: 54,
          name: "SOLEA BTP",
          siret: "51849138600034",
          archivedAt: null,
        },
      ] as any,
    );

    expect(match.projectId).toBe(9);
    expect(match.contractorId).toBe(54);
    expect(match.confidence).toBeGreaterThanOrEqual(30);
  }, 30_000);
});