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
 * DATABASE_URL must be Supabase's SESSION pooler (port 5432). The transaction
 * pooler (6543) left some queries hanging under Next.js. `prepare: false`
 * keeps it working with any pooler.
 */
export function getDb(): Database {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  if (url.includes(".pooler.supabase.com:6543/")) {
    console.warn("[db] DATABASE_URL uses Supabase's transaction pooler (6543); use the session pooler (5432). See .env.example.");
  }
  db = drizzle(postgres(url, { prepare: false, max: 5 }), { schema });
  return db;
}
