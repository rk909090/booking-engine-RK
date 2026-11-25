import "server-only";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let db: Database | undefined;

/**
 * Lazily creates the connection so builds and pages that never touch the
 * database do not need DATABASE_URL.
 *
 * DATABASE_URL should be Supabase's pooled connection string. `prepare: false`
 * is required by the transaction pooler and harmless elsewhere.
 */
export function getDb(): Database {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  db = drizzle(postgres(url, { prepare: false, max: 5 }), { schema });
  return db;
}
