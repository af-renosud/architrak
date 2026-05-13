import { describe, it, expect } from "vitest";
import { normaliseFolderName } from "../folder-locator";

describe("normaliseFolderName (Task #198 strict project-folder match)", () => {
  it("collapses case + accents + whitespace", () => {
    expect(normaliseFolderName("Smith House")).toBe(normaliseFolderName("SMITH  house"));
    expect(normaliseFolderName("Château Léon")).toBe(normaliseFolderName("chateau leon"));
  });

  it("treats different projects as different even when they share a prefix", () => {
    expect(normaliseFolderName("Smith House")).not.toBe(normaliseFolderName("Smith House Pool"));
  });

  it("never returns empty string for non-empty input", () => {
    expect(normaliseFolderName("X")).toBe("x");
  });
});
