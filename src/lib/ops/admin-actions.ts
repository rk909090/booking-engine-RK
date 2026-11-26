"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { resetRolePermissions, resetStaffTwoFactor, saveRolePermissions, setStaffActive, updateStaffMember } from "@/domain/staff-admin";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { inviteStaff, issueSetupLink } from "@/lib/auth/provision";
import { getAuth } from "@/lib/auth/server";
import { can, roles, type Role } from "@/lib/authz/permissions";
import { staffEmailTaken } from "./users";

/*
 * Users and roles (directors only, re-checked here on every call). Results
 * come back as ?done= / ?error= on the page, except the two that return a
 * one-time password link: that link is a credential, so it is only returned
 * to the form that asked for it and never placed in a URL.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function langOf(form: FormData): Locale {
  const raw = field(form, "lang");
  return hasLocale(raw) ? raw : "id";
}

function backTo(url: string): never {
  refresh();
  redirect(url);
}

async function director(lang: Locale, action: "users.manage" | "roles.manage") {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, action).allowed) return null;
  return staff;
}

// ------------------------------------------------------------------ roles

export async function saveRolesAction(form: FormData) {
  const lang = langOf(form);
  const staff = await director(lang, "roles.manage");
  if (!staff) backTo(`/${lang}/ops/roles?error=role`);
  const granted = form
    .getAll("perm")
    .filter((v): v is string => typeof v === "string")
    .map((v) => {
      const [role, action] = v.split("|");
      return { role, action };
    });
  const result = await saveRolePermissions(getDb(), { granted, actor: { type: "staff", id: staff.staffId } });
  backTo(`/${lang}/ops/roles?${result.changed ? `saved=${result.changed}` : "nochange=1"}`);
}

export async function resetRolesAction(form: FormData) {
  const lang = langOf(form);
  const staff = await director(lang, "roles.manage");
  if (!staff) backTo(`/${lang}/ops/roles?error=role`);
  if (field(form, "confirm") !== "yes") backTo(`/${lang}/ops/roles?error=confirm#reset`);
  await resetRolePermissions(getDb(), { actor: { type: "staff", id: staff.staffId } });
  backTo(`/${lang}/ops/roles?reset=1`);
}

// ------------------------------------------------------------------ users

export async function updateUserAction(form: FormData) {
  const lang = langOf(form);
  const staffId = field(form, "staffId");
  const back = (q: string): never => backTo(`/${lang}/ops/users/${UUID.test(staffId) ? staffId : ""}?${q}`);
  const staff = await director(lang, "users.manage");
  if (!staff) return back("error=role");
  if (!UUID.test(staffId)) back("error=not_found");
  const propertyIds = form.getAll("propertyId").filter((v): v is string => typeof v === "string" && UUID.test(v));
  const result = await updateStaffMember(getDb(), { staffId, fullName: field(form, "fullName"), role: field(form, "role"), propertyIds, actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=saved" : `error=${result.error}`);
}

export async function setUserActiveAction(form: FormData) {
  const lang = langOf(form);
  const staffId = field(form, "staffId");
  const back = (q: string): never => backTo(`/${lang}/ops/users/${UUID.test(staffId) ? staffId : ""}?${q}`);
  const staff = await director(lang, "users.manage");
  if (!staff) return back("error=role");
  const active = field(form, "active") === "true";
  if (!active && field(form, "confirm") !== "yes") back("error=confirm");
  const result = await setStaffActive(getDb(), { staffId, active, actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? `done=${active ? "reactivated" : "deactivated"}` : `error=${result.error}`);
}

export async function resetUserTwoFactorAction(form: FormData) {
  const lang = langOf(form);
  const staffId = field(form, "staffId");
  const back = (q: string): never => backTo(`/${lang}/ops/users/${UUID.test(staffId) ? staffId : ""}?${q}`);
  const staff = await director(lang, "users.manage");
  if (!staff) return back("error=role");
  if (field(form, "confirm") !== "yes") back("error=confirm");
  const result = await resetStaffTwoFactor(getDb(), { staffId, actor: { type: "staff", id: staff.staffId } });
  back(result.ok ? "done=twoFactor" : `error=${result.error === "self" ? "self" : "not_found"}`);
}

export type LinkState = { ok: true; url: string; emailed: boolean; name: string; email: string; staffId: string } | { ok: false; error: string } | null;

/** A new one-time password link, shown once to the director who asked for it. */
export async function issueLinkAction(_prev: LinkState, form: FormData): Promise<LinkState> {
  const lang = langOf(form);
  const staff = await director(lang, "users.manage");
  if (!staff) return { ok: false, error: "role" };
  const staffId = field(form, "staffId");
  if (!UUID.test(staffId)) return { ok: false, error: "not_found" };
  const [member] = await getDb().select().from(schema.staffMembers).where(eq(schema.staffMembers.id, staffId));
  if (!member || !member.isActive || !member.authUserId) return { ok: false, error: "not_found" };
  const link = await issueSetupLink(getAuth(), member.email);
  await getDb().insert(schema.auditEvents).values({ actorType: "staff", actorId: staff.staffId, entityType: "staff_member", entityId: member.id, action: "staff.link_issued", after: { emailed: link.emailed }, occurredAt: new Date() });
  return { ok: true, url: link.url, emailed: link.emailed, name: member.fullName, email: member.email, staffId: member.id };
}

/** Invites a new staff member and returns their one-time link once. */
export async function inviteUserAction(_prev: LinkState, form: FormData): Promise<LinkState> {
  const lang = langOf(form);
  const staff = await director(lang, "users.manage");
  if (!staff) return { ok: false, error: "role" };
  const email = field(form, "email").toLowerCase();
  const fullName = field(form, "fullName").replace(/\s+/g, " ");
  const role = field(form, "role");
  const propertySlugs = role === "director" ? [] : form.getAll("property").filter((v): v is string => typeof v === "string" && /^[a-z0-9-]{1,60}$/.test(v));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200 || fullName.length < 2 || fullName.length > 120 || !(roles as readonly string[]).includes(role)) return { ok: false, error: "invalid" };
  if (role !== "director" && propertySlugs.length === 0) return { ok: false, error: "needs_property" };
  if (await staffEmailTaken(email)) return { ok: false, error: "exists" };
  try {
    const invite = await inviteStaff(getAuth(), getDb(), { email, fullName, role: role as Role, propertySlugs, actorId: staff.staffId });
    // The list behind the panel shows the new person straight away.
    refresh();
    return { ok: true, url: invite.setupUrl, emailed: invite.emailed, name: fullName, email, staffId: invite.staffId };
  } catch {
    return { ok: false, error: "invalid" };
  }
}
