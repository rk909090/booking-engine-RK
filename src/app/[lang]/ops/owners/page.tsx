import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { NoAccess, OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { OwnersTabs, previousMonth, type OwnersTab } from "@/components/ops/owners-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import { todayIn } from "@/domain/dates";
import { buildStatements, monthStart, nextMonth } from "@/domain/owners";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { lockStatementAction, markPaidAction } from "@/lib/ops/owner-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/owners">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owners.title };
}

export default async function OwnersPage({ params, searchParams }: PageProps<"/[lang]/ops/owners">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Statements lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const input = "rounded-lg border border-line bg-white px-3 py-1.5 text-sm text-ink";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Statements({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "owners.view").allowed) {
    if (can(staff.actor, "owners.expense").allowed) redirect(`/${lang}/ops/owners/expenses`);
    return <NoAccess lang={lang} dict={dict} staff={staff} />;
  }
  const t = dict.owners;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "owners.view", p.id).allowed);
  const property = properties.find((p) => p.slug === one(sp.property)) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const today = todayIn(property.timezone);
  const monthRaw = one(sp.month) ?? "";
  const month = monthStart(monthRaw) ? monthRaw : previousMonth(today);
  const first = monthStart(month)!;
  const monthOver = nextMonth(first) <= today;
  const rows = (await buildStatements(getDb(), { propertyId: property.id, month })) ?? [];
  const canManage = can(staff.actor, "owners.manage", property.id).allowed;
  const tabs: OwnersTab[] = ["statements", "setup", ...(can(staff.actor, "owners.expense", property.id).allowed ? (["expenses"] as const) : [])];
  const money = (n: number) => formatMoney(n, lang);
  const monthName = formatDate(first, lang, { month: "long", year: "numeric" });
  const done = one(sp.done) ? t.saved : undefined;
  const errorCode = one(sp.error);
  const error = errorCode ? ((t.errors as Record<string, string>)[errorCode] ?? t.errors.not_found) : undefined;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="anchor" value={anchor} />
      <input type="hidden" name="propertyId" value={property.id} />
    </>
  );
  const sum = (k: "roomRevenue" | "commission" | "fee" | "expenses" | "payout") => rows.reduce((s, r) => s + r.data.totals[k], 0);

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="owners" />
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.intro}</p>
      <OwnersTabs lang={lang} dict={dict} current="statements" tabs={tabs} property={property.slug} properties={properties} month={month} />
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <section className="mt-6 rounded-xl border border-line bg-white/70 p-5">
        <h2 className="font-display text-xl text-lagoon">{format(t.statementsFor, { month: monthName })}</h2>
        <p className="mt-1 text-sm text-stone">{monthOver ? t.formula : t.monthOpen}</p>
        {rows.length ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="text-left text-xs text-stone">
                <tr>
                  <th className="py-1 pr-3 font-normal">{t.owner}</th>
                  <th className="py-1 pr-3 font-normal">{t.villas}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.nights}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.roomRevenue}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.commission}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.fee}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.expenses}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.payout}</th>
                  <th className="py-1 pr-3 font-normal">{t.status}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {rows.map((r) => {
                  const x = r.data.totals;
                  const anchor = `owner-${r.ownerId}`;
                  return (
                    <tr key={r.ownerId} id={anchor} className="scroll-mt-6">
                      <td className="py-2 pr-3 font-medium text-ink">{r.data.owner.fullName}</td>
                      <td className="py-2 pr-3 text-xs text-stone">{r.data.units.map((u) => u.code).join(", ")}</td>
                      <td className="py-2 pr-3 text-right">
                        {x.soldNights} / {x.ownedNights}
                      </td>
                      <td className="py-2 pr-3 text-right">{money(x.roomRevenue)}</td>
                      <td className="py-2 pr-3 text-right">{x.commission ? `−${money(x.commission)}` : "—"}</td>
                      <td className="py-2 pr-3 text-right">−{money(x.fee)}</td>
                      <td className="py-2 pr-3 text-right">{x.expenses ? `−${money(x.expenses)}` : "—"}</td>
                      <td className={`py-2 pr-3 text-right font-medium ${x.payout < 0 ? "text-danger" : "text-ink"}`}>{money(x.payout)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {t.statusLabels[r.status]}
                        {r.status === "paid" && r.paidReference ? <span className="block text-stone">{r.paidReference}</span> : null}
                      </td>
                      <td className="space-y-2 py-2 text-right">
                        <Link href={`/${lang}/ops/owners/${r.ownerId}/statement?property=${property.slug}&month=${month}`} className="block text-xs text-lagoon hover:underline">
                          {t.view}
                        </Link>
                        {canManage && r.status === "draft" && monthOver ? (
                          <form action={lockStatementAction}>
                            {hidden(anchor)}
                            <input type="hidden" name="ownerId" value={r.ownerId} />
                            <button type="submit" className="rounded-lg bg-lagoon px-3 py-1 text-xs text-ivory hover:bg-lagoon-deep">
                              {t.lock}
                            </button>
                          </form>
                        ) : null}
                        {canManage && r.status === "locked" && r.statementId ? (
                          <form action={markPaidAction} className="flex justify-end gap-1">
                            {hidden(anchor)}
                            <input type="hidden" name="statementId" value={r.statementId} />
                            <input name="reference" required maxLength={200} placeholder={t.paidReference} aria-label={t.paidReference} className={`${input} w-40 text-xs`} />
                            <button type="submit" className="rounded-lg border border-lagoon px-2 py-1 text-xs text-lagoon hover:bg-lagoon-soft">
                              {t.markPaid}
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-line text-sm font-medium text-ink">
                <tr>
                  <td className="py-2 pr-3" colSpan={3}>
                    {t.total}
                  </td>
                  <td className="py-2 pr-3 text-right">{money(sum("roomRevenue"))}</td>
                  <td className="py-2 pr-3 text-right">−{money(sum("commission"))}</td>
                  <td className="py-2 pr-3 text-right">−{money(sum("fee"))}</td>
                  <td className="py-2 pr-3 text-right">−{money(sum("expenses"))}</td>
                  <td className="py-2 pr-3 text-right">{money(sum("payout"))}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-stone">{t.noOwners}</p>
        )}
      </section>
    </>
  );
}
