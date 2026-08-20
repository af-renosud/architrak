import { describe, expect, it } from "vitest";
import {
  isEligibleSupplier,
  mapSupplierToContractorData,
} from "../archidoc/sync-service";

describe("ArchiDoc supplier mapping", () => {
  it("preserves the stable partner id and supplier classification", () => {
    const mapped = mapSupplierToContractorData({
      id: "supplier-stable-id",
      name: "Planning Materials",
      contactName: "Supplier Contact",
      email: "supplier@example.test",
      phone: "+33 1 00 00 00 00",
      website: "https://supplier.example.test",
      updatedAt: "2026-08-20T10:00:00.000Z",
    });

    expect(mapped).toMatchObject({
      id: "supplier-stable-id",
      name: "Planning Materials",
      partnerType: "supplier",
      officePhone: "+33 1 00 00 00 00",
      website: "https://supplier.example.test",
      updatedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(mapped.contacts).toEqual([
      {
        name: "Supplier Contact",
        email: "supplier@example.test",
        mobile: "+33 1 00 00 00 00",
        isPrimary: true,
      },
    ]);
    expect(mapped.siret).toBeUndefined();
  });

  it("does not invent contact details when the supplier feed has none", () => {
    const mapped = mapSupplierToContractorData({
      id: "supplier-minimal",
      name: "Minimal Supplier",
    });

    expect(mapped.partnerType).toBe("supplier");
    expect(mapped.contacts).toEqual([]);
  });

  it("accepts the current feed without an activity flag and excludes explicit inactive suppliers", () => {
    expect(isEligibleSupplier({ id: "current", name: "Current Supplier" })).toBe(true);
    expect(isEligibleSupplier({ id: "active", name: "Active Supplier", isActive: true })).toBe(true);
    expect(isEligibleSupplier({ id: "inactive", name: "Inactive Supplier", isActive: false })).toBe(false);
  });

  it("keeps compatibility with legacy supplier contact field names", () => {
    const mapped = mapSupplierToContractorData({
      id: "legacy-supplier",
      name: "Legacy Supplier",
      contact: "Legacy Contact",
      contactEmail: "legacy@example.test",
      contactPhone: "+33 4 00 00 00 00",
      notes: "Legacy supplier note",
    });

    expect(mapped.officePhone).toBe("+33 4 00 00 00 00");
    expect(mapped.specialConditions).toBe("Legacy supplier note");
    expect(mapped.contacts?.[0]).toMatchObject({
      name: "Legacy Contact",
      email: "legacy@example.test",
      mobile: "+33 4 00 00 00 00",
    });
  });
});