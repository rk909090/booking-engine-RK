/**
 * Verifies the database connection and schema without changing anything.
 * Usage: npm run db:check   (reads DATABASE_URL and DIRECT_URL from .env.local)
 */
import postgres from "postgres";

async function check(name: string, url: string | undefined) {
  if (!url || url.includes("PASSWORD_DB_ANDA")) {
    console.log(`${name}: not set (replace PASSWORD_DB_ANDA in .env.local)`);
    return false;
  }
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
  try {
    const [row] = await sql`
      select current_setting('server_version') as version,
             (select count(*)::int from units) as units,
             (select count(*)::int from drizzle.__drizzle_migrations) as migrations,
             exists(select 1 from pg_constraint where conname = 'reservations_no_overlap') as guard`;
    console.log(
      `${name}: OK (Postgres ${row.version}, ${row.units} units, ${row.migrations} migrations, overlap guard ${row.guard ? "present" : "MISSING"})`,
    );
    return row.guard === true;
  } catch (error) {
    console.log(`${name}: FAILED - ${(error as Error).message}`);
    return false;
  } finally {
    await sql.end();
  }
}

async function main() {
  const results = [
    await check("DATABASE_URL", process.env.DATABASE_URL),
    await check("DIRECT_URL", process.env.DIRECT_URL),
  ];
  process.exit(results.every(Boolean) ? 0 : 1);
}

main();
