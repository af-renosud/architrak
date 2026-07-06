import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { env } from "./env";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  // Neon (serverless Postgres) can take several seconds to wake a
  // suspended compute or re-establish a dropped connection. A 5s acquire
  // budget produced a storm of "Connection terminated due to connection
  // timeout" errors in production and wedged background jobs mid-write.
  // 15s comfortably covers a cold start; keepAlive stops idle NAT/proxy
  // teardown from silently killing pooled sockets between ticks.
  connectionTimeoutMillis: 15000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err);
});

export const db = drizzle(pool, { schema });
