import { pool } from "../../db";
import { AsyncLocalStorage } from "node:async_hooks";
import pLimit from "p-limit";

export const INTAKE_WORKER_LOCK = 849;
const checks = new AsyncLocalStorage<() => Promise<void>>();
// Each attempt may hold a job session and a project session. Leave pool
// capacity for routing transactions and ordinary interactive requests.
const workers = pLimit(4);
export async function assertIntakeWorkerAlive() { await checks.getStore()?.(); }

export async function withIntakeWorkerLock<T>(id: number, work: () => Promise<T>, namespace = INTAKE_WORKER_LOCK, wait = false): Promise<T | undefined> {
  if (namespace === INTAKE_WORKER_LOCK) return workers(() => withLock(id, work, namespace, wait));
  return withLock(id, work, namespace, wait);
}
async function withLock<T>(id: number, work: () => Promise<T>, namespace: number, wait: boolean): Promise<T | undefined> {
  const parentCheck = checks.getStore();
  const client = await pool.connect();
  let lost = false;
  let locked = false;
  const error = () => { lost = true; };
  client.on("error", error);
  try {
    if (wait) {
      await client.query("SELECT pg_advisory_lock($1,$2)", [namespace, id]);
      locked = true;
    } else {
      const { rows: [r] } = await client.query("SELECT pg_try_advisory_lock($1,$2) AS locked", [namespace, id]);
      locked = r.locked;
    }
    if (!locked) return;
    return await checks.run(async () => {
      await parentCheck?.();
      if (lost) throw new Error("Intake worker ownership lost");
      await client.query("SELECT 1");
      if (lost) throw new Error("Intake worker ownership lost");
    }, work);
  } finally {
    if (locked && !lost) await client.query("SELECT pg_advisory_unlock($1,$2)", [namespace, id]).catch(() => { lost = true; });
    client.removeListener("error", error);
    client.release(lost);
  }
}
