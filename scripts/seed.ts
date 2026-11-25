/**
 * Seeds the sample portfolio into the database in DIRECT_URL (or DATABASE_URL).
 * Usage: npm run db:seed   (refuses to run if properties already exist)
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { seedSampleData } from "../src/db/seed-data";
import { applySampleContent } from "../src/db/sample-content";

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL (see .env.example).");

  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });
  try {
    const existing = await db.select({ id: schema.properties.id }).from(schema.properties).limit(1);
    if (existing.length > 0) {
      console.log("Properties already exist; seed skipped.");
      return;
    }
    await seedSampleData(db);
    await applySampleContent(db);
    console.log("Sample data seeded.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
