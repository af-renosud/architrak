import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { env } from "./env";

const { Pool } = pg;

export const pool = new Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
