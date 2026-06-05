import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import type { AddressInfo } from "net";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  projects,
  contractors,
  devis,
  overlapCases,
  accountingStateChanges,
} from "@shared/schema";
import reconciliationRouter from "../routes/reconciliation";

// Task #236 — full anomaly-review lifecycle against the real database.
//
// The "a decision clears the queue + status badge" behaviour is the most
// regression-prone part of the Needs Review surface (Task #233), because a
// human confirm does NOT close the underlying overlap case: detection keeps
// re-detecting the superseded members, so the case stays active/needs_review.
// The read surfaces must instead exclude every humanly-resolved case. This
// test seeds a real `needs_review` case (primary + members + arithmetic proof)
// and drives the HTTP routes end to end for both `confirm` and `dismiss`.

const SUFFIX = `t236-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let server: http.Server;
let baseUrl: string;
let actorUserId: number;
let contractorId: number;
const createdProjectIds: number[] = [];

interface SeededCase {
  projectId: number;
  primaryId: number;
  memberIds: number[];
  caseId: number;
}

async function newDevis(
  projectId: number,
  accountingState: "provisional" | "active" | "superseded",
  amountHt: string,
): Promise<number> {
  const [row] = await db
    .insert(devis)
    .values({
      projectId,
      contractorId,
      devisCode: `D-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
      descriptionFr: "anomaly review fixture",
      amountHt,
      amountTtc: amountHt,
      accountingState,
    })
    .returning({ id: devis.id });
  return row.id;
}

// Seed a fresh project carrying one needs_review overlap case: a provisional
// primary that two active members are suspected of duplicating. Each test owns
// its own project so the audit rows from one decision never leak into another.
async function seedNeedsReviewCase(): Promise<SeededCase> {
  const [project] = await db
    .insert(projects)
    .values({
      name: `Anomaly Review ${SUFFIX}`,
      code: `AR-${SUFFIX}-${Math.random().toString(36).slice(2, 6)}`,
      clientName: "Fixture Client",
    })
    .returning({ id: projects.id });
  createdProjectIds.push(project.id);

  const primaryId = await newDevis(project.id, "provisional", "300.00");
  const member1 = await newDevis(project.id, "active", "100.00");
  const member2 = await newDevis(project.id, "active", "100.00");
  const memberIds = [member1, member2];

  const [oc] = await db
    .insert(overlapCases)
    .values({
      projectId: project.id,
      caseKey: `key-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
      relationshipType: "duplicate",
      primaryDevisId: primaryId,
      memberDevisIds: memberIds,
      detectionSource: "ai",
      confidence: "0.800",
      verdict: "needs_review",
      arithmeticProof: {
        primaryCents: 30000,
        memberCents: [10000, 10000],
        sumCents: 20000,
        deltaCents: 10000,
        reconciles: false,
      },
      citations: [
        {
          devisId: primaryId,
          devisCode: null,
          lineNumber: 1,
          description: "primary scope",
          totalHt: "300.00",
        },
      ],
      reasoning: "Members may duplicate the primary scope.",
      status: "active",
    })
    .returning({ id: overlapCases.id });

  return { projectId: project.id, primaryId, memberIds, caseId: oc.id };
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      googleId: `google-${SUFFIX}`,
      email: `architect-${SUFFIX}@renosud.com`,
      firstName: "Test",
      lastName: "Architect",
    })
    .returning({ id: users.id });
  actorUserId = u.id;

  const [c] = await db
    .insert(contractors)
    .values({ name: `Contractor ${SUFFIX}` })
    .returning({ id: contractors.id });
  contractorId = c.id;

  const app = express();
  app.use(express.json());
  // The resolve route is requireAuth-gated and audits req.session.userId.
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: number } }).session = { userId: actorUserId };
    next();
  });
  app.use(reconciliationRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  // Cascades wipe devis, overlap_cases and accounting_state_changes.
  if (createdProjectIds.length > 0) {
    await db.delete(projects).where(inArray(projects.id, createdProjectIds));
  }
  if (contractorId) await db.delete(contractors).where(eq(contractors.id, contractorId));
  if (actorUserId) await db.delete(users).where(eq(users.id, actorUserId));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function resolveCase(
  caseId: number,
  decision: "confirm" | "dismiss",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/overlap-cases/${caseId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  return { status: res.status, body: await res.json() };
}

describe("anomaly-review flow (integration, real DB)", () => {
  it("confirm: case moves to resolvedCases, queue empties, status flips to resolved", async () => {
    const seeded = await seedNeedsReviewCase();

    // Initially the case is open and surfaces in the review queue.
    const before = await getJson(`/api/projects/${seeded.projectId}/overlap-cases`);
    expect(before.status).toBe(200);
    expect(before.body.openCases.map((c: { id: number }) => c.id)).toContain(seeded.caseId);
    expect(before.body.resolvedCases).toHaveLength(0);
    const openCard = before.body.openCases.find((c: { id: number }) => c.id === seeded.caseId);
    expect(openCard.impactEuros).toBe(200);

    const statusBefore = await getJson(`/api/projects/${seeded.projectId}/accounting-status`);
    expect(statusBefore.status).toBe(200);
    expect(statusBefore.body.status).toBe("needs_review");
    expect(statusBefore.body.needsReviewCount).toBe(1);
    expect(statusBefore.body.eurosAtRisk).toBe(200);

    // The architect confirms the overlap.
    const resolved = await resolveCase(seeded.caseId, "confirm");
    expect(resolved.status).toBe(200);
    expect(resolved.body.decision).toBe("confirm");
    expect(resolved.body.superseded).toEqual(expect.arrayContaining(seeded.memberIds));

    // The queue is now empty and the case shows up under resolvedCases.
    const after = await getJson(`/api/projects/${seeded.projectId}/overlap-cases`);
    expect(after.body.openCases).toHaveLength(0);
    expect(after.body.resolvedCases.map((c: { id: number }) => c.id)).toContain(seeded.caseId);
    const resolvedCard = after.body.resolvedCases.find(
      (c: { id: number }) => c.id === seeded.caseId,
    );
    expect(resolvedCard.decision).toBe("confirm");

    // The status badge flips off needs_review.
    const statusAfter = await getJson(`/api/projects/${seeded.projectId}/accounting-status`);
    expect(statusAfter.body.status).toBe("resolved");
    expect(statusAfter.body.needsReviewCount).toBe(0);
    expect(statusAfter.body.eurosAtRisk).toBe(0);

    // The case row itself is still active/needs_review — detection re-detects
    // the superseded members, so it is only the human-decision audit that
    // pulls it out of the queue.
    const dbCase = await db.select().from(overlapCases).where(eq(overlapCases.id, seeded.caseId));
    expect(dbCase[0].status).toBe("active");
    expect(dbCase[0].verdict).toBe("needs_review");
  });

  it("dismiss: case moves to resolvedCases, queue empties, status flips to resolved", async () => {
    const seeded = await seedNeedsReviewCase();

    const before = await getJson(`/api/projects/${seeded.projectId}/overlap-cases`);
    expect(before.body.openCases.map((c: { id: number }) => c.id)).toContain(seeded.caseId);

    const statusBefore = await getJson(`/api/projects/${seeded.projectId}/accounting-status`);
    expect(statusBefore.body.status).toBe("needs_review");
    expect(statusBefore.body.needsReviewCount).toBe(1);

    const resolved = await resolveCase(seeded.caseId, "dismiss");
    expect(resolved.status).toBe(200);
    expect(resolved.body.decision).toBe("dismiss");

    const after = await getJson(`/api/projects/${seeded.projectId}/overlap-cases`);
    expect(after.body.openCases).toHaveLength(0);
    const resolvedCard = after.body.resolvedCases.find(
      (c: { id: number }) => c.id === seeded.caseId,
    );
    expect(resolvedCard).toBeDefined();
    expect(resolvedCard.decision).toBe("dismiss");

    const statusAfter = await getJson(`/api/projects/${seeded.projectId}/accounting-status`);
    expect(statusAfter.body.status).toBe("resolved");
    expect(statusAfter.body.needsReviewCount).toBe(0);

    // A human_dismiss audit row was written against the case.
    const dismissRows = await db
      .select()
      .from(accountingStateChanges)
      .where(eq(accountingStateChanges.overlapCaseId, seeded.caseId));
    expect(dismissRows.some((r) => r.reason === "human_dismiss")).toBe(true);
  });
});
