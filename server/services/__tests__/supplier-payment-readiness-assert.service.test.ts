import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../storage", () => ({
  storage: {
    getContractor: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../archidoc/sync-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../archidoc/sync-client")>();
  return {
    ...actual,
    fetchSupplierPaymentCertificateHandoff: vi.fn(),
  };
});

import { storage } from "../../storage";
import {
  ArchidocFetchError,
  fetchSupplierPaymentCertificateHandoff,
} from "../../archidoc/sync-client";
import {
  assertSupplierPaymentReadiness,
  SupplierPaymentReadinessError,
} from "../supplier-payment-readiness.service";

const getContractor = vi.mocked(storage.getContractor);
const getProject = vi.mocked(storage.getProject);
const fetchHandoff = vi.mocked(fetchSupplierPaymentCertificateHandoff);

const partner = {
  id: 10,
  archidocId: "supplier-1",
  archidocPartnerType: "supplier",
  archidocOrphanedAt: null,
};
const project = {
  id: 20,
  archidocId: "project-1",
};

async function expectBlockers(blockers: string[]) {
  await expect(
    assertSupplierPaymentReadiness({
      contractorId: 10,
      projectId: 20,
      issueDate: "2026-08-24",
    }),
  ).rejects.toMatchObject<SupplierPaymentReadinessError>({ blockers });
}

describe("supplier payment readiness canonical preconditions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getContractor.mockResolvedValue(partner as never);
    getProject.mockResolvedValue(project as never);
    fetchHandoff.mockRejectedValue(
      new ArchidocFetchError({
        endpoint: "supplier-payment-certificate-handoff",
        outcome: "error",
        status: null,
        durationMs: 0,
        checkedAt: "2026-08-24T00:00:00.000Z",
        code: "unavailable",
        reason: "Test fixture: ArchiDoc unavailable",
      }),
    );
  });

  it("fails when the canonical partner or project is missing", async () => {
    getContractor.mockResolvedValueOnce(undefined);
    getProject.mockResolvedValueOnce(undefined);
    await expectBlockers(["partner_not_found", "project_not_found"]);
  });

  it("fails on wrong partner type", async () => {
    getContractor.mockResolvedValueOnce({
      ...partner,
      archidocPartnerType: "contractor",
    } as never);
    await expectBlockers(["partner_not_supplier"]);
  });

  it("fails on missing ArchiDoc links", async () => {
    getContractor.mockResolvedValueOnce({
      ...partner,
      archidocId: null,
    } as never);
    getProject.mockResolvedValueOnce({
      ...project,
      archidocId: null,
    } as never);
    await expectBlockers([
      "partner_not_archidoc_linked",
      "project_not_archidoc_linked",
    ]);
  });

  it("fails on an orphaned supplier mirror", async () => {
    getContractor.mockResolvedValueOnce({
      ...partner,
      archidocOrphanedAt: new Date("2026-08-23T00:00:00Z"),
    } as never);
    await expectBlockers(["partner_archidoc_orphaned"]);
  });

  it("fails closed when the on-demand handoff is unavailable", async () => {
    await expectBlockers(["handoff_unavailable"]);
  });
});