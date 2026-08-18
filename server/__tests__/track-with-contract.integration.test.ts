import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  archidocProjects,
  projects,
  designContracts,
  designContractMilestones,
  fees,
} from "@shared/schema";
import { storage } from "../storage";
import {
  uploadStagingDesignContract,
  getDocumentBuffer,
  deleteDocument,
} from "../storage/object-storage";
import archidocRouter from "../routes/archidoc";
import { errorHandler } from "../middleware/error-handler";

// Task #250 — prove a REAL signed design contract survives project creation
// end-to-end via POST /api/archidoc/track-with-contract/:id.
//
// The existing browser spec (new-project-contract-optional.spec.ts) network-
// mocks BOTH /api/design-contracts/preview and the track-with-contract
// endpoint, so it locks in the FE branching but never exercises the real
// server path: staging-key ownership, object-storage moveDocument, the atomic
// contract + milestones + fee-mirror insert, and the rollback-on-failure
// guarantee. This test drives the real route against the real database and
// real object storage. The only thing we skip is the AI extractor: instead of
// hitting Gemini through /preview, we seed a real staged PDF blob directly and
// hand its staging key to the confirm-carrying track endpoint.

const skipModule = !process.env.DATABASE_URL;

const SUFFIX = `t250-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const USER_ID = 990250;

let server: http.Server;
let baseUrl: string;
const seededArchidocIds: string[] = [];
const stagedKeys: string[] = [];
const finalKeys: string[] = [];

async function seedArchidocProject(archidocId: string, projectName: string) {
  await db
    .insert(archidocProjects)
    .values({
      archidocId,
      projectName,
      code: `E2E-${archidocId.slice(-6)}`,
      clientName: "E2E Client",
      address: "1 Test Street",
      status: "active",
      clients: [],
      lotContractors: [],
      customLots: [],
      isDeleted: false,
    });
  seededArchidocIds.push(archidocId);
}

async function seedStagingBlob(): Promise<string> {
  const key = await uploadStagingDesignContract(
    USER_ID,
    `${SUFFIX}_contract.pdf`,
    Buffer.from("%PDF-1.4 e2e real staged design contract"),
    "application/pdf",
  );
  stagedKeys.push(key);
  return key;
}

// Canonical valid confirm payload: totalTtc 1200, milestones summing to 1200
// TTC and 100%, plus conception/planning HT that drive the fee mirror.
function contractPayload(stagingKey: string) {
  return {
    trackOptions: { feeType: "percentage", feePercentage: "12.5", hasMarche: false },
    designContract: {
      stagingKey,
      originalFilename: "contract.pdf",
      totalHt: 1000,
      totalTva: 200,
      totalTtc: 1200,
      tvaRate: 20,
      conceptionAmountHt: 700,
      planningAmountHt: 300,
      contractDate: "2026-01-15",
      contractReference: `REF-${SUFFIX}`,
      clientName: "E2E Client",
      architectName: "E2E Architect",
      projectAddress: "1 Test Street",
      milestones: [
        {
          sequence: 1,
          labelFr: "Acompte",
          labelEn: "Deposit",
          percentage: 50,
          amountTtc: 600,
          triggerEvent: "manual" as const,
        },
        {
          sequence: 2,
          labelFr: "Solde",
          labelEn: "Balance",
          percentage: 50,
          amountTtc: 600,
          triggerEvent: "manual" as const,
        },
      ],
    },
  };
}

beforeAll(async () => {
  if (skipModule) return;
  const app = express();
  app.use(express.json());
  // Inject a session userId so the route's ownership + upload attribution
  // logic runs exactly as it would behind the real /api perimeter.
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId?: number } }).session = { userId: USER_ID };
    next();
  });
  app.use(archidocRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  if (skipModule) {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    return;
  }
  for (const id of seededArchidocIds) {
    await db.delete(projects).where(eq(projects.archidocId, id));
    await db.delete(archidocProjects).where(eq(archidocProjects.archidocId, id));
  }
  for (const key of [...stagedKeys, ...finalKeys]) {
    try { await deleteDocument(key); } catch { /* best effort */ }
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe.skipIf(skipModule)(
  "track-with-contract — real signed contract survives project creation (integration)",
  () => {
    // Real HTTP + object-storage round-trips: allow well over the 5s
    // default so a loaded machine doesn't flake this suite.
    it("persists the contract row, its milestones and the project fee mirror, and moves the staged PDF", { timeout: 60_000 }, async () => {
      const archidocId = `${SUFFIX}-happy`;
      await seedArchidocProject(archidocId, `E2E With-Contract ${SUFFIX}`);
      const stagingKey = await seedStagingBlob();

      const res = await fetch(
        `${baseUrl}/api/archidoc/track-with-contract/${encodeURIComponent(archidocId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(contractPayload(stagingKey)),
        },
      );
      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as { projectId: number; contractId: number };
      const projectId = bodyJson.projectId;
      expect(projectId).toBeGreaterThan(0);
      expect(bodyJson.contractId).toBeGreaterThan(0);

      // The project really landed in the DB.
      const [projectRow] = await db.select().from(projects).where(eq(projects.id, projectId));
      expect(projectRow, "project should be created").toBeTruthy();
      expect(projectRow.archidocId).toBe(archidocId);

      // Design contract row persists for the created project.
      const [contractRow] = await db
        .select()
        .from(designContracts)
        .where(eq(designContracts.projectId, projectId));
      expect(contractRow, "design contract row should persist").toBeTruthy();
      expect(contractRow.id).toBe(bodyJson.contractId);
      expect(Number(contractRow.totalTtc)).toBeCloseTo(1200, 2);
      expect(Number(contractRow.conceptionAmountHt)).toBeCloseTo(700, 2);
      expect(Number(contractRow.planningAmountHt)).toBeCloseTo(300, 2);
      expect(contractRow.uploadedByUserId).toBe(USER_ID);
      expect(contractRow.contractReference).toBe(`REF-${SUFFIX}`);

      // The staged PDF was moved to its final location: the persisted key is
      // NOT the staging key, the final blob is readable, and the staging blob
      // is gone.
      expect(contractRow.storageKey).not.toBe(stagingKey);
      finalKeys.push(contractRow.storageKey);
      const movedBuf = await getDocumentBuffer(contractRow.storageKey);
      expect(movedBuf.length).toBeGreaterThan(0);
      await expect(getDocumentBuffer(stagingKey)).rejects.toThrow();

      // Milestones persist.
      const milestoneRows = await db
        .select()
        .from(designContractMilestones)
        .where(eq(designContractMilestones.contractId, contractRow.id));
      expect(milestoneRows).toHaveLength(2);
      const sequences = milestoneRows.map((m) => m.sequence).sort();
      expect(sequences).toEqual([1, 2]);
      const totalMilestoneTtc = milestoneRows.reduce((a, m) => a + Number(m.amountTtc), 0);
      expect(totalMilestoneTtc).toBeCloseTo(1200, 2);

      // Project fee mirror (conception/planning columns on projects) persists.
      expect(Number(projectRow.conceptionFee)).toBeCloseTo(700, 2);
      expect(Number(projectRow.planningFee)).toBeCloseTo(300, 2);

      // Fee rows mirror the conception + planning HT amounts.
      const feeRows = await db.select().from(fees).where(eq(fees.projectId, projectId));
      const byType = new Map(feeRows.map((f) => [f.feeType, f]));
      expect(Number(byType.get("conception")?.feeAmountHt)).toBeCloseTo(700, 2);
      expect(Number(byType.get("planning")?.feeAmountHt)).toBeCloseTo(300, 2);
    });

    it("rejects a staging key that does not belong to the session (403, no project created)", async () => {
      const archidocId = `${SUFFIX}-badkey`;
      await seedArchidocProject(archidocId, `E2E Bad-Key ${SUFFIX}`);
      const foreignKey = "/bucket/private/design-contracts/staging/u1/999_contract.pdf";

      const res = await fetch(
        `${baseUrl}/api/archidoc/track-with-contract/${encodeURIComponent(archidocId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(contractPayload(foreignKey)),
        },
      );
      expect(res.status).toBe(403);
      // No project was created for this archidoc id.
      const rows = await db.select().from(projects).where(eq(projects.archidocId, archidocId));
      expect(rows).toHaveLength(0);
    });

    it("rolls back the just-created project when the contract insert fails (no orphan project)", async () => {
      const archidocId = `${SUFFIX}-rollback`;
      await seedArchidocProject(archidocId, `E2E Rollback ${SUFFIX}`);
      const stagingKey = await seedStagingBlob();

      // Force the atomic insert (step 4) to blow up AFTER trackProject has
      // created the project row and the staged PDF has been moved. The route's
      // catch block must hard-delete the just-created project.
      const spy = vi
        .spyOn(storage, "replaceDesignContractForProject")
        .mockRejectedValueOnce(new Error("simulated contract insert failure"));

      const res = await fetch(
        `${baseUrl}/api/archidoc/track-with-contract/${encodeURIComponent(archidocId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(contractPayload(stagingKey)),
        },
      );
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);

      // The project created by trackProject must have been rolled back: no
      // project row, and (by cascade) no design_contracts row survive.
      const projectRows = await db
        .select()
        .from(projects)
        .where(eq(projects.archidocId, archidocId));
      expect(projectRows, "project must be hard-deleted on rollback").toHaveLength(0);

      const orphanContracts = await db
        .select()
        .from(designContracts)
        .where(eq(designContracts.contractReference, `REF-${SUFFIX}`));
      // The only contract carrying this reference is from the happy-path test,
      // which lives under a DIFFERENT project. Assert none reference the
      // rolled-back (now non-existent) project by checking there is no
      // contract whose project no longer exists.
      for (const c of orphanContracts) {
        const [p] = await db.select().from(projects).where(eq(projects.id, c.projectId));
        expect(p, "no design contract may point at a deleted project").toBeTruthy();
      }
    });
  },
);
