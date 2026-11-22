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
  it("bounds automatic retries and requires an explicit retry after exhaustion", async () => {
    await reset();
    mock.run.mockResolvedValue({ success: false, status: 503, data: {} });
    await runQuotationRescrape(id);
    expect((await quotationRescrapeStatus(id)).state).toBe("pending");
    await runQuotationRescrape(id);
    expect((await quotationRescrapeStatus(id)).state).toBe("pending");
    await runQuotationRescrape(id);
    expect((await quotationRescrapeStatus(id)).state).toBe("failed");
    await runQuotationRescrape(id);
    expect(mock.run).toHaveBeenCalledTimes(3);
  });
  it("terminates a hung attempt and refuses its late result", async () => {
    await reset();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let lateCheck!: () => Promise<void>;
    mock.run.mockImplementationOnce(async (_id, _approval, check) => {
      lateCheck = check;
      await gate;
      await check();
      return { success: true, status: 202, data: { prepared: true } };
    });
    const original = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
      original(fn, ms === 10 * 60_000 ? 30 : ms, ...args)) as typeof setTimeout);
    try {
      await runQuotationRescrape(id);
      expect((await quotationRescrapeStatus(id)).state).toBe("failed");
      await expect(lateCheck()).rejects.toThrow("ownership lost");
    } finally { release(); timer.mockRestore(); }
  });
  it("persists compatible chunks across interrupted attempts and fences stale checkpoint writers", async () => {
    await reset();
    mock.run.mockImplementationOnce(async (_id, _approval, _check, _event, checkpoint) => {
      await checkpoint.save("identity:0", { documentType: "quotation", amountHt: 10 }, 1, 2);
      throw new Error("interrupted");
    });
    await runQuotationRescrape(id);
    await reset("running");
    mock.run.mockImplementationOnce(async (_id, _approval, _check, _event, checkpoint) => {
      expect(await checkpoint.load("identity:0")).toMatchObject({ amountHt: 10 });
      expect(await checkpoint.load("different-source:0")).toBeNull();
      await pool.query("UPDATE quotation_rescrape_jobs SET owner='other' WHERE devis_id=$1", [id]);
      await expect(checkpoint.save("identity:1", { documentType: "quotation" }, 2, 2)).rejects.toThrow();
      return { success: true, status: 202, data: { prepared: true } };
    });
    await runQuotationRescrape(id);
    expect((await quotationRescrapeStatus(id)).state).toBe("running");
  });
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
