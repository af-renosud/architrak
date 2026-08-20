import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { contractors, devis, marches, projects, users } from "@shared/schema";
import {
  closeDevisWithApprovedPv,
  DevisClosureError,
} from "../services/devis-closure.service";

const stamp = Date.now();
let userId: number;
let contractorId: number;
let projectId: number;
let otherProjectId: number;
let approvedMarcheId: number;
let draftMarcheId: number;
let mismatchedMarcheId: number;
let raceMarcheId: number;
let closeableDevisId: number;
let missingMarcheDevisId: number;
let draftPvDevisId: number;
let mismatchedMarcheDevisId: number;
let unsignedDevisId: number;
let supersededDevisId: number;
let raceDevisId: number;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `devis-closure-${stamp}@renosud.com`,
      googleId: `devis-closure-${stamp}`,
    })
    .returning();
  userId = user.id;

  const [contractor] = await db
    .insert(contractors)
    .values({ name: `Closure contractor ${stamp}` })
    .returning();
  contractorId = contractor.id;

  const createdProjects = await db
    .insert(projects)
    .values([
      {
        name: `Closure project ${stamp}`,
        code: `CLOSE-${stamp}`,
        clientName: "Closure client",
        hasMarche: true,
      },
      {
        name: `Other closure project ${stamp}`,
        code: `CLOSE-OTHER-${stamp}`,
        clientName: "Other closure client",
        hasMarche: true,
      },
    ])
    .returning();
  projectId = createdProjects[0].id;
  otherProjectId = createdProjects[1].id;

  const createdMarches = await db
    .insert(marches)
    .values([
      {
        projectId,
        contractorId,
        totalHt: "1000.00",
        totalTtc: "1200.00",
        pvReceptionStatus: "approved",
        receptionDate: "2026-08-19",
        pvAttestationNote: "PV papier signé",
        pvApprovedByUserId: userId,
        pvApprovedAt: new Date(),
      },
      {
        projectId,
        contractorId,
        totalHt: "1000.00",
        totalTtc: "1200.00",
        pvReceptionStatus: "draft",
        receptionDate: "2026-08-19",
        pvAttestationNote: "Brouillon",
      },
      {
        projectId: otherProjectId,
        contractorId,
        totalHt: "1000.00",
        totalTtc: "1200.00",
        pvReceptionStatus: "approved",
        receptionDate: "2026-08-19",
        pvAttestationNote: "Autre projet",
        pvApprovedByUserId: userId,
        pvApprovedAt: new Date(),
      },
      {
        projectId,
        contractorId,
        totalHt: "1000.00",
        totalTtc: "1200.00",
        pvReceptionStatus: "approved",
        receptionDate: "2026-08-19",
        pvAttestationNote: "PV utilisé pour le test de course",
        pvApprovedByUserId: userId,
        pvApprovedAt: new Date(),
      },
    ])
    .returning();
  approvedMarcheId = createdMarches[0].id;
  draftMarcheId = createdMarches[1].id;
  mismatchedMarcheId = createdMarches[2].id;
  raceMarcheId = createdMarches[3].id;

  const base = {
    projectId,
    contractorId,
    descriptionFr: "Travaux test clôture",
    amountHt: "1000.00",
    amountTtc: "1200.00",
    status: "confirmed",
    accountingState: "active",
    signOffStage: "client_signed_off",
  };
  const createdDevis = await db
    .insert(devis)
    .values([
      { ...base, devisCode: `CLOSE-${stamp}-1`, marcheId: approvedMarcheId },
      { ...base, devisCode: `CLOSE-${stamp}-2`, marcheId: null },
      { ...base, devisCode: `CLOSE-${stamp}-3`, marcheId: draftMarcheId },
      { ...base, devisCode: `CLOSE-${stamp}-4`, marcheId: mismatchedMarcheId },
      {
        ...base,
        devisCode: `CLOSE-${stamp}-5`,
        marcheId: approvedMarcheId,
        signOffStage: "sent_to_client",
      },
      {
        ...base,
        devisCode: `CLOSE-${stamp}-6`,
        marcheId: approvedMarcheId,
        accountingState: "superseded",
      },
      { ...base, devisCode: `CLOSE-${stamp}-7`, marcheId: raceMarcheId },
    ])
    .returning();
  [
    closeableDevisId,
    missingMarcheDevisId,
    draftPvDevisId,
    mismatchedMarcheDevisId,
    unsignedDevisId,
    supersededDevisId,
    raceDevisId,
  ] = createdDevis.map((row) => row.id);
});

afterAll(async () => {
  if (projectId && otherProjectId) {
    await db.delete(projects).where(inArray(projects.id, [projectId, otherProjectId]));
  }
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
});

async function expectClosureError(
  devisId: number,
  code: DevisClosureError["code"],
): Promise<void> {
  try {
    await closeDevisWithApprovedPv(devisId, userId);
    throw new Error("Expected closure to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(DevisClosureError);
    expect((error as DevisClosureError).code).toBe(code);
  }
}

describe("PV-gated devis closure", () => {
  it("refuses closure without an explicit marché link", async () => {
    await expectClosureError(missingMarcheDevisId, "DEVIS_MARCHE_REQUIRED");
  });

  it("refuses a draft PV on the explicitly linked marché", async () => {
    await expectClosureError(draftPvDevisId, "PV_RECEPTION_REQUIRED");
  });

  it("refuses a linked marché from another project", async () => {
    await expectClosureError(mismatchedMarcheDevisId, "DEVIS_MARCHE_MISMATCH");
  });

  it("refuses unsigned and superseded devis", async () => {
    await expectClosureError(unsignedDevisId, "DEVIS_CLOSURE_NOT_SIGNED");
    await expectClosureError(supersededDevisId, "DEVIS_CLOSURE_NOT_ACTIVE");
  });

  it("closes exactly once under concurrent requests and preserves the audit", async () => {
    const [first, second] = await Promise.all([
      closeDevisWithApprovedPv(closeableDevisId, userId),
      closeDevisWithApprovedPv(closeableDevisId, userId),
    ]);

    expect([first.alreadyClosed, second.alreadyClosed].sort()).toEqual([false, true]);
    expect(first.devis.id).toBe(closeableDevisId);
    expect(second.devis.id).toBe(closeableDevisId);

    const [stored] = await db.select().from(devis).where(eq(devis.id, closeableDevisId));
    expect(stored.closureState).toBe("closed");
    expect(stored.closedAt).toBeInstanceOf(Date);
    expect(stored.closedByUserId).toBe(userId);
    expect(stored.closureMarcheId).toBe(approvedMarcheId);
    expect(stored.closureProjectId).toBe(projectId);
    expect(stored.closureContractorId).toBe(contractorId);
    expect(stored.closureReceptionDate).toBe("2026-08-19");
  });

  it("waits for a concurrent marché edit and rejects the now-mismatched relationship", async () => {
    let signalMarcheLocked!: () => void;
    let releaseMarcheEdit!: () => void;
    const marcheLocked = new Promise<void>((resolve) => {
      signalMarcheLocked = resolve;
    });
    const mayCommitEdit = new Promise<void>((resolve) => {
      releaseMarcheEdit = resolve;
    });

    const editPromise = db.transaction(async (tx) => {
      await tx
        .select()
        .from(marches)
        .where(eq(marches.id, raceMarcheId))
        .for("update");
      signalMarcheLocked();
      await mayCommitEdit;
      await tx
        .update(marches)
        .set({ projectId: otherProjectId })
        .where(eq(marches.id, raceMarcheId));
    });

    await marcheLocked;
    const closePromise = closeDevisWithApprovedPv(raceDevisId, userId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseMarcheEdit();
    await editPromise;

    await expect(closePromise).rejects.toMatchObject({
      code: "DEVIS_MARCHE_MISMATCH",
    });
    const [stored] = await db.select().from(devis).where(eq(devis.id, raceDevisId));
    expect(stored.closureState).toBe("open");
    expect(stored.closedAt).toBeNull();
  });

  it("retains the closure snapshot if the live devis link is corrected later", async () => {
    await db
      .update(devis)
      .set({ marcheId: draftMarcheId })
      .where(eq(devis.id, closeableDevisId));

    const [stored] = await db.select().from(devis).where(eq(devis.id, closeableDevisId));
    expect(stored.marcheId).toBe(draftMarcheId);
    expect(stored.closureMarcheId).toBe(approvedMarcheId);
    expect(stored.closureProjectId).toBe(projectId);
    expect(stored.closureContractorId).toBe(contractorId);
    expect(stored.closureReceptionDate).toBe("2026-08-19");
  });
});