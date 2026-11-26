import { Lock } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { Card, PageHeader, dangerButton, primaryButton } from "@/components/ops/ui";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import { permissionOverrides } from "@/domain/staff-admin";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { ACTION_GROUPS } from "@/lib/authz/action-groups";
import { can, defaultAllows, isLocked, permissionsFor, roles } from "@/lib/authz/permissions";
import { resetRolesAction, saveRolesAction } from "@/lib/ops/admin-actions";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/roles">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).rbac.title };
}

export default async function RolesPage({ params, searchParams }: PageProps<"/[lang]/ops/roles">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Roles lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

async function Roles({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "roles.manage").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.rbac;
  const sp = await searchParams;
  const overrides = await permissionOverrides(getDb());
  const effective = new Map(roles.map((r) => [r, new Set(permissionsFor(r, overrides))]));
  // Checkboxes keep what was clicked across a refresh; a key from the saved matrix redraws them from the data.
  const stamp = overrides.map((o) => `${o.role}:${o.action}:${o.allowed ? 1 : 0}`).sort().join("|") || "defaults";
  const labels = t.actions as Record<string, { label: string; hint: string }>;
  const note =
    typeof sp.saved === "string" ? format(t.saved, { count: sp.saved }) : sp.nochange ? t.noChange : sp.reset ? t.resetDone : undefined;
  const error = typeof sp.error === "string" ? ((dict.users.errors as Record<string, string>)[sp.error] ?? dict.users.errors.invalid) : undefined;

  return (
    <>
      <PageHeader title={t.title} description={t.intro} />
      <div className="mb-4 space-y-2">
        {note ? <SuccessNote>{note}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <form key={stamp} action={saveRolesAction}>
        <input type="hidden" name="lang" value={lang} />
        <Card bodyClassName="">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="border-b border-line/70 text-left text-xs text-stone">
                  <th className="px-5 py-3 font-medium">{t.role}</th>
                  {roles.map((r) => (
                    <th key={r} className="w-32 px-3 py-3 text-center font-semibold text-ink">
                      {dict.ops.roles[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              {ACTION_GROUPS.map((g) => (
                <tbody key={g.key} className="border-b border-line/70">
                  <tr className="bg-canvas/60">
                    <th colSpan={roles.length + 1} className="px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-terracotta-deep">
                      {t.groups[g.key]}
                    </th>
                  </tr>
                  {g.actions.map((action) => (
                    <tr key={action} className="hover:bg-sand/30">
                      <td className="px-5 py-2.5">
                        <span className="block font-medium text-ink">{labels[action]?.label ?? action}</span>
                        <span className="block text-xs text-stone">{labels[action]?.hint}</span>
                      </td>
                      {roles.map((r) => {
                        const locked = isLocked(r, action);
                        const on = effective.get(r)!.has(action);
                        const changed = !locked && on !== defaultAllows(r, action);
                        const label = `${dict.ops.roles[r]}: ${labels[action]?.label ?? action}`;
                        return (
                          <td key={r} className="px-3 py-2.5 text-center">
                            <span className="relative inline-flex items-center justify-center">
                              {locked ? (
                                <span title={t.locked} className="inline-flex items-center gap-1 text-stone">
                                  <input type="checkbox" checked={on} disabled readOnly aria-label={`${label} (${t.locked})`} className="size-[18px] accent-lagoon opacity-50" />
                                  <Lock className="size-3.5" aria-hidden />
                                </span>
                              ) : (
                                <input type="checkbox" name="perm" value={`${r}|${action}`} defaultChecked={on} aria-label={label} className="size-[18px] cursor-pointer accent-lagoon" />
                              )}
                              {changed ? <span title={t.changed} aria-label={t.changed} className="absolute -right-2.5 -top-1 size-2 rounded-full bg-terracotta" /> : null}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/70 px-5 py-4">
            <div className="space-y-1 text-xs text-stone">
              <p className="flex items-center gap-1.5">
                <Lock className="size-3.5" aria-hidden /> {t.locked}
              </p>
              <p className="flex items-center gap-1.5">
                <span aria-hidden className="size-2 rounded-full bg-terracotta" /> {t.changed}
              </p>
              <p>{t.scopeNote}</p>
              <p>{t.discountNote}</p>
            </div>
            <button type="submit" className={primaryButton}>
              {t.save}
            </button>
          </div>
        </Card>
      </form>

      {overrides.length ? (
        <Card id="reset" title={t.resetTitle} className="mt-6">
          <form action={resetRolesAction} className="flex flex-wrap items-center gap-4">
            <input type="hidden" name="lang" value={lang} />
            <p className="flex-1 text-sm text-stone">{t.resetHint}</p>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="confirm" value="yes" required className="size-4 accent-danger" />
              {t.resetConfirm}
            </label>
            <button type="submit" className={dangerButton}>
              {t.reset}
            </button>
          </form>
        </Card>
      ) : null}
    </>
  );
}
