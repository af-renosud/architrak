import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync } from "node:fs";

/**
 * Guards the PDF rasterisation fallback chain in pdfToImages. A supplier
 * quotation (DVG0000022.pdf) parked as "unknown" in production because the
 * sole rasteriser (pdftoppm) crashed on a malformed PDF and the real error
 * was swallowed. pdfToImages now tries pdftoppm → pdftocairo → Ghostscript
 * repair → Ghostscript direct render, and throws with per-strategy
 * diagnostics only when ALL of them fail. These tests mock execFile so the
 * sequencing is verified without real binaries or a live PDF.
 */

const state = vi.hoisted(() => ({ succeed: new Set<string>() }));

vi.mock("child_process", () => {
  const isRepaired = (p: string): boolean =>
    typeof p === "string" && p.endsWith("repaired.pdf");

  // Classify each invocation so a test can decide which one "succeeds".
  const tagOf = (cmd: string, args: string[]): string => {
    if (cmd === "pdftocairo") return "pdftocairo";
    if (cmd === "pdftoppm") return args.some(isRepaired) ? "repair-render" : "pdftoppm";
    if (cmd === "gs") return args.includes("-sDEVICE=pdfwrite") ? "repair-pdfwrite" : "render";
    return "other";
  };

  const execFile = (
    cmd: string,
    args: string[],
    _options: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ): void => {
    // qpdf pre-processing: pretend the PDF is not encrypted.
    if (cmd === "qpdf") {
      cb(new Error("not encrypted"), "", "");
      return;
    }

    const tag = tagOf(cmd, args);
    if (state.succeed.has(tag)) {
      if (tag === "repair-pdfwrite") {
        const oIdx = args.indexOf("-o");
        writeFileSync(args[oIdx + 1], "%PDF-1.4 repaired");
      } else if (tag === "render") {
        const outArg = args.find((a) => a.startsWith("-sOutputFile="));
        const outPath = (outArg ?? "-sOutputFile=").slice("-sOutputFile=".length);
        writeFileSync(outPath.replace("%d", "1"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else {
        const prefix = args[args.length - 1];
        writeFileSync(`${prefix}-1.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      cb(null, "", "");
    } else {
      cb(new Error(`sim fail ${tag}`), "", `stderr-${tag}`);
    }
  };

  return { execFile };
});

import { pdfToImages } from "../document-parser";

const fakePdf = Buffer.from("%PDF-1.4 fake");

describe("pdfToImages — rasteriser fallback chain", () => {
  beforeEach(() => {
    state.succeed = new Set();
  });

  it("returns on the first strategy (pdftoppm)", async () => {
    state.succeed = new Set(["pdftoppm"]);
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].length).toBeGreaterThan(0);
  });

  it("falls back to pdftocairo when pdftoppm yields no image", async () => {
    state.succeed = new Set(["pdftocairo"]);
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
  });

  it("falls back to Ghostscript repair (gs pdfwrite + pdftoppm)", async () => {
    state.succeed = new Set(["repair-pdfwrite", "repair-render"]);
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
  });

  it("falls back to Ghostscript direct render", async () => {
    state.succeed = new Set(["render"]);
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
  });

  it("throws with per-strategy diagnostics when every strategy fails", async () => {
    state.succeed = new Set();
    await expect(pdfToImages(fakePdf)).rejects.toThrow(
      /PDF rasterisation failed for all strategies/,
    );
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/pdftoppm: stderr-pdftoppm/);
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/ghostscript-render: stderr-render/);
  });
});
