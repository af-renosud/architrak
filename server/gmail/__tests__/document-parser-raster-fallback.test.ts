import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync } from "node:fs";

/**
 * Guards the PDF rasterisation fallback chain in pdfToImages.
 *
 * History of production incidents this file protects against:
 *  - A supplier quotation (DVG0000022.pdf) parked as "unknown" because the
 *    sole rasteriser (pdftoppm) crashed on a malformed PDF and the real error
 *    was swallowed. pdfToImages now tries pdftoppm → pdftocairo → Ghostscript
 *    repair → Ghostscript direct render, and throws with per-strategy
 *    diagnostics only when ALL of them fail.
 *  - A client devis (SMITH 1304) parked with a permanent Gemini
 *    "[400 Bad Request] Unable to process input image": pdftoppm hit the
 *    120s per-strategy timeout, was SIGKILLed mid-write, and the resulting
 *    TRUNCATED PNG was accepted as success and sent to Gemini. pdfToImages
 *    now validates every collected page is a complete PNG (signature + IEND),
 *    treats a timed-out strategy as a signal to re-render at a lower DPI
 *    (200 → 100 → 72), and downgrades DPI when rendered pages exceed
 *    Gemini's inline-image limits.
 *
 * These tests mock execFile so the sequencing is verified without real
 * binaries or a live PDF.
 */

type MockBehavior =
  | "ok"
  | "ok-huge"
  | "corrupt-ok"
  | "fail"
  | "timeout"
  | "timeout-partial"
  | "timeout-complete";

const state = vi.hoisted(() => ({
  behaviors: new Map<string, MockBehavior>(),
  calls: [] as string[],
  // Simulated wall-clock advance (ms) applied on every "timeout*" behavior,
  // consumed by tests that fake Date.now to exercise the total raster budget.
  clockAdvanceOnTimeoutMs: 0,
  fakeNowMs: 0,
}));

// Minimal structurally-valid PNG: signature + IHDR (with real dimensions)
// + IEND trailer. CRCs are not validated by isCompletePng, so zeros suffice.
const makePng = vi.hoisted(() => (width = 100, height = 100): Buffer => {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n >>> 0, 0);
    return b;
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type (truecolour)
  const ihdr = Buffer.concat([u32(13), Buffer.from("IHDR"), ihdrData, u32(0)]);
  const iend = Buffer.concat([u32(0), Buffer.from("IEND"), u32(0xae426082)]);
  return Buffer.concat([sig, ihdr, iend]);
});

// A PNG cut off mid-stream — valid signature, no IEND trailer. This is what
// a rasteriser killed at the timeout leaves on disk.
const makeTruncatedPng = vi.hoisted(() => (): Buffer => makePng().subarray(0, 20));

vi.mock("child_process", () => {
  const isRepaired = (p: string): boolean =>
    typeof p === "string" && p.endsWith("repaired.pdf");

  // Classify each invocation so a test can decide how it behaves.
  const tagOf = (cmd: string, args: string[]): string => {
    if (cmd === "pdftocairo") return "pdftocairo";
    if (cmd === "pdftoppm") return args.some(isRepaired) ? "repair-render" : "pdftoppm";
    if (cmd === "gs") return args.includes("-sDEVICE=pdfwrite") ? "repair-pdfwrite" : "render";
    return "other";
  };

  const dpiOf = (cmd: string, args: string[]): string | null => {
    const rIdx = args.indexOf("-r");
    if (rIdx !== -1 && args[rIdx + 1]) return args[rIdx + 1];
    const rArg = args.find((a) => /^-r\d+$/.test(a));
    if (rArg) return rArg.slice(2);
    return null;
  };

  const writeOutput = (cmd: string, args: string[], tag: string, png: Buffer): void => {
    if (tag === "repair-pdfwrite") {
      const oIdx = args.indexOf("-o");
      writeFileSync(args[oIdx + 1], "%PDF-1.4 repaired");
      return;
    }
    if (tag === "render") {
      const outArg = args.find((a) => a.startsWith("-sOutputFile="));
      const outPath = (outArg ?? "-sOutputFile=").slice("-sOutputFile=".length);
      writeFileSync(outPath.replace("%d", "1"), png);
      return;
    }
    const prefix = args[args.length - 1];
    writeFileSync(`${prefix}-1.png`, png);
  };

  const timeoutError = (): Error & { killed: boolean; signal: string } =>
    Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGTERM" });

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
    const dpi = dpiOf(cmd, args);
    const key = dpi ? `${tag}@${dpi}` : tag;
    state.calls.push(key);

    // Exact tag@dpi behaviour wins; plain tag applies at every DPI.
    const behavior = state.behaviors.get(key) ?? state.behaviors.get(tag) ?? "fail";

    switch (behavior) {
      case "ok":
        writeOutput(cmd, args, tag, makePng());
        cb(null, "", "");
        return;
      case "ok-huge":
        writeOutput(cmd, args, tag, makePng(8000, 11000));
        cb(null, "", "");
        return;
      case "corrupt-ok":
        // Exit 0 but the PNG on disk is truncated (e.g. disk hiccup).
        writeOutput(cmd, args, tag, makeTruncatedPng());
        cb(null, "", "");
        return;
      case "timeout":
        state.fakeNowMs += state.clockAdvanceOnTimeoutMs;
        cb(timeoutError(), "", "");
        return;
      case "timeout-partial":
        state.fakeNowMs += state.clockAdvanceOnTimeoutMs;
        writeOutput(cmd, args, tag, makeTruncatedPng());
        cb(timeoutError(), "", "");
        return;
      case "timeout-complete":
        // Killed at the cap AFTER finishing page 1 but (possibly) before
        // rendering the remaining pages — the PNG on disk is complete.
        state.fakeNowMs += state.clockAdvanceOnTimeoutMs;
        writeOutput(cmd, args, tag, makePng());
        cb(timeoutError(), "", "");
        return;
      case "fail":
      default:
        cb(new Error(`sim fail ${tag}`), "", `stderr-${tag}`);
        return;
    }
  };

  return { execFile };
});

import { pdfToImages } from "../document-parser";

const fakePdf = Buffer.from("%PDF-1.4 fake");

const setBehaviors = (entries: Record<string, MockBehavior>): void => {
  state.behaviors = new Map(Object.entries(entries));
};

describe("pdfToImages — rasteriser fallback chain", () => {
  beforeEach(() => {
    state.behaviors = new Map();
    state.calls = [];
    state.clockAdvanceOnTimeoutMs = 0;
    state.fakeNowMs = 0;
    vi.restoreAllMocks();
  });

  it("returns on the first strategy (pdftoppm)", async () => {
    setBehaviors({ pdftoppm: "ok" });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].length).toBeGreaterThan(0);
  });

  it("falls back to pdftocairo when pdftoppm yields no image", async () => {
    setBehaviors({ pdftocairo: "ok" });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
  });

  it("falls back to Ghostscript repair (gs pdfwrite + pdftoppm)", async () => {
    setBehaviors({ "repair-pdfwrite": "ok", "repair-render": "ok" });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
  });

  it("falls back to Ghostscript direct render", async () => {
    setBehaviors({ render: "ok" });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
  });

  it("throws with per-strategy diagnostics when every strategy fails", async () => {
    setBehaviors({});
    await expect(pdfToImages(fakePdf)).rejects.toThrow(
      /PDF rasterisation failed for all strategies/,
    );
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/pdftoppm@200dpi: stderr-pdftoppm/);
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/ghostscript-render@200dpi: stderr-render/);
  });

  it("does NOT descend the DPI ladder on hard failures (crashes)", async () => {
    setBehaviors({});
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/PDF rasterisation failed/);
    // Rendering smaller cannot fix a structurally unreadable PDF: the whole
    // run stays at 200 DPI.
    expect(state.calls.some((c) => c.endsWith("@100") || c.endsWith("@72"))).toBe(false);
  });

  it("rejects a truncated PNG left behind by a timed-out strategy and retries at lower DPI (SMITH 1304 regression)", async () => {
    setBehaviors({
      "pdftoppm@200": "timeout-partial",
      "pdftoppm@100": "ok",
    });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    // The truncated 200 DPI page must NOT be returned — the surviving image
    // is a complete PNG from the 100 DPI retry.
    expect(imgs[0].subarray(imgs[0].length - 8, imgs[0].length - 4).toString("latin1")).toBe("IEND");
    // Timeout skips the remaining 200 DPI backends (they would burn 120s
    // each on the same heavy content) and goes straight to the lower rung.
    expect(state.calls).toContain("pdftoppm@200");
    expect(state.calls).toContain("pdftoppm@100");
    expect(state.calls).not.toContain("pdftocairo@200");
  });

  it("descends through the full DPI ladder and throws when every rung times out", async () => {
    setBehaviors({ pdftoppm: "timeout" });
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/timed out after/);
    expect(state.calls).toContain("pdftoppm@200");
    expect(state.calls).toContain("pdftoppm@100");
    expect(state.calls).toContain("pdftoppm@72");
  });

  it("treats corrupt PNG output from a non-timed-out strategy as failure and tries the next backend at the same DPI", async () => {
    setBehaviors({
      // pdftoppm "succeeds" (exit 0) but its PNG on disk is truncated —
      // e.g. disk hiccup. Must fall through to pdftocairo at the SAME DPI.
      "pdftoppm@200": "corrupt-ok",
      "pdftocairo@200": "ok",
    });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    expect(state.calls).toContain("pdftocairo@200");
    expect(state.calls.some((c) => c.endsWith("@100"))).toBe(false);
  });

  it("descends DPI even when a timed-out strategy left COMPLETE pages (coverage may be partial)", async () => {
    setBehaviors({
      "pdftoppm@200": "timeout-complete",
      "pdftoppm@100": "ok",
    });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    // The 200 DPI output was complete but the command was killed at the cap:
    // later pages may be missing, so it must NOT be accepted at a non-lowest
    // rung — the returned image comes from the 100 DPI full re-render.
    expect(state.calls).toContain("pdftoppm@100");
    expect(state.calls).not.toContain("pdftocairo@200");
  });

  it("never accepts timed-out output — even complete pages at the lowest rung fail with diagnostics", async () => {
    setBehaviors({ pdftoppm: "timeout-complete" });
    // A timed-out strategy may have been killed before rendering all pages,
    // so its output is never trusted at ANY rung. 200 and 100 descend; at 72
    // (lowest rung) it still fails and the whole run throws.
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/coverage may be partial/);
    expect(state.calls).toContain("pdftoppm@72");
  });

  it("aborts with diagnostics when the total raster wall-clock budget is exhausted", async () => {
    // Each timed-out command advances the fake clock by 5 minutes: 200 DPI
    // uses 5min, 100 DPI brings the total to 10min > the 8min budget, so the
    // 72 DPI rung must never start.
    state.clockAdvanceOnTimeoutMs = 5 * 60 * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => state.fakeNowMs);
    setBehaviors({ pdftoppm: "timeout" });
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/raster time budget .* exhausted/);
    expect(state.calls).toContain("pdftoppm@200");
    expect(state.calls).toContain("pdftoppm@100");
    expect(state.calls).not.toContain("pdftoppm@72");
  });

  it("re-renders at a lower DPI when pages exceed Gemini's image limits", async () => {
    setBehaviors({
      "pdftoppm@200": "ok-huge",
      "pdftoppm@100": "ok",
    });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    // The oversized 8000x11000 page from 200 DPI must not be returned.
    expect(imgs[0].readUInt32BE(16)).toBe(100);
    expect(state.calls).toContain("pdftoppm@100");
  });

  it("extends the ladder with a computed fit DPI when pages are still oversized at the lowest static rung", async () => {
    setBehaviors({
      // Every static rung renders oversized; the dynamically computed fit
      // rung (below 72) falls back to the plain-tag behavior and succeeds.
      pdftoppm: "ok",
      "pdftoppm@200": "ok-huge",
      "pdftoppm@100": "ok-huge",
      "pdftoppm@72": "ok-huge",
    });
    const imgs = await pdfToImages(fakePdf);
    expect(imgs).toHaveLength(1);
    // The returned image is the compliant one, not the 8000x11000 page.
    expect(imgs[0].readUInt32BE(16)).toBe(100);
    // A dynamic rung below the static ladder must have been used.
    const dynamicRung = state.calls.find((c) => {
      const m = c.match(/^pdftoppm@(\d+)$/);
      return m !== null && Number(m[1]) < 72;
    });
    expect(dynamicRung).toBeDefined();
  });

  it("throws rather than sending oversized images when no DPI can achieve compliance", async () => {
    // ok-huge at EVERY rung, including the dynamic fit rungs: the ladder is
    // extended at most MAX_EXTRA_FIT_RUNGS times, then the run fails loudly
    // instead of sending a size-violating payload to Gemini.
    setBehaviors({ pdftoppm: "ok-huge" });
    await expect(pdfToImages(fakePdf)).rejects.toThrow(/exceeds the .* limit/);
  });
});
