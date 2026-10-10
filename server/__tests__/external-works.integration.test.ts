import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { eq } from "drizzle-orm";

const isolated = vi.hoisted(() => ({ name: `external_works_test_${Date.now()}_${Math.floor(Math.random() * 100000)}` }));
vi.mock("../db", async () => {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@shared/schema");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${isolated.name},public` });
  return { pool, db: drizzle(pool, { schema }) };
});
import { pool, db } from "../db";
import { externalWorks, externalWorkAudit, projects, users, devis, certificats } from "@shared/schema";
import { mutateExternalWork, externalWorksRegister, listExternalWorks, buildExternalCostOverview } from "../services/external-works.service";
import { externalWorkInput } from "@shared/external-works";
import { externalWorksOverviewHtml } from "../services/external-works-reporting";

const input = { reference: "OLD-01", description: "Completed foundations", amountHt: "100.01", amountTtc: "105.51", confirmedCompleted: true };
const actor = { id: 991, name: "Test architect" };
beforeAll(async () => {
  await pool.query(`CREATE SCHEMA ${isolated.name}`);
  for (const table of ["projects", "users", "devis", "certificats"]) {
    await pool.query(`CREATE TABLE ${isolated.name}.${table} (LIKE public.${table} INCLUDING ALL)`);
  }
  const ddl = fs.readFileSync("migrations/0142_external_works.sql", "utf8");
  for (const statement of ddl.split("--> statement-breakpoint")) await pool.query(statement);
  await pool.query("DROP TRIGGER external_work_audit_immutable ON external_work_audit; ALTER TABLE external_work_audit DROP CONSTRAINT external_work_audit_actor_id_fkey");
  // Repeat DDL to prove recovery safety with existing tables and protections.
  for (const statement of ddl.split("--> statement-breakpoint")) await pool.query(statement);
  const repaired = await pool.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'external_work_audit'::regclass AND conname = 'external_work_audit_actor_id_fkey'");
  expect(repaired.rowCount).toBe(1);
  await db.insert(users).values({ id: actor.id, googleId: "external-test", email: "external-test@local.test" });
  await db.insert(projects).values([
    { id: 991, name: "External test", code: "EXT", clientName: "Test" },
    { id: 992, name: "Other project", code: "OTHER", clientName: "Test" },
    { id: 993, name: "Archived", code: "ARCH", clientName: "Test", archivedAt: new Date() },
  ]);
}, 30000);
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${isolated.name} CASCADE`);
  await pool.end();
});

describe("external register", () => {
  it("validates explicit amounts, dates, completion confirmation and precision", () => {
    for (const change of [{ amountHt: "" }, { amountTtc: "100.001" }, { amountHt: "-1" }, { amountTtc: "1" }, { confirmedCompleted: false }, { completionDate: "2026-02-30" }]) {
      expect(externalWorkInput.safeParse({ ...input, ...change }).success).toBe(false);
    }
    expect(externalWorkInput.parse({ ...input, amountHt: "100", amountTtc: "100" })).toMatchObject({ amountHt: "100.00", amountTtc: "100.00" });
  });
  it("creates, edits, voids and restores with permanent actor-attributed history", async () => {
    const row = await mutateExternalWork(991, null, "create", input, actor);
    const edit = await mutateExternalWork(991, row.id, "edit", { ...input, amountTtc: "110.01", version: row.version }, actor);
    await expect(mutateExternalWork(991, row.id, "edit", { ...input, version: row.version }, actor)).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const voided = await mutateExternalWork(991, row.id, "void", { version: edit.version, reason: "Entered twice" }, actor);
    expect(buildExternalCostOverview(await listExternalWorks(991), 50, 60).totalExternalHt).toBe(0);
    await expect(mutateExternalWork(991, null, "create", { ...input, reference: " old-01 " }, actor)).rejects.toMatchObject({ code: "DUPLICATE_REFERENCE" });
    const restored = await mutateExternalWork(991, row.id, "restore", { version: voided.version }, actor);
    expect(restored.status).toBe("active");
    const register = await externalWorksRegister(991);
    expect(register.history.map(h => h.action)).toEqual(["restore", "void", "edit", "create"]);
    expect(register.history.every(h => h.actorName === actor.name && h.actorId === actor.id)).toBe(true);
    await expect(db.delete(externalWorks).where(eq(externalWorks.id, row.id))).rejects.toThrow();
    await expect(db.delete(externalWorkAudit).where(eq(externalWorkAudit.entryId, row.id))).rejects.toThrow();
    await expect(mutateExternalWork(992, row.id, "void", { version: restored.version, reason: "Wrong project" }, actor)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("requires an explicit acknowledgement of overlapping managed references", async () => {
    await db.insert(devis).values({ id: 991, projectId: 991, contractorId: 1, devisCode: "MANAGED", descriptionFr: "Test", amountHt: "1", amountTtc: "1" });
    const overlap = { ...input, reference: "managed" };
    await expect(mutateExternalWork(991, null, "create", overlap, actor)).rejects.toMatchObject({ code: "MANAGED_OVERLAP" });
    const row = await mutateExternalWork(991, null, "create", { ...overlap, acknowledgeOverlap: true }, actor);
    const { history } = await externalWorksRegister(991);
    expect(history.find(h => h.entryId === row.id)?.after).toMatchObject({ acknowledgedOverlaps: [{ id: 991, reference: "MANAGED" }] });
  });
  it("rejects archived writes and stale concurrent mutations", async () => {
    await expect(mutateExternalWork(993, null, "create", input, actor)).rejects.toMatchObject({ code: "PROJECT_ARCHIVED" });
    const row = await mutateExternalWork(992, null, "create", input, actor);
    const results = await Promise.allSettled([1, 2].map(n => mutateExternalWork(992, row.id, "edit", { ...input, description: `Edit ${n}`, version: row.version }, actor)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });
  it("invalidates in-flight unsealed versions but never changes sealed documents", async () => {
    const base = { projectId: 992, contractorId: 1, totalWorksHt: "100", netToPayHt: "100", netToPayTtc: "100", tvaAmount: "0", version: 1 };
    await db.insert(certificats).values([
      { ...base, id: 991, certificateRef: "C991" },
      { ...base, id: 992, certificateRef: "C992", pdfStorageKey: "sealed.pdf", issuanceSnapshot: { externalWorksOverview: { totalExternalHt: 0 } } },
    ]);
    await mutateExternalWork(992, null, "create", { ...input, reference: "LATER" }, actor);
    const rows = await db.select().from(certificats).where(eq(certificats.projectId, 992));
    expect(rows.find(r => r.id === 991)?.version).toBe(2);
    expect(rows.find(r => r.id === 992)).toMatchObject({ version: 1, pdfStorageKey: "sealed.pdf", issuanceSnapshot: { externalWorksOverview: { totalExternalHt: 0 } } });
  });
  it("totals active historical costs without invented VAT, and escapes report content", async () => {
    const rows = await listExternalWorks(991);
    const result = buildExternalCostOverview(rows, 200, 240);
    expect(result).toMatchObject({ totalExternalHt: 200.02, totalExternalTtc: 215.52, totalCombinedCostHt: 400.02, totalCombinedCostTtc: 455.52 });
    const html = externalWorksOverviewHtml({ ...result, entries: [{ ...result.entries[0], description: "<script>unsafe</script>" }] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("not amounts certified or confirmed paid");
  });
});
