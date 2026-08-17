import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import express from "express";
import type { AddressInfo } from "net";

/**
 * Task #566 — PV de réception endpoints and final-payment gate, route level.
 *
 * Pins:
 * - PV fields are stripped from the generic marché create/PATCH bodies (no
 *   client can self-approve a PV through a plain PATCH).
 * - receptionDate is locked by an approved PV (409 PV_APPROVED_DATE_LOCKED).
 * - POST /pv records a draft (doc OR attestation required) and 409s once
 *   approved; POST /pv/approve requires a draft with a date and stamps the
 *   approver; approve is idempotent.
 * - Certificat create maps the resolver's PvReceptionRequiredError to
 *   422 PV_RECEPTION_REQUIRED; an override reason reaches the resolver and
 *   is stamped with who/when.
 * - Send route refuses a sealed solde certificat without an approved PV or
 *   recorded override.
 */

vi.mock("../../storage", async () => {
  const { createStorageMock } = await import("./helpers/mock-storage");
  return {
    storage: createStorageMock([
      "getMarche",
      "getMarchesByProject",
      "createMarche",
      "updateMarche",
      "updateMarcheWithPvDateGuard",
      "recordMarchePvDraft",
      "approveMarchePv",
      "getCertificat",
      "createCertificat",
      "getNextCertificateRef",
      "getProject",
      "getContractor",
      "getCertificatSentComms",
    ]),
  };
});

vi.mock("../../communications/certificat-generator", () => ({
  generateCertificatPdf: vi.fn(),
  BankingDetailsMissingError: class extends Error {},
  BankingMismatchError: class extends Error {},
}));
vi.mock("../../communications/email-sender", () => ({ sendCertificat: vi.fn() }));
vi.mock("../../services/certificat-deductions.service", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../services/certificat-deductions.service");
  return {
    SoldeConflictError: actual.SoldeConflictError,
    ReleaseRequiresSoldeError: actual.ReleaseRequiresSoldeError,
    resolveCertificatDeductions: vi.fn(),
  };
});
vi.mock("../../storage/object-storage", () => ({
  getDocumentBuffer: vi.fn().mockResolvedValue(Buffer.from("%PDF")),
}));

import marchesRouter from "../marches";
import certificatsRouter from "../certificats";
import { storage } from "../../storage";
import { resolveCertificatDeductions } from "../../services/certificat-deductions.service";
import { PvReceptionRequiredError } from "../../services/pv-reception.service";

const mocked = storage as unknown as Record<string, ReturnType<typeof vi.fn>>;
const resolver = resolveCertificatDeductions as unknown as ReturnType<typeof vi.fn>;

const baseMarche = {
  id: 5,
  projectId: 1,
  contractorId: 2,
  retenueGarantiePercent: "5.00",
  hasBankGuarantee: false,
  isProrataManager: false,
  receptionDate: null as string | null,
  pvReceptionStatus: null as string | null,
  pvDocumentStorageKey: null,
  pvDocumentFileName: null,
  pvAttestationNote: null,
  pvApprovedByUserId: null,
  pvApprovedAt: null,
};

let baseUrl: string;
let server: import("http").Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: 42 };
    next();
  });
  app.use(marchesRouter);
  app.use(certificatsRouter);
  // Mirror the app's global handler: Zod validation errors surface as 400.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err && typeof err === "object" && "issues" in (err as Record<string, unknown>)) {
      return res.status(400).json({ message: "Validation failed", issues: (err as { issues: unknown }).issues });
    }
    res.status(500).json({ message: String(err) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  vi.clearAllMocks();
});

const json = (method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("marché generic routes — PV fields are server-managed", () => {
  it("strips PV fields from a generic PATCH", async () => {
    mocked.getMarche.mockResolvedValue({ ...baseMarche });
    mocked.updateMarcheWithPvDateGuard.mockResolvedValue({ ...baseMarche });
    const res = await json("PATCH", "/api/marches/5", {
      retenueGarantiePercent: "3.00",
      pvReceptionStatus: "approved",
      pvApprovedByUserId: 99,
    });
    expect(res.status).toBe(200);
    const patch = mocked.updateMarcheWithPvDateGuard.mock.calls[0][1];
    expect(patch).not.toHaveProperty("pvReceptionStatus");
    expect(patch).not.toHaveProperty("pvApprovedByUserId");
    expect(patch.retenueGarantiePercent).toBe("3.00");
  });

  it("locks receptionDate once the PV is approved", async () => {
    mocked.getMarche.mockResolvedValue({
      ...baseMarche,
      pvReceptionStatus: "approved",
      receptionDate: "2026-01-15",
    });
    // Race-safe lock: the guard predicate rejects the write → zero-row update.
    mocked.updateMarcheWithPvDateGuard.mockResolvedValue(undefined);
    const res = await json("PATCH", "/api/marches/5", { receptionDate: "2026-03-01" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PV_APPROVED_DATE_LOCKED");
  });
});

describe("POST /api/marches/:id/pv — draft PV", () => {
  it("records a draft with an attestation note and writes receptionDate in the same update", async () => {
    mocked.getMarche.mockResolvedValue({ ...baseMarche });
    mocked.recordMarchePvDraft.mockImplementation(async (_id, patch) => ({
      ...baseMarche,
      ...patch,
      pvReceptionStatus: "draft",
    }));
    const res = await json("POST", "/api/marches/5/pv", {
      receptionDate: "2026-02-10",
      attestationNote: "PV papier signé le 10/02, classé au dossier chantier.",
    });
    expect(res.status).toBe(200);
    const patch = mocked.recordMarchePvDraft.mock.calls[0][1];
    expect(patch.receptionDate).toBe("2026-02-10");
    expect(patch.pvAttestationNote).toContain("PV papier");
  });

  it("requires a document or an attestation", async () => {
    mocked.getMarche.mockResolvedValue({ ...baseMarche });
    const res = await json("POST", "/api/marches/5/pv", { receptionDate: "2026-02-10" });
    expect(res.status).toBe(400);
  });

  it("refuses once approved", async () => {
    mocked.getMarche.mockResolvedValue({ ...baseMarche, pvReceptionStatus: "approved", receptionDate: "2026-01-01" });
    // Approved PV → the conditional draft write matches zero rows.
    mocked.recordMarchePvDraft.mockResolvedValue(undefined);
    const res = await json("POST", "/api/marches/5/pv", {
      receptionDate: "2026-02-10",
      attestationNote: "tentative",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PV_ALREADY_APPROVED");
  });
});

describe("POST /api/marches/:id/pv/approve", () => {
  it("409s when no PV was recorded", async () => {
    mocked.approveMarchePv.mockResolvedValue(undefined);
    mocked.getMarche.mockResolvedValue({ ...baseMarche });
    const res = await json("POST", "/api/marches/5/pv/approve");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PV_NOT_RECORDED");
  });

  it("409s on a draft missing its reception date", async () => {
    mocked.approveMarchePv.mockResolvedValue(undefined);
    mocked.getMarche.mockResolvedValue({ ...baseMarche, pvReceptionStatus: "draft", receptionDate: null });
    const res = await json("POST", "/api/marches/5/pv/approve");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PV_RECEPTION_DATE_MISSING");
  });

  it("approves a dated draft, stamping the session user", async () => {
    mocked.approveMarchePv.mockImplementation(async (_id, approvedByUserId) => ({
      ...baseMarche,
      pvReceptionStatus: "approved",
      receptionDate: "2026-02-10",
      pvApprovedByUserId: approvedByUserId,
      pvApprovedAt: new Date(),
    }));
    const res = await json("POST", "/api/marches/5/pv/approve");
    expect(res.status).toBe(200);
    expect(mocked.approveMarchePv.mock.calls[0][1]).toBe(42);
    const body = await res.json();
    expect(body.pvReceptionStatus).toBe("approved");
    expect(body.pvApprovedByUserId).toBe(42);
  });

  it("is idempotent on an already-approved PV", async () => {
    // Conditional transition matches zero rows; the fresh read shows approved.
    mocked.approveMarchePv.mockResolvedValue(undefined);
    mocked.getMarche.mockResolvedValue({ ...baseMarche, pvReceptionStatus: "approved", receptionDate: "2026-02-10" });
    const res = await json("POST", "/api/marches/5/pv/approve");
    expect(res.status).toBe(200);
    expect((await res.json()).pvReceptionStatus).toBe("approved");
  });
});

const soldeDeductions = {
  retenueGarantie: "0.00",
  cumulativeProrataDeduction: "0.00",
  periodProrataDeduction: "0.00",
  cumulativeAcompteRecoupment: "0.00",
  periodAcompteRecoupment: "0.00",
  tvaRatePercent: "20.00",
  tvaAutoliquidation: false,
  tvaRateSource: "default",
  netToPayHt: "100.00",
  tvaAmount: "20.00",
  netToPayTtc: "120.00",
  isSolde: true,
  retenueReleased: false,
  retenueReleaseAmount: null,
};

describe("certificat create — PV gate mapping and override audit", () => {
  it("maps PvReceptionRequiredError to 422 PV_RECEPTION_REQUIRED", async () => {
    resolver.mockRejectedValue(new PvReceptionRequiredError(5, "draft"));
    const res = await json("POST", "/api/projects/1/certificats", {
      contractorId: 2,
      totalWorksHt: "100.00",
      previousPayments: "0.00",
      isSolde: true,
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("PV_RECEPTION_REQUIRED");
    expect(body.marcheId).toBe(5);
    expect(body.pvStatus).toBe("draft");
    expect(mocked.createCertificat).not.toHaveBeenCalled();
  });

  it("passes the override to the resolver and stamps the audit trio", async () => {
    resolver.mockResolvedValue({ ...soldeDeductions });
    mocked.getNextCertificateRef.mockResolvedValue("C1");
    mocked.createCertificat.mockImplementation(async (row) => ({ id: 9, ...row }));
    const res = await json("POST", "/api/projects/1/certificats", {
      contractorId: 2,
      totalWorksHt: "100.00",
      previousPayments: "0.00",
      isSolde: true,
      pvOverrideReason: "Chantier réceptionné en 2019, avant la mise en place des PV dans l'outil.",
    });
    expect(res.status).toBe(201);
    expect(resolver.mock.calls[0][0].pvOverride).toBe(true);
    const row = mocked.createCertificat.mock.calls[0][0];
    expect(row.pvOverrideReason).toContain("2019");
    expect(row.pvOverrideByUserId).toBe(42);
    expect(row.pvOverrideAt).toBeInstanceOf(Date);
  });

  it("never records the override trio on a non-solde certificat", async () => {
    resolver.mockResolvedValue({ ...soldeDeductions, isSolde: false });
    mocked.getNextCertificateRef.mockResolvedValue("C1");
    mocked.createCertificat.mockImplementation(async (row) => ({ id: 9, ...row }));
    const res = await json("POST", "/api/projects/1/certificats", {
      contractorId: 2,
      totalWorksHt: "100.00",
      previousPayments: "0.00",
      pvOverrideReason: "ne devrait pas être enregistré",
    });
    expect(res.status).toBe(201);
    const row = mocked.createCertificat.mock.calls[0][0];
    expect(row.pvOverrideReason).toBeNull();
    expect(row.pvOverrideByUserId).toBeNull();
  });
});

describe("certificat send — last-exit PV gate", () => {
  const sealedSolde = {
    id: 7,
    projectId: 1,
    contractorId: 2,
    certificateRef: "C3",
    status: "issued",
    isSolde: true,
    pvOverrideReason: null,
    pdfStorageKey: "projects/1/C3.pdf",
    pdfFileName: "C3.pdf",
  };

  it("refuses a sealed solde without an approved PV", async () => {
    mocked.getProject.mockResolvedValue({ id: 1, status: "active" });
    mocked.getCertificat.mockResolvedValue(sealedSolde);
    mocked.getMarchesByProject.mockResolvedValue([{ ...baseMarche, pvReceptionStatus: "draft" }]);
    const res = await json("POST", "/api/projects/1/certificats/7/send", {});
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("PV_RECEPTION_REQUIRED");
  });

  it("lets a recorded override through the send gate", async () => {
    mocked.getProject.mockResolvedValue({ id: 1, status: "active" });
    mocked.getCertificat.mockResolvedValue({ ...sealedSolde, pvOverrideReason: "dérogation" });
    mocked.getMarchesByProject.mockResolvedValue([]);
    const res = await json("POST", "/api/projects/1/certificats/7/send", {});
    // gate passed — whatever happens next is beyond this pin
    expect(res.status).not.toBe(422);
    expect(mocked.getMarchesByProject).not.toHaveBeenCalled();
  });
});
