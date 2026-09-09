import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("certificate reference UI authority", () => {
  it("does not expose an editable certificate reference in the project dialog", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/pages/project-detail.tsx"),
      "utf8",
    );

    expect(source).not.toContain('name="certificateRef"');
    expect(source).not.toContain("input-cert-ref-tab");
    expect(source).not.toContain("Reference is required");
  });

  it("does not expose editable TVA amount or rate controls in either manual dialog", () => {
    const projectDialog = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/pages/project-detail.tsx"),
      "utf8",
    );
    const overviewDialog = fs.readFileSync(
      path.resolve(process.cwd(), "client/src/pages/certificats.tsx"),
      "utf8",
    );

    for (const source of [projectDialog, overviewDialog]) {
      expect(source).not.toContain('name="tvaAmount"');
      expect(source).not.toContain('name="tvaRateOverride"');
      expect(source).not.toContain("input-cert-tva-rate-override");
      expect(source).toContain("manual-preview");
      expect(source).toContain("AutomaticTvaFields");
    }
  });
});