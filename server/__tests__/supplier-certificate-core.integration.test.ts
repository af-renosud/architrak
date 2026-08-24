import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  certificats,
  certificatSources,
  contractors,
  devis,
  invoices,
  projects,
  situations,
} from "@shared/schema";
import type { SupplierPaymentReadinessSnapshot } from "@shared/supplier-payment-readiness";
import {
  storage,
  SupplierDirectPaymentSealConflictError,
} from "../storage";
import certificatsRouter from "../routes/certificats";

vi.mock("../auth/middleware", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let projectId: number;
let contractorId: number;
let devisId: number;
let projectArchidocId: string;
let supplierArchidocId: string;
let server: http.Server;
let base: string;
let readinessSpy: ReturnType<typeof vi.spyOn>;
let sequence = 0;

const iban = "FR7630006000011234567890189";
const bic = "AGRIFRPP";

function readinessSnapshot(): SupplierPaymentReadinessSnapshot {
  return {
    provenance: {
      schemaVersion: "archidoc_supplier_payment_readiness_v1",
      sourceSequence: 100,
      capturedAt: "2026-08-20T10:01:00Z",
      contentSha256: "e".repeat(64),
    },
    supplier: {
      id: supplierArchidocId,
      partnerType: "supplier",
      name: "Supplier core test",
      siret: "12345678901234",
      address1: "12 rue du Test",
      address2: null,
      town: "Paris",
      postcode: "75011",
      countryCode: "FR",
      isActive: true,
      primaryContact: {
        id: "contact-test",
        name: "Supplier Contact",
        jobTitle: "Comptabilité",
        email: "supplier@example.test",
        mobile: null,
      },
      banking: {
        accountHolderName: "Supplier core test",
        iban,
        bic,
        bankName: "Test Bank",
        bankingVerificationStatus: "verified",
        bankingVerifiedAt: "2026-08-20T10:00:00Z",
        bankingVerifiedBy: {
          id: "architect-test",
          displayName: "Architect Test",
        },
        bankingVerificationMethod: "manual_rib_review",
        ribDocument: {
          id: "rib-test",
          fileName: "RIB-test.pdf",
          mimeType: "application/pdf",
          sha256: "b".repeat(64),
          downloadPath: `/api/integrations/architrak/v1/suppliers/${supplierArchidocId}/rib/rib-test`,
          updatedAt: "2026-08-20T10:00:00Z",
        },
      },
      updatedAt: "2026-08-20T10:00:00Z",
    },
    assignment: {
      id: "assignment-test",
      projectId: projectArchidocId,
      directPaymentStatus: "eligible",
      validFrom: "2026-01-01",
      validUntil: "2027-01-01",
      reason: null,
      updatedAt: "2026-08-20T10:00:00Z",
    },
  };
}

async function request(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function insertSupplierInvoice(input?: {
  ht?: string;
  tva?: string;
  ttc?: string;
  status?: string;
  datePaid?: string | null;
  extractedIban?: string | null;
}) {
  sequence += 1;
  const [invoice] = await db
    .insert(invoices)
    .values({
      devisId,
      contractorId,
      projectId,
      invoiceNumber: `SUP-${Date.now()}-${sequence}`,
      amountHt: input?.ht ?? "1000.00",
      tvaAmount: input?.tva ?? "200.00",
      amountTtc: input?.ttc ?? "1200.00",
      status: input?.status ?? "approved",
      datePaid: input?.datePaid ?? null,
      extractedIban: input?.extractedIban ?? null,
    })
    .returning();
  return invoice;
}

beforeAll(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  projectArchidocId = `supplier-cert-project-${stamp}`;
  supplierArchidocId = `supplier-cert-partner-${stamp}`;
  const [project] = await db
    .insert(projects)
    .values({
      archidocId: projectArchidocId,
      code: `SUP-CERT-${stamp}`,
      name: "Supplier certificate core integration",
      clientName: "Test Client",
      status: "active",
    })
    .returning();
  projectId = project.id;
  const [supplier] = await db
    .insert(contractors)
    .values({
      archidocId: supplierArchidocId,
      archidocPartnerType: "supplier",
      name: "Supplier certificate core integration",
      iban,
      bic,
      accountHolderName: "Supplier certificate core integration",
      email: "supplier@example.test",
    })
    .returning();
  contractorId = supplier.id;
  const [parentDevis] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: `SUP-DEV-${stamp}`,
      descriptionFr: "Fournitures",
      amountHt: "50000.00",
      amountTtc: "60000.00",
      signOffStage: "client_signed_off",
      status: "confirmed",
    })
    .returning();
  devisId = parentDevis.id;

  readinessSpy = vi.spyOn(
    storage,
    "getSupplierPaymentReadinessSnapshot",
  );
  const app = express();
  app.use(express.json());
  app.use(certificatsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  readinessSpy.mockReset();
  readinessSpy.mockImplementation(async () => readinessSnapshot());
});

afterAll(async () => {
  readinessSpy.mockRestore();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const certificateRows = await db
    .select({ id: certificats.id })
    .from(certificats)
    .where(eq(certificats.projectId, projectId));
  if (certificateRows.length > 0) {
    await db
      .delete(certificatSources)
      .where(
        inArray(
          certificatSources.certificatId,
          certificateRows.map((row) => row.id),
        ),
      );
  }
  await db.delete(certificats).where(eq(certificats.projectId, projectId));
  await db.delete(situations).where(eq(situations.devisId, devisId));
  await db.delete(invoices).where(eq(invoices.projectId, projectId));
  await db.delete(devis).where(eq(devis.id, devisId));
  await db.delete(contractors).where(eq(contractors.id, contractorId));
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("supplier direct-payment certificate core", () => {
  it("fails closed while the ArchiDoc readiness snapshot is not synchronised", async () => {
    const invoice = await insertSupplierInvoice();
    readinessSpy.mockResolvedValue(undefined);

    const response = await request(
      "GET",
      `/api/invoices/${invoice.id}/certificat-preview`,
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SUPPLIER_PAYMENT_NOT_READY");
  });

  it("requires an approved, unpaid, non-situation invoice", async () => {
    const pending = await insertSupplierInvoice({ status: "pending" });
    const pendingResponse = await request(
      "GET",
      `/api/invoices/${pending.id}/certificat-preview`,
    );
    expect(pendingResponse.status).toBe(409);
    expect(pendingResponse.body.code).toBe(
      "SUPPLIER_INVOICE_NOT_APPROVED",
    );

    const paid = await insertSupplierInvoice({
      status: "approved",
      datePaid: "2026-08-23",
    });
    const paidResponse = await request(
      "GET",
      `/api/invoices/${paid.id}/certificat-preview`,
    );
    expect(paidResponse.status).toBe(409);
    expect(paidResponse.body.code).toBe("SUPPLIER_INVOICE_PAID");

    const situationInvoice = await insertSupplierInvoice();
    await db.insert(situations).values({
      devisId,
      invoiceId: situationInvoice.id,
      situationNumber: 1,
      cumulativeHt: "1000.00",
      previousHt: "0.00",
      netHt: "1000.00",
      retenueGarantie: "0.00",
      netToPayHt: "1000.00",
      tvaAmount: "200.00",
      netToPayTtc: "1200.00",
      status: "confirmed",
    });
    const situationResponse = await request(
      "GET",
      `/api/invoices/${situationInvoice.id}/certificat-preview`,
    );
    expect(situationResponse.status).toBe(409);
    expect(situationResponse.body.code).toBe(
      "SUPPLIER_SITUATION_NOT_ALLOWED",
    );
  });

  it("derives exact invoice totals with every contractor-only field zeroed", async () => {
    const invoice = await insertSupplierInvoice({
      ht: "1234.56",
      tva: "246.91",
      ttc: "1481.47",
    });
    const preview = await request(
      "GET",
      `/api/invoices/${invoice.id}/certificat-preview`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.derivation.certificateTrack).toBe(
      "supplier_direct_payment",
    );
    expect(preview.body.deductions).toMatchObject({
      retenueGarantie: "0.00",
      cumulativeProrataDeduction: "0.00",
      periodProrataDeduction: "0.00",
      cumulativeAcompteRecoupment: "0.00",
      periodAcompteRecoupment: "0.00",
      netToPayHt: "1234.56",
      tvaAmount: "246.91",
      netToPayTtc: "1481.47",
      isSolde: false,
      retenueReleased: false,
    });

    const created = await request(
      "POST",
      `/api/invoices/${invoice.id}/create-certificat`,
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      certificateTrack: "supplier_direct_payment",
      totalWorksHt: "1234.56",
      previousPayments: "0.00",
      retenueGarantie: "0.00",
      netToPayHt: "1234.56",
      tvaAmount: "246.91",
      netToPayTtc: "1481.47",
      isSolde: false,
    });
    const sourceRows = await db
      .select()
      .from(certificatSources)
      .where(eq(certificatSources.certificatId, created.body.id));
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0]).toMatchObject({
      invoiceId: invoice.id,
      situationId: null,
    });
  });

  it("accepts compatible grouped TVA and refuses a mixed-rate selection", async () => {
    const compatibleA = await insertSupplierInvoice({
      ht: "500.00",
      tva: "100.00",
      ttc: "600.00",
    });
    const compatibleB = await insertSupplierInvoice({
      ht: "750.00",
      tva: "150.00",
      ttc: "900.00",
    });
    const compatible = await request(
      "POST",
      `/api/projects/${projectId}/certificats/from-invoices/preview`,
      { invoiceIds: [compatibleA.id, compatibleB.id] },
    );
    expect(compatible.status).toBe(200);
    expect(compatible.body.deductions).toMatchObject({
      netToPayHt: "1250.00",
      tvaAmount: "250.00",
      netToPayTtc: "1500.00",
    });

    const mixedA = await insertSupplierInvoice({
      ht: "100.00",
      tva: "10.00",
      ttc: "110.00",
    });
    const mixedB = await insertSupplierInvoice({
      ht: "100.00",
      tva: "20.00",
      ttc: "120.00",
    });
    const mixed = await request(
      "POST",
      `/api/projects/${projectId}/certificats/from-invoices/preview`,
      { invoiceIds: [mixedA.id, mixedB.id] },
    );
    expect(mixed.status).toBe(409);
    expect(mixed.body.code).toBe("TVA_MIXED");
  });

  it("keeps the scoped IBAN-mismatch override gate on supplier evidence", async () => {
    const invoice = await insertSupplierInvoice({
      extractedIban: "DE89370400440532013000",
    });
    const response = await request(
      "POST",
      `/api/invoices/${invoice.id}/create-certificat`,
    );
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("BANKING_MISMATCH");
  });

  it("allows exactly one concurrent claim of a supplier invoice", async () => {
    const invoice = await insertSupplierInvoice();
    const [first, second] = await Promise.all([
      request("POST", `/api/invoices/${invoice.id}/create-certificat`),
      request("POST", `/api/invoices/${invoice.id}/create-certificat`),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const claims = await db
      .select()
      .from(certificatSources)
      .where(eq(certificatSources.invoiceId, invoice.id));
    expect(claims).toHaveLength(1);
  });

  it("reissues with the same supplier track and exact invoice source set", async () => {
    const invoice = await insertSupplierInvoice();
    const created = await request(
      "POST",
      `/api/invoices/${invoice.id}/create-certificat`,
    );
    expect(created.status).toBe(201);
    await db
      .update(certificats)
      .set({
        pdfStorageKey: `tests/${created.body.certificateRef}.pdf`,
        pdfFileName: `${created.body.certificateRef}.pdf`,
        issuedAt: new Date(),
        status: "sent",
      })
      .where(eq(certificats.id, created.body.id));

    const reissued = await request(
      "POST",
      `/api/certificats/${created.body.id}/reissue`,
    );
    expect(reissued.status).toBe(201);
    expect(reissued.body).toMatchObject({
      certificateTrack: "supplier_direct_payment",
      reissuedFromCertificatId: created.body.id,
      totalWorksHt: "1000.00",
      previousPayments: "0.00",
      retenueGarantie: "0.00",
      netToPayHt: "1000.00",
      tvaAmount: "200.00",
      netToPayTtc: "1200.00",
    });
    const replacementSources = await db
      .select()
      .from(certificatSources)
      .where(eq(certificatSources.certificatId, reissued.body.id));
    expect(replacementSources).toHaveLength(1);
    expect(replacementSources[0]).toMatchObject({
      invoiceId: invoice.id,
      situationId: null,
    });
    const [original] = await db
      .select()
      .from(certificats)
      .where(eq(certificats.id, created.body.id));
    expect(original.status).toBe("superseded");
  });

  it("rechecks source status before sending an already sealed supplier certificate", async () => {
    const invoice = await insertSupplierInvoice();
    const created = await request(
      "POST",
      `/api/invoices/${invoice.id}/create-certificat`,
    );
    expect(created.status).toBe(201);
    await db
      .update(certificats)
      .set({
        pdfStorageKey: `tests/${created.body.certificateRef}.pdf`,
        pdfFileName: `${created.body.certificateRef}.pdf`,
        issuedAt: new Date(),
        dateIssued: "2026-08-24",
        status: "ready",
      })
      .where(eq(certificats.id, created.body.id));
    await db
      .update(invoices)
      .set({ datePaid: "2026-08-24" })
      .where(eq(invoices.id, invoice.id));

    const response = await request(
      "POST",
      `/api/projects/${projectId}/certificats/${created.body.id}/send`,
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SUPPLIER_INVOICE_PAID");
  });

  it("refuses the final seal transaction when a supplier invoice changes after derivation", async () => {
    const invoice = await insertSupplierInvoice();
    const created = await request(
      "POST",
      `/api/invoices/${invoice.id}/create-certificat`,
    );
    expect(created.status).toBe(201);
    const guardedReadiness = readinessSnapshot();
    await db
      .update(invoices)
      .set({ amountHt: "999.00" })
      .where(eq(invoices.id, invoice.id));

    await expect(
      storage.sealCertificat(created.body.id, {
        pdfStorageKey: "tests/should-not-seal.pdf",
        pdfFileName: "should-not-seal.pdf",
        issuanceSnapshot: {},
        dateIssued: "2026-08-24",
        sourceRows: [
          {
            certificatId: created.body.id,
            invoiceId: invoice.id,
            situationId: null,
          },
        ],
        expectedVersion: created.body.version,
        projectId,
        contractorId,
        supplierDirectPaymentGuard: {
          readiness: guardedReadiness,
          invoices: [
            {
              invoiceId: invoice.id,
              devisId,
              invoiceNumber: invoice.invoiceNumber,
              amountHt: "1000.00",
              tvaAmount: "200.00",
              amountTtc: "1200.00",
              invoiceExtractedIban: null,
              devisStatus: "confirmed",
              devisAcompteInvoiceId: null,
              devisExtractedIban: null,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(SupplierDirectPaymentSealConflictError);

    const [reloaded] = await db
      .select()
      .from(certificats)
      .where(eq(certificats.id, created.body.id));
    expect(reloaded.pdfStorageKey).toBeNull();
    expect(reloaded.issuanceSnapshot).toBeNull();
  });

  it("refuses the final seal transaction when readiness provenance advances", async () => {
    const invoice = await insertSupplierInvoice();
    const created = await request(
      "POST",
      `/api/invoices/${invoice.id}/create-certificat`,
    );
    expect(created.status).toBe(201);
    const guardedReadiness = readinessSnapshot();
    readinessSpy.mockImplementation(async () => {
      const advanced = readinessSnapshot();
      advanced.provenance.sourceSequence += 1;
      advanced.provenance.contentSha256 = "a".repeat(64);
      return advanced;
    });

    await expect(
      storage.sealCertificat(created.body.id, {
        pdfStorageKey: "tests/should-not-seal-readiness.pdf",
        pdfFileName: "should-not-seal-readiness.pdf",
        issuanceSnapshot: {},
        dateIssued: "2026-08-24",
        sourceRows: [
          {
            certificatId: created.body.id,
            invoiceId: invoice.id,
            situationId: null,
          },
        ],
        expectedVersion: created.body.version,
        projectId,
        contractorId,
        supplierDirectPaymentGuard: {
          readiness: guardedReadiness,
          invoices: [
            {
              invoiceId: invoice.id,
              devisId,
              invoiceNumber: invoice.invoiceNumber,
              amountHt: invoice.amountHt,
              tvaAmount: invoice.tvaAmount,
              amountTtc: invoice.amountTtc,
              invoiceExtractedIban: null,
              devisStatus: "confirmed",
              devisAcompteInvoiceId: null,
              devisExtractedIban: null,
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(SupplierDirectPaymentSealConflictError);

    const [reloaded] = await db
      .select()
      .from(certificats)
      .where(eq(certificats.id, created.body.id));
    expect(reloaded.pdfStorageKey).toBeNull();
    expect(reloaded.issuanceSnapshot).toBeNull();
  });
});