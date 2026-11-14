import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("client/src/components/devis/DevisTab.tsx", "utf8");

describe("long quotation forms stay within the viewport", () => {
  it.each(["dialog-edit-devis-refs", "dialog-draft-review"])("%s provides bounded internal scrolling", id => {
    const openingTag = source.match(new RegExp(`<DialogContent\\b[^>]*data-testid="${id}"[^>]*>`))?.[0];
    expect(openingTag).toBeDefined();
    expect(openingTag).toContain("max-h-[calc(100dvh-2rem)]");
    expect(openingTag).toContain("w-[calc(100%-2rem)]");
    expect(openingTag).toContain("overflow-y-auto");
    expect(openingTag).toContain("overscroll-contain");
  });
});
