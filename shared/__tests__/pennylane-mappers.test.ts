import { describe, it, expect } from "vitest";
import type { FeeEntry, Project } from "@shared/schema";
import {
  buildCustomerExternalId,
  buildInvoiceExternalId,
  mapFeeEntryToCustomerInvoice,
  mapProjectToCustomer,
  splitClientName,
  TVA_RATE_DECIMAL,
} from "../../server/services/pennylane/mappers";

function makeProject(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-16T08:00:00Z");
  return {
    id: 42,
    name: "Villa Exemple",
    code: "VEX-2026",
    clientName: "Jean-Pierre Dupont",
    clientAddress: "12 Avenue des Mimosas, 34480 Cabrerolles",
    siteAddress: "Chemin du Vignoble",
    status: "active",
    feePercentage: "10.00",
    feeType: "percentage",
    conceptionFee: null,
    planningFee: null,
    hasMarche: false,
    archidocId: null,
    archidocClients: null,
    lastSyncedAt: null,
    archivedAt: null,
    clientContactName: "Jean-Pierre Dupont",
    clientContactEmail: "jp.dupont@example.fr",
    driveFolderId: null,
    pennylaneCustomerId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("splitClientName", () => {
  it("splits a simple first/last name", () => {
    expect(splitClientName("Jean Dupont")).toEqual({
      firstName: "Jean",
      lastName: "Dupont",
    });
  });

  it("preserves a hyphenated first name", () => {
    expect(splitClientName("Jean-Pierre Dupont")).toEqual({
      firstName: "Jean-Pierre",
      lastName: "Dupont",
    });
  });

  it("strips a leading honorific", () => {
    expect(splitClientName("M. Jean Dupont")).toEqual({
      firstName: "Jean",
      lastName: "Dupont",
    });
  });

  it("strips a 'M. et Mme' honorific", () => {
    expect(splitClientName("M. et Mme Dupont")).toEqual({
      firstName: null,
      lastName: "Dupont",
    });
  });

  it("returns lastName only for a single-token name", () => {
    expect(splitClientName("Dupont")).toEqual({
      firstName: null,
      lastName: "Dupont",
    });
  });
});

describe("external-id builders", () => {
  it("stamps the project id into the customer external id", () => {
    expect(buildCustomerExternalId(7)).toBe("architrak:client:project:7");
  });
  it("stamps the fee-entry id into the invoice external id", () => {
    expect(buildInvoiceExternalId(123)).toBe("architrak:fee_entry:123");
  });
});

describe("mapProjectToCustomer", () => {
  it("produces the full happy-path payload", () => {
    const p = mapProjectToCustomer(makeProject());
    expect(p).toEqual({
      external_id: "architrak:client:project:42",
      customer_type: "individual",
      name: "Jean-Pierre Dupont",
      first_name: "Jean-Pierre",
      last_name: "Dupont",
      emails: ["jp.dupont@example.fr"],
      billing_address: {
        address: "12 Avenue des Mimosas, 34480 Cabrerolles",
        country_alpha2: "FR",
      },
    });
  });

  it("omits emails when the client contact email is null", () => {
    const p = mapProjectToCustomer(makeProject({ clientContactEmail: null }));
    expect(p.emails).toBeUndefined();
  });

  it("omits billing_address when clientAddress is null", () => {
    const p = mapProjectToCustomer(makeProject({ clientAddress: null }));
    expect(p.billing_address).toBeUndefined();
  });

  it("omits first_name when the name does not split cleanly", () => {
    const p = mapProjectToCustomer(makeProject({ clientName: "Dupont" }));
    expect(p.first_name).toBeUndefined();
    expect(p.last_name).toBe("Dupont");
  });
});

describe("mapFeeEntryToCustomerInvoice", () => {
  const fe: Pick<FeeEntry, "id" | "feeAmount"> = {
    id: 99,
    feeAmount: "1234.56",
  };

  it("emits the canonical single-line architect invoice", () => {
    const payload = mapFeeEntryToCustomerInvoice(fe, {
      pennylaneCustomerId: "cust_abc",
      label: "Honoraires d'architecte — Villa Exemple",
      reference: "VEX-2026 / FE#99",
      description: "Devis DEV-2025-001",
      issueDate: new Date("2026-05-16T00:00:00Z"),
      paymentTermsDays: 30,
    });
    expect(payload).toEqual({
      external_id: "architrak:fee_entry:99",
      customer_id: "cust_abc",
      date: "2026-05-16",
      deadline: "2026-06-15",
      currency: "EUR",
      reference: "VEX-2026 / FE#99",
      description: "Devis DEV-2025-001",
      line_items: [
        {
          label: "Honoraires d'architecte — Villa Exemple",
          quantity: 1,
          unit_amount: 1234.56,
          vat_rate: TVA_RATE_DECIMAL,
          currency: "EUR",
        },
      ],
    });
  });

  it("rounds floating-point dust to 2dp", () => {
    const payload = mapFeeEntryToCustomerInvoice(
      { id: 1, feeAmount: "100.005" },
      {
        pennylaneCustomerId: "cust_x",
        label: "Honoraires",
        issueDate: new Date("2026-05-16T00:00:00Z"),
      },
    );
    expect(payload.line_items[0].unit_amount).toBe(100.01);
  });

  it("defaults deadline to issue + 30 days when paymentTermsDays is unset", () => {
    const payload = mapFeeEntryToCustomerInvoice(fe, {
      pennylaneCustomerId: "cust_x",
      label: "Honoraires",
      issueDate: new Date("2026-05-16T00:00:00Z"),
    });
    expect(payload.date).toBe("2026-05-16");
    expect(payload.deadline).toBe("2026-06-15");
  });

  it("omits reference and description when not provided", () => {
    const payload = mapFeeEntryToCustomerInvoice(fe, {
      pennylaneCustomerId: "cust_x",
      label: "Honoraires",
      issueDate: new Date("2026-05-16T00:00:00Z"),
    });
    expect(payload.reference).toBeUndefined();
    expect(payload.description).toBeUndefined();
  });
});
