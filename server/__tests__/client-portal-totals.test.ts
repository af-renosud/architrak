import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { renderClientPortalShell } from "../routes/client-portal-shell";

describe("client quotation totals", () => {
  for (const mode of ["live", "preview", "project-share"] as const) {
    it(`shows recorded TTC before HT in ${mode}`, () => {
      const html = renderClientPortalShell(mode === "live" ? {mode, token:"test"} : mode === "preview" ? {mode, devisId:35} : {mode, token:"test", devisId:35});
      const start = html.indexOf("function renderDevisInfo(data)");
      const end = html.indexOf("function renderAnalysis(data)", start);
      const result = runInNewContext(html.slice(start,end) + '\nrenderDevisInfo(data)', {
        data: { devis: {ref:"260309", amountHt:"32405.00", amountTtc:"34187.28"},lineItems:[] },
        escapeHtml: (s: unknown) => String(s ?? ""),
      });
      expect(result).toContain("34187.28");
      expect(result).toContain("32405.00");
      expect(result.indexOf("Total payable TTC")).toBeLessThan(result.indexOf("Amount HT"));
    });
  }
});