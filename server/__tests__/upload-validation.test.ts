import { describe, it, expect } from "vitest";
import { assertPdfMagic } from "../middleware/upload";

describe("assertPdfMagic", () => {
  it("accepts buffers starting with %PDF", () => {
    const buf = Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(16)]);
    expect(() => assertPdfMagic(buf)).not.toThrow();
  });

  it("rejects empty buffer", () => {
    expect(() => assertPdfMagic(Buffer.alloc(0))).toThrow(/not a valid PDF/);
  });

  it("rejects buffers shorter than 4 bytes", () => {
    expect(() => assertPdfMagic(Buffer.from("PDF"))).toThrow(/not a valid PDF/);
  });

  it("rejects HTML payloads disguised as .pdf", () => {
    const buf = Buffer.from("<!DOCTYPE html><html></html>");
    expect(() => assertPdfMagic(buf)).toThrow(/not a valid PDF/);
  });

  it("rejects ZIP / Office magic", () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(() => assertPdfMagic(buf)).toThrow(/not a valid PDF/);
  });
});
