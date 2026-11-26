import { inArray } from "drizzle-orm";
import { KeyRound, Presentation } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { Card, dangerButton, Pill, primaryButton, secondaryButton } from "@/components/ops/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { DEMO_LOGIN_EMAILS, readAccessSettings } from "@/domain/app-settings";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { roles } from "@/lib/authz/permissions";
import { setAccessAction } from "@/lib/ops/access-actions";
import { SettingsHeader, settingsContext } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings/access">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.settings.tabs.access} · ${dict.settings.title}` };
}

export default async function AccessPage({ params, searchParams }: PageProps<"/[lang]/ops/settings/access">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Access lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

async function Access({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.canAccess) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const t = dict.settings.access;
  const db = getDb();
  const [settings, demoStaff] = await Promise.all([
    readAccessSettings(db),
    db.select({ email: schema.staffMembers.email, fullName: schema.staffMembers.fullName, isActive: schema.staffMembers.isActive, authUserId: schema.staffMembers.authUserId }).from(schema.staffMembers).where(inArray(schema.staffMembers.email, Object.values(DEMO_LOGIN_EMAILS))),
  ]);
  const readOnly = ctx.staff.isDemo;
  const accounts = roles.map((role) => {
    const row = demoStaff.find((s) => s.email === DEMO_LOGIN_EMAILS[role]);
    return { role, name: row?.fullName ?? null, ready: Boolean(row?.isActive && row.authUserId) };
  });
  const missing = accounts.filter((a) => !a.ready).length;

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="access" property={ctx.property} properties={ctx.properties} sp={sp} canProperties={ctx.canProperties} canAccess={ctx.canAccess} />
      <p className="mb-4 max-w-3xl text-sm text-stone">{t.intro}</p>
      {readOnly ? <p className="mb-4 max-w-3xl rounded-lg border border-line bg-sand/60 px-4 py-3 text-sm text-ink">{t.demoReadOnly}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="flex items-start gap-2 font-display text-xl text-ink">
            <Presentation aria-hidden className="mt-1 size-5 shrink-0 text-lagoon" />
            <span className="min-w-0">{t.demo.title}</span>
          </h2>
          <div className="mt-2">{settings.demoLogin ? <Pill tone="warn">{t.on}</Pill> : <Pill>{t.off}</Pill>}</div>
          <p className="mt-2 text-sm text-ink">{t.demo.text}</p>
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">{t.demo.warning}</p>
          <ul className="mt-4 divide-y divide-line/70 text-sm">
            {accounts.map((a) => (
              <li key={a.role} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <span className="font-medium text-ink">{dict.ops.roles[a.role]}</span>
                  {a.name ? <span className="text-stone"> · {a.name}</span> : null}
                </span>
                {a.ready ? <Pill tone="good">{t.demo.ready}</Pill> : <Pill tone="bad">{t.demo.notReady}</Pill>}
              </li>
            ))}
          </ul>
          {missing ? <p className="mt-2 text-xs text-stone">{t.demo.missing}</p> : null}
          {readOnly ? null : (
            <form action={setAccessAction} className="mt-4 flex flex-wrap items-center gap-3 border-t border-line/70 pt-4">
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="key" value="demoLogin" />
              <input type="hidden" name="value" value={settings.demoLogin ? "false" : "true"} />
              {settings.demoLogin ? (
                <>
                  <p className="w-full text-xs text-stone">{t.demo.offHint}</p>
                  <button type="submit" className={primaryButton}>
                    {t.demo.turnOff}
                  </button>
                </>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input type="checkbox" name="confirm" value="yes" required className="size-4 accent-danger" />
                    {t.demo.confirm}
                  </label>
                  <button type="submit" className={dangerButton}>
                    {t.demo.turnOn}
                  </button>
                </>
              )}
            </form>
          )}
        </Card>

        <Card>
          <h2 className="flex items-start gap-2 font-display text-xl text-ink">
            <KeyRound aria-hidden className="mt-1 size-5 shrink-0 text-lagoon" />
            <span className="min-w-0">{t.twoFactor.title}</span>
          </h2>
          <div className="mt-2">{settings.twoFactorRequired ? <Pill tone="good">{t.required}</Pill> : <Pill tone="warn">{t.optional}</Pill>}</div>
          <p className="mt-2 text-sm text-ink">{settings.twoFactorRequired ? t.twoFactor.requiredText : t.twoFactor.optionalText}</p>
          <p className="mt-2 text-sm text-stone">{t.twoFactor.existing}</p>
          {readOnly ? null : (
            <form action={setAccessAction} className="mt-4 flex flex-wrap items-center gap-3 border-t border-line/70 pt-4">
              <input type="hidden" name="lang" value={lang} />
              <input type="hidden" name="key" value="twoFactorRequired" />
              <input type="hidden" name="value" value={settings.twoFactorRequired ? "false" : "true"} />
              <p className="w-full text-xs text-stone">{settings.twoFactorRequired ? t.twoFactor.offHint : t.twoFactor.onHint}</p>
              <button type="submit" className={settings.twoFactorRequired ? secondaryButton : primaryButton}>
                {settings.twoFactorRequired ? t.twoFactor.turnOff : t.twoFactor.turnOn}
              </button>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}
