import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Banking warning destinations", () => {
  const cases = [
    ["client/src/pages/certificats.tsx", ["cert.contractorId", "selectedContractor.id"]],
    ["client/src/pages/project-detail.tsx", ["c.contractorId"]],
    ["client/src/components/certificats/CertificatDetailDialog.tsx", ["contractor.id"]],
    ["client/src/components/factures/FacturesTab.tsx", ["invoices[0].contractorId"]],
  ] as const;

  for (const [file, ids] of cases) {
    it(`${file} links to the affected contractor, not the nonexistent route`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/href(?:=|: )["']\/contractors["']/);
      for (const id of ids) {
        expect(source).toContain("/entreprises/${" + id + "}#banking");
      }
    });
  }
});
