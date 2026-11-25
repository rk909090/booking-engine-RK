/**
 * Applies the fictional sample content (descriptions, amenities, peak season)
 * to the sample properties. Idempotent. Usage: npm run db:sample-content
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { applySampleContent } from "../src/db/sample-content";

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL (see .env.example).");
  const client = postgres(url, { prepare: false, max: 1 });
  try {
    await applySampleContent(drizzle(client, { schema }));
    console.log("Sample content applied.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
