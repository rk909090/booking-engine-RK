import { connection } from "next/server";
import { getDb } from "@/db/client";
import { readAccessSettings } from "@/domain/app-settings";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { roles } from "@/lib/authz/permissions";
import { DemoLoginButtons } from "./demo-login-buttons";

/**
 * One sign-in button per role while a director has demo sign-in switched on
 * (Settings › Sign-in & security). Nothing is shown otherwise.
 */
export async function DemoLogins({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  await connection();
  const { demoLogin } = await readAccessSettings(getDb());
  if (!demoLogin) return null;
  const t = dict.auth.demo;
  return (
    <DemoLoginButtons
      lang={lang}
      roles={roles.map((role) => ({ role, label: dict.ops.roles[role], hint: t.hints[role] }))}
      t={{ title: t.title, intro: t.intro, working: dict.auth.working, error: t.error, or: t.or }}
    />
  );
}
