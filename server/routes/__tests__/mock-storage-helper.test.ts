import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStorageMock } from "./helpers/mock-storage";

/**
 * Pins the drift-guard contract of the shared storage mock helper:
 * when a route under test gains a NEW storage call that the test file
 * has not declared, the failure must be a clear error naming the
 * missing method — not a TypeError ("storage.foo is not a function")
 * that surfaces as a misleading generic 400.
 */
describe("createStorageMock helper", () => {
  it("returns a configurable vi.fn for declared methods", async () => {
    const storage = createStorageMock(["getDevis"]);
    storage.getDevis.mockResolvedValue({ id: 7 });
    await expect(storage.getDevis(7)).resolves.toEqual({ id: 7 });
    expect(storage.getDevis).toHaveBeenCalledWith(7);
  });

  it("returns the SAME mock instance on repeated property access", () => {
    const storage = createStorageMock(["getDevis"]);
    expect(storage.getDevis).toBe(storage.getDevis);
    expect(storage.updateDevis).toBe(storage.updateDevis);
  });

  it("throws a clear error naming any UNDECLARED method that gets called", () => {
    const storage = createStorageMock(["getDevis"]);
    // Accessing is fine (routes may reference methods without calling them)…
    expect(typeof storage.revokeDevisCheckTokensForDevis).toBe("function");
    // …but calling must fail loudly with the method name.
    expect(() => storage.revokeDevisCheckTokensForDevis(1)).toThrowError(
      /Unmocked storage method "revokeDevisCheckTokensForDevis"/,
    );
  });

  it("keeps the drift guard through vi.clearAllMocks()", () => {
    const storage = createStorageMock(["getDevis"]);
    storage.getDevis.mockReturnValue("configured");
    expect(() => storage.updateDevis(1, {})).toThrowError(
      /Unmocked storage method "updateDevis"/,
    );
    vi.clearAllMocks();
    // clearAllMocks clears call history but not implementations: the
    // guard on undeclared methods must survive the usual beforeEach reset.
    expect(() => storage.updateDevis(1, {})).toThrowError(
      /Unmocked storage method "updateDevis"/,
    );
    expect(storage.getDevis()).toBe("configured");
  });

  it("is not mistaken for a thenable when awaited", async () => {
    const storage = createStorageMock([]);
    const resolved = await Promise.resolve(storage);
    expect(resolved).toBe(storage);
  });
});

describe("createStorageMock beforeEach interplay", () => {
  const storage = createStorageMock(["getDevis"]);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records calls per test after clearAllMocks", () => {
    storage.getDevis(1);
    expect(storage.getDevis).toHaveBeenCalledTimes(1);
  });

  it("does not leak call history between tests", () => {
    expect(storage.getDevis).not.toHaveBeenCalled();
  });
});
