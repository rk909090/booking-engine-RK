"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { setAccessSetting, type AccessKey } from "@/domain/app-settings";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";

/** Settings › Sign-in & security: one switch at a time (directors; demo accounts may not). */
export async function setAccessAction(form: FormData) {
  const get = (key: string) => {
    const v = form.get(key);
    return typeof v === "string" ? v.trim() : "";
  };
  const langRaw = get("lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const back = (query: string): never => {
    refresh();
    redirect(`/${lang}/ops/settings/access?${query}`);
  };
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "users.manage").allowed) return back("error=role");
  const key = get("key");
  if (key !== "demoLogin" && key !== "twoFactorRequired") return back("error=invalid");
  const value = get("value") === "true";
  // Opening demo sign-in to anyone needs an explicit tick.
  if (key === "demoLogin" && value && get("confirm") !== "yes") return back("error=confirm");
  const result = await setAccessSetting(getDb(), { key: key as AccessKey, value, actor: { staffId: staff.staffId, isDemo: staff.isDemo } });
  back(result.ok ? "done=1" : "error=demo_account");
}
