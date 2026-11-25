/**
 * Creates or re-invites a staff member and prints a one-time link where they
 * set their own password. The link is a credential: share it only with that
 * person, over a private channel. It expires after 24 hours.
 *
 * Usage:
 *   npm run staff:invite -- --email made@example.com --name "Made Wirawan" \
 *     --role branch_manager --property ubud [--property canggu] \
 *     [--base-url https://be.attarahospitality.com]
 *
 * Roles: director (no --property needed), branch_manager, front_office, housekeeping.
 */
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { createAuth } from "../src/lib/auth/config";
import { inviteStaff } from "../src/lib/auth/provision";
import { roles, type Role } from "../src/lib/authz/permissions";

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string" },
      property: { type: "string", multiple: true, default: [] },
      "base-url": { type: "string" },
    },
  });

  if (!values.email || !values.name || !values.role) {
    throw new Error("Required: --email, --name, --role (see the comment at the top of scripts/staff-invite.ts).");
  }
  if (!(roles as readonly string[]).includes(values.role)) {
    throw new Error(`--role must be one of: ${roles.join(", ")}`);
  }

  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = values["base-url"] ?? process.env.BETTER_AUTH_URL;
  if (!url || !secret || !baseURL) {
    throw new Error("Set DIRECT_URL (or DATABASE_URL), BETTER_AUTH_SECRET and BETTER_AUTH_URL in .env.local.");
  }

  const client = postgres(url, { prepare: false, max: 1 });
  try {
    const db = drizzle(client, { schema });
    const auth = createAuth(db, { baseURL, secret });
    const result = await inviteStaff(auth, db, {
      email: values.email,
      fullName: values.name,
      role: values.role as Role,
      propertySlugs: values.property ?? [],
    });
    console.log(result.created ? "Staff member created." : "Existing staff member updated.");
    console.log("\nOne-time password link (valid 24 hours, share privately):\n");
    console.log(result.setupUrl);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
