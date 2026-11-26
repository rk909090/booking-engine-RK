/**
 * Sign-in accounts for the demo buttons on the sign-in page (Settings ›
 * Sign-in & security › Demo sign-in): one per role, linked to demo staff.
 * Branch manager, front office and housekeeping are the Ubud demo staff
 * from npm run demo:seed; a demo director is added here. The accounts have
 * no password, so the demo buttons are their only way in, and only while a
 * director has demo sign-in switched on. npm run demo:clear removes them.
 *
 * Usage: npm run demo:logins (demo:seed runs it too). Safe to run again.
 */
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { DEMO_LOGIN_EMAILS } from "../../src/domain/app-settings";

const DIRECTOR_NAME = "Ayu Pramesti";

export async function ensureDemoLogins(sql: postgres.Sql): Promise<{ created: string[]; missing: string[] }> {
  const created: string[] = [];
  const missing: string[] = [];
  await sql.begin(async (tx) => {
    const [director] = await tx`SELECT id FROM staff_members WHERE email = ${DEMO_LOGIN_EMAILS.director}`;
    if (!director) {
      await tx`INSERT INTO staff_members (id, email, full_name, role, is_active) VALUES (${randomUUID()}, ${DEMO_LOGIN_EMAILS.director}, ${DIRECTOR_NAME}, 'director', true)`;
      created.push("staff:director");
    }
    for (const [role, email] of Object.entries(DEMO_LOGIN_EMAILS)) {
      const [staff] = await tx`SELECT id::text, full_name, role::text, auth_user_id FROM staff_members WHERE email = ${email}`;
      if (!staff || staff.role !== role) {
        missing.push(email);
        continue;
      }
      if (staff.auth_user_id) continue;
      const [existing] = await tx`SELECT id FROM auth_users WHERE email = ${email}`;
      const authId: string = existing?.id ?? randomBytes(16).toString("hex");
      if (!existing) {
        // No auth_accounts row: the account has no password.
        await tx`INSERT INTO auth_users (id, name, email, email_verified, two_factor_enabled) VALUES (${authId}, ${staff.full_name}, ${email}, true, false)`;
      }
      await tx`UPDATE staff_members SET auth_user_id = ${authId}, updated_at = now() WHERE id = ${staff.id}`;
      created.push(`login:${role}`);
    }
  });
  return { created, missing };
}

if (process.argv[1]?.split("\\").join("/").endsWith("scripts/demo/logins.ts")) {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set DIRECT_URL or DATABASE_URL (see .env.example).");
  const sql = postgres(url, { prepare: false, max: 1 });
  ensureDemoLogins(sql)
    .then(({ created, missing }) => {
      console.log(created.length ? `Created: ${created.join(", ")}` : "Demo sign-in accounts already set up.");
      if (missing.length) console.log(`Missing demo staff (run npm run demo:seed first): ${missing.join(", ")}`);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => sql.end());
}
