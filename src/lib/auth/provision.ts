import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import type { Role } from "@/lib/authz/permissions";
import type { Auth } from "./config";
import { collectLinks } from "./outbox";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export type StaffInvite = {
  email: string;
  fullName: string;
  role: Role;
  /** Property slugs; required for every role except director. */
  propertySlugs: string[];
  /** The staff member inviting (the users page); the log says "system" for the script. */
  actorId?: string;
};

export type InviteResult = { staffId: string; authUserId: string; setupUrl: string; created: boolean; emailed: boolean };

/**
 * Creates (or refreshes) a staff member and returns a one-time link where
 * they choose their own password. The account starts with a random password
 * nobody knows, so it cannot be used until the link is followed.
 */
export async function inviteStaff(auth: Auth, db: AnyDb, input: StaffInvite): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid email: ${input.email}`);
  if (!fullName) throw new Error("Full name is required");
  if (input.role !== "director" && input.propertySlugs.length === 0) {
    throw new Error(`Role ${input.role} needs at least one property`);
  }

  const properties = input.propertySlugs.length
    ? await db
        .select({ id: schema.properties.id, slug: schema.properties.slug })
        .from(schema.properties)
        .where(inArray(schema.properties.slug, input.propertySlugs))
    : [];
  const missing = input.propertySlugs.filter((s) => !properties.some((p) => p.slug === s));
  if (missing.length) throw new Error(`Unknown property: ${missing.join(", ")}`);

  const ctx = await auth.$context;
  const existing = await ctx.internalAdapter.findUserByEmail(email);
  let authUserId: string;
  let created = false;
  if (existing) {
    authUserId = existing.user.id;
  } else {
    const user = await ctx.internalAdapter.createUser(
      { email, name: fullName, emailVerified: true },
      { method: "admin" },
    );
    await ctx.internalAdapter.createAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await ctx.password.hash(randomBytes(32).toString("base64url")),
    });
    authUserId = user.id;
    created = true;
  }

  const staffId = await db.transaction(async (tx) => {
    const [staff] = await tx
      .insert(schema.staffMembers)
      .values({ email, fullName, role: input.role, authUserId, isActive: true })
      .onConflictDoUpdate({
        target: schema.staffMembers.email,
        set: { fullName, role: input.role, authUserId, isActive: true, updatedAt: new Date() },
      })
      .returning({ id: schema.staffMembers.id });
    await tx.delete(schema.staffPropertyAccess).where(eq(schema.staffPropertyAccess.staffId, staff.id));
    if (properties.length) {
      await tx
        .insert(schema.staffPropertyAccess)
        .values(properties.map((p) => ({ staffId: staff.id, propertyId: p.id })));
    }
    await tx.insert(schema.auditEvents).values({
      actorType: input.actorId ? "staff" : "system",
      actorId: input.actorId ?? null,
      entityType: "staff_member",
      entityId: staff.id,
      action: created ? "staff.invited" : "staff.reinvited",
      after: { email, role: input.role, properties: input.propertySlugs },
    });
    return staff.id;
  });

  const link = await issueSetupLink(auth, email);
  return { staffId, authUserId, setupUrl: link.url, created, emailed: link.emailed };
}

/**
 * A new one-time link (24 hours) where the person sets their password; the
 * previous password stops working once it is used. Emailed when email is set
 * up; always returned so it can be handed over privately.
 */
export async function issueSetupLink(auth: Auth, email: string): Promise<{ url: string; emailed: boolean }> {
  const { links } = await collectLinks(() => auth.api.requestPasswordReset({ body: { email } }));
  const link = links.find((l) => l.email === email);
  if (!link) throw new Error("No password link was produced");
  return { url: link.url, emailed: link.emailed === true };
}
