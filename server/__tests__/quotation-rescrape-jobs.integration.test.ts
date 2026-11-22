import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool } from "../db";
import { contractors, devis, projects } from "@shared/schema";
const mock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../services/devis-rescrape.service", () => ({ rescrapeDevis: mock.run }));
import { runQuotationRescrape, quotationRescrapeStatus, isQuotationRescrapeRunning } from "../services/quotation-rescrape-jobs";
import { withIntakeWorkerLock } from "../services/intake/worker-lock";

let projectId: number, contractorId: number, id: number;
beforeAll(async () => {
  const key = `queue-${Date.now()}`;
  [projectId] = (await db.insert(projects).values({code:key,name:key,clientName:"Test"}).returning()).map(x=>x.id);
  [contractorId] = (await db.insert(contractors).values({name:key}).returning()).map(x=>x.id);
  [id] = (await db.insert(devis).values({projectId,contractorId,devisCode:key,descriptionFr:"Queue fixture",
    amountHt:"0",amountTtc:"0",status:"draft"}).returning()).map(x=>x.id);
});
afterAll(async () => {
  await db.delete(devis).where(eq(devis.id,id));
  await db.delete(contractors).where(eq(contractors.id,contractorId));
  await db.delete(projects).where(eq(projects.id,projectId));
});
async function reset(state="pending") {
  mock.run.mockReset();
  await pool.query(`INSERT INTO quotation_rescrape_jobs(devis_id,state) VALUES($1,$2)
    ON CONFLICT(devis_id) DO UPDATE SET state=$2,owner='old-worker',attempts=0`,[id,state]);
}
describe("persistent extraction jobs", () => {
  it("excludes duplicate workers and leaves the original untouched", async () => {
    await reset();
    let release!: () => void, began!: () => void;
    const gate = new Promise<void>(r=>{release=r;});
    const started = new Promise<void>(r=>{began=r;});
    mock.run.mockImplementation(async (_id, _approval, check) => {
      await check(); began(); await gate;
      return {success:true,status:202,data:{prepared:true}};
    });
    const running = runQuotationRescrape(id);
    await started;
    expect(await isQuotationRescrapeRunning(id)).toBe(true);
    await runQuotationRescrape(id);
    expect(mock.run).toHaveBeenCalledTimes(1);
    release(); await running;
    expect((await quotationRescrapeStatus(id)).state).toBe("prepared");
    const [original] = await db.select().from(devis).where(eq(devis.id,id));
    expect(original.amountHt).toBe("0.00");
    expect(original.status).toBe("draft");
  });
  it("recovers an interrupted run and persists failures without provider error text", async () => {
    await reset("running");
    mock.run.mockRejectedValue(new Error("private provider diagnostic"));
    await runQuotationRescrape(id);
    expect(mock.run).toHaveBeenCalledTimes(1);
    const status = await quotationRescrapeStatus(id);
    expect(status.state).toBe("failed");
    expect(status.message).not.toContain("private");
  });
  it("fences a worker whose persisted owner changed", async () => {
    await reset();
    mock.run.mockImplementation(async (_id, _approval, check, writeEvent) => {
      await pool.query("UPDATE quotation_rescrape_jobs SET owner='replacement' WHERE devis_id=$1",[id]);
      await expect(writeEvent(id, "attempt", "prepared", { test: true })).rejects.toThrow("ownership lost");
      await check();
    });
    await runQuotationRescrape(id);
    expect((await quotationRescrapeStatus(id)).state).toBe("running");
  });
  it("does not admit two intake workers for the same job", async () => {
    let release!: () => void, began!: () => void;
    const gate = new Promise<void>(r=>{release=r;});
    const started = new Promise<void>(r=>{began=r;});
    const worker = withIntakeWorkerLock(id, async ()=>{began();await gate;});
    await started;
    const work = vi.fn();
    await withIntakeWorkerLock(id,work);
    expect(work).not.toHaveBeenCalled();
    release(); await worker;
  });
});
