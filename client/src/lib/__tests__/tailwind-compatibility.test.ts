import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { compile } from "@tailwindcss/node";
import postcss from "postcss";
import { cn } from "../utils";

const sourceDir = path.resolve(import.meta.dirname, "../..");
let css: string;

function declarations(selector: string) {
  const values: Record<string, string> = {};
  postcss.parse(css).walkRules(selector, (rule) => {
    rule.walkDecls((decl) => { values[decl.prop] = decl.value; });
  });
  return values;
}

beforeAll(async () => {
  const compiler = await compile(readFileSync(path.join(sourceDir, "index.css"), "utf8"), {
    base: sourceDir,
    onDependency() {},
  });
  css = compiler.build([
    "bg-primary", "rounded-sm", "rounded-md", "rounded-lg",
    "shadow", "shadow-sm", "shadow-lg", "flex-shrink-0", "ring",
    "dark:bg-muted", "focus-visible:outline-hidden", "prose", "animate-in",
    "max-h-[var(--radix-select-content-available-height)]",
    "origin-[var(--radix-popover-content-transform-origin)]",
  ]);
});

describe("Tailwind 4 migration compatibility", () => {
  it("compiles the existing brand colors, radii, and class-based dark mode", () => {
    expect(declarations(".bg-primary")["background-color"]).toContain("var(--primary)");
    expect(declarations(".rounded-sm")["border-radius"]).toBe(".1875rem");
    expect(declarations(".rounded-md")["border-radius"]).toBe(".375rem");
    expect(declarations(".rounded-lg")["border-radius"]).toBe(".5625rem");
    expect(css).toContain(":is(.dark *)");
  });

  it("preserves the v3 shadow scale and non-shrinking layout utility", () => {
    expect(declarations(".shadow")["--tw-shadow"]).toContain("0 1px 3px");
    expect(declarations(".shadow-sm")["--tw-shadow"]).toContain("0 1px 2px");
    expect(declarations(".shadow-lg")["--tw-shadow"]).toContain("0 10px 15px");
    expect(declarations(".flex-shrink-0")["flex-shrink"]).toBe("0");
    expect(declarations(".ring")["--tw-ring-shadow"]).toContain("3px");
  });

  it("keeps focus outlines accessible and loads typography/animation plugins", () => {
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toContain("outline: 2px solid transparent");
    expect(css).toContain(".prose");
    expect(css).toContain(".animate-in");
    expect(css).toContain("max-height: var(--radix-select-content-available-height)");
    expect(css).toContain("transform-origin: var(--radix-popover-content-transform-origin)");
  });

  it("merges v4 utilities without dropping unrelated component styles", () => {
    expect(cn("px-3 bg-primary", "px-6")).toBe("bg-primary px-6");
    expect(cn("outline-hidden", "outline-none")).toBe("outline-none");
    expect(cn("max-h-80", "max-h-[var(--radix-select-content-available-height)]"))
      .toBe("max-h-[var(--radix-select-content-available-height)]");
  });

  it("does not reintroduce removed variable shorthand or inaccessible v3 outlines", () => {
    function check(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) check(file);
        else if (entry.name.endsWith(".tsx")) {
          const source = readFileSync(file, "utf8");
          expect(source, file).not.toMatch(/\[--[\w-]+\]/);
          expect(source, file).not.toContain("outline-none");
        }
      }
    }
    check(sourceDir);
  });
});