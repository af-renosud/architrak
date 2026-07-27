import { describe, it, expect } from "vitest";
import {
  luhnValid,
  tvaIntracomFromSiren,
  findSiretCandidatesInText,
  crossCheckSiretAgainstTextLayer,
  type ParsedDocument,
} from "../document-parser";

// Real-world regression: the GESTRÉ 1266 devis — the vision model read
// SIRET 90207787300010 ("AI PISCINES") while the PDF text layer prints
// 90507767300010 (AT PISCINES).
const AT_PISCINES_FOOTER = `
Montant TVA
Total TVA :
IBAN FR76 3000 3032 3200 0201 3540 422 - BIC SOGEFRPP
SAS AT PISCINES au capital de 20 000 € - Code APE 4399D
SIRET : 90507767300010 - N° TVA Intracom : FR10905077673
`;

describe("luhnValid", () => {
  it("accepts the real SIRET and rejects the misread", () => {
    expect(luhnValid("90507767300010")).toBe(true);
    expect(luhnValid("90207787300010")).toBe(false);
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("12ab")).toBe(false);
  });
});

describe("tvaIntracomFromSiren", () => {
  it("derives the printed FR key", () => {
    expect(tvaIntracomFromSiren("905077673")).toBe("FR10905077673");
  });
});

describe("findSiretCandidatesInText", () => {
  it("finds the spaced/plain SIRET but ignores IBAN digit windows", () => {
    expect(findSiretCandidatesInText(AT_PISCINES_FOOTER)).toEqual(["90507767300010"]);
    expect(findSiretCandidatesInText("SIRET 905 077 673 00010")).toEqual(["90507767300010"]);
    expect(findSiretCandidatesInText("IBAN FR76 3000 3032 3200 0201 3540 422")).toEqual([]);
  });
});

describe("crossCheckSiretAgainstTextLayer", () => {
  const buf = Buffer.from("unused");

  it("corrects a checksum-invalid misread from the text layer, incl. TVA", async () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      siret: "90207787300010",
      tvaIntracom: "FR10902077873",
    };
    await crossCheckSiretAgainstTextLayer(parsed, buf, AT_PISCINES_FOOTER);
    expect(parsed.siret).toBe("90507767300010");
    expect(parsed.tvaIntracom).toBe("FR10905077673");
    expect(parsed.siretCrossCheck?.corrected).toBe(true);
    expect(parsed.siretCrossCheck?.originalSiret).toBe("90207787300010");
  });

  it("fills in a missing SIRET from the text layer", async () => {
    const parsed: ParsedDocument = { documentType: "quotation" };
    await crossCheckSiretAgainstTextLayer(parsed, buf, AT_PISCINES_FOOTER);
    expect(parsed.siret).toBe("90507767300010");
    expect(parsed.siretCrossCheck?.corrected).toBe(true);
  });

  it("verifies a matching SIRET without changing it", async () => {
    const parsed: ParsedDocument = {
      documentType: "quotation",
      siret: "905 077 673 00010",
      tvaIntracom: "FR10905077673",
    };
    await crossCheckSiretAgainstTextLayer(parsed, buf, AT_PISCINES_FOOTER);
    expect(parsed.siret).toBe("905 077 673 00010");
    expect(parsed.tvaIntracom).toBe("FR10905077673");
    expect(parsed.siretCrossCheck?.corrected).toBe(false);
  });

  it("keeps a checksum-VALID AI SIRET even when the text layer prints a different one", async () => {
    // A valid AI read absent from the text layer might come from a scanned
    // header image — never swap a plausible value for a candidate.
    const parsed: ParsedDocument = { documentType: "quotation", siret: "12345670900005" };
    await crossCheckSiretAgainstTextLayer(parsed, buf, AT_PISCINES_FOOTER);
    expect(parsed.siret).toBe("12345670900005");
    expect(parsed.siretCrossCheck?.corrected).toBe(false);
    expect(parsed.siretCrossCheck?.reason).toContain("Kept the AI value");
  });

  it("leaves an invalid SIRET untouched when the PDF has no text layer", async () => {
    const parsed: ParsedDocument = { documentType: "quotation", siret: "90207787300010" };
    await crossCheckSiretAgainstTextLayer(parsed, buf, "   ");
    expect(parsed.siret).toBe("90207787300010");
    expect(parsed.siretCrossCheck?.corrected).toBe(false);
    expect(parsed.siretCrossCheck?.reason).toContain("no text layer");
  });

  it("leaves things unchanged when multiple candidates make it ambiguous", async () => {
    const twoSirets = "SIRET 90507767300010 et SIRET 12345670900005";
    const parsed: ParsedDocument = { documentType: "quotation", siret: "90207787300010" };
    await crossCheckSiretAgainstTextLayer(parsed, buf, twoSirets);
    expect(parsed.siret).toBe("90207787300010");
    expect(parsed.siretCrossCheck?.corrected).toBe(false);
  });
});
