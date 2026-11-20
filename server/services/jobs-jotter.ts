import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { jobsJotters } from "@shared/schema";

const fields = {
  content: jobsJotters.content,
  revision: jobsJotters.revision,
  updatedAt: jobsJotters.updatedAt,
};

export async function getJobsJotter(userId: number) {
  const [row] = await db.select(fields).from(jobsJotters).where(eq(jobsJotters.userId, userId));
  return row ?? { content: "", revision: 0, updatedAt: null };
}

/** Serialises first creation and edits; a stale tab cannot erase newer notes. */
export async function saveJobsJotter(userId: number, content: string, revision: number) {
  return db.transaction(async (tx) => {
    await tx.insert(jobsJotters).values({ userId }).onConflictDoNothing();
    const [saved] = await tx.update(jobsJotters).set({
      content, revision: sql`${jobsJotters.revision} + 1`, updatedAt: new Date(),
    }).where(and(eq(jobsJotters.userId, userId), eq(jobsJotters.revision, revision))).returning(fields);
    if (saved) return { saved };
    const [current] = await tx.select(fields).from(jobsJotters).where(eq(jobsJotters.userId, userId));
    // An uncertain network response can be retried without causing a false conflict.
    if (current.content === content) return { saved: current };
    return { current };
  });
}
