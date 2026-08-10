import { describe, it, expect } from "vitest";
import { encryptShareUrl, decryptShareUrl } from "../services/share-url-crypto";

describe("share-url-crypto (Task #407)", () => {
  it("round-trips a share URL", () => {
    const url = "http://localhost:5000/p/client/project/abc123DEF456";
    const blob = encryptShareUrl(url);
    expect(blob).not.toContain(url);
    expect(blob.split(".")).toHaveLength(3);
    expect(decryptShareUrl(blob)).toBe(url);
  });

  it("produces distinct ciphertexts per call (fresh IV)", () => {
    const url = "http://localhost:5000/p/client/project/token";
    expect(encryptShareUrl(url)).not.toBe(encryptShareUrl(url));
  });

  it("returns null on malformed blobs, never throws", () => {
    expect(decryptShareUrl("")).toBeNull();
    expect(decryptShareUrl("not-a-blob")).toBeNull();
    expect(decryptShareUrl("a.b.c")).toBeNull();
    expect(decryptShareUrl("a.b")).toBeNull();
  });

  it("returns null when the blob is tampered with (auth failure)", () => {
    const blob = encryptShareUrl("http://localhost:5000/p/client/project/tok");
    const parts = blob.split(".");
    const flipped = parts[2].startsWith("A") ? "B" + parts[2].slice(1) : "A" + parts[2].slice(1);
    expect(decryptShareUrl(`${parts[0]}.${parts[1]}.${flipped}`)).toBeNull();
  });
});
