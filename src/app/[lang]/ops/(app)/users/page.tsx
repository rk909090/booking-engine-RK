import { ShieldCheck, UserPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { brand } from "@/config/brand";
import { Card, filterClass, PageHeader, Pill, primaryButton, secondaryButton } from "@/components/ops/ui";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, roles } from "@/lib/authz/permissions";
import { allProperties, listStaff } from "@/lib/ops/users";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/users">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).users.title };
}

export default async function UsersPage({ params, searchParams }: PageProps<"/[lang]/ops/users">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Users lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

async function Users({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "team.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.users;
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const [rows, properties] = await Promise.all([listStaff(staff.actor, { q: str("q"), role: str("role"), status: str("status") }), allProperties()]);
  const propertyName = new Map(properties.map((p) => [p.id, p.name]));
  const canManage = can(staff.actor, "users.manage").allowed;
  const when = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: brand.timezone });

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.intro}
        actions={
          canManage ? (
            <>
              {can(staff.actor, "roles.manage").allowed ? (
                <Link href={`/${lang}/ops/roles`} className={secondaryButton}>
                  <ShieldCheck className="size-4" aria-hidden />
                  {dict.opsNav.roles}
                </Link>
              ) : null}
              <Link href={`/${lang}/ops/users/new`} className={primaryButton}>
                <UserPlus className="size-4" aria-hidden />
                {t.invite}
              </Link>
            </>
          ) : null
        }
      />
      {!canManage ? <p className="mb-4 text-sm text-stone">{t.readOnly}</p> : null}

      <form className="mb-4 flex flex-wrap items-end gap-2" role="search">
        <input name="q" defaultValue={str("q")} placeholder={t.search} aria-label={t.search} className={`${filterClass} w-full sm:w-64`} />
        <select name="role" defaultValue={str("role")} aria-label={t.columns.role} className={filterClass}>
          <option value="">{t.allRoles}</option>
          {roles.map((r) => (
            <option key={r} value={r}>
              {dict.ops.roles[r]}
            </option>
          ))}
        </select>
        <select name="status" defaultValue={str("status")} aria-label={t.columns.status} className={filterClass}>
          <option value="">{t.allStatus}</option>
          <option value="active">{t.active}</option>
          <option value="inactive">{t.inactive}</option>
        </select>
        <button type="submit" className={secondaryButton}>
          {t.apply}
        </button>
      </form>

      <Card bodyClassName="" title={format(t.count, { count: rows.length })}>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-line/70 text-xs text-stone">
                <tr>
                  <th className="px-5 py-2.5 font-medium">{t.columns.name}</th>
                  <th className="px-3 py-2.5 font-medium">{t.columns.role}</th>
                  <th className="px-3 py-2.5 font-medium">{t.columns.properties}</th>
                  <th className="px-3 py-2.5 font-medium">{t.columns.twoFactor}</th>
                  <th className="px-3 py-2.5 font-medium">{t.columns.status}</th>
                  <th className="px-5 py-2.5 font-medium">{t.columns.lastSeen}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {rows.map((u) => (
                  <tr key={u.id} className={`hover:bg-sand/40 ${u.isActive ? "" : "opacity-60"}`}>
                    <td className="px-5 py-3">
                      <Link href={`/${lang}/ops/users/${u.id}`} className="flex items-center gap-3">
                        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-lagoon-soft text-xs font-semibold text-lagoon">
                          {initials(u.fullName)}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-medium text-ink hover:underline">
                            {u.fullName}
                            {u.id === staff.staffId ? <span className="ml-2 text-xs font-normal text-stone">({t.you})</span> : null}
                          </span>
                          <span className="block truncate text-xs text-stone">{u.email}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-3">
                      <Pill tone={u.role === "director" ? "warn" : u.role === "branch_manager" ? "info" : "neutral"}>{dict.ops.roles[u.role]}</Pill>
                    </td>
                    <td className="px-3 py-3 text-stone">{u.role === "director" ? t.allProps : u.propertyIds.map((id) => propertyName.get(id) ?? "?").join(", ") || "—"}</td>
                    <td className="px-3 py-3">{u.twoFactorEnabled ? <Pill tone="good">{t.twoFactorOn}</Pill> : <Pill tone="warn">{t.twoFactorOff}</Pill>}</td>
                    <td className="px-3 py-3">{u.isActive ? <Pill tone="good">{t.active}</Pill> : <Pill tone="bad">{t.inactive}</Pill>}</td>
                    <td className="px-5 py-3 text-xs text-stone">{u.lastSeen ? when.format(new Date(u.lastSeen)) : t.never}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-5 py-6 text-sm text-stone">{t.noResults}</p>
        )}
      </Card>
    </>
  );
}
