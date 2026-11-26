import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { OwnersTabs, type OwnersTab } from "@/components/ops/owners-tabs";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { todayIn } from "@/domain/dates";
import { monthStart, nextMonth } from "@/domain/owners";
import { EXPENSE_CATEGORIES } from "@/domain/types";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { addExpenseAction, addRecurringAction, stopRecurringAction, voidExpenseAction } from "@/lib/ops/owner-actions";
import { visibleProperties } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/owners/expenses">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).owners.tabs.expenses };
}

export default async function OwnerExpensesPage({ params, searchParams }: PageProps<"/[lang]/ops/owners/expenses">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Expenses lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const button = "rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep";
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Expenses({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "owners.expense").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const t = dict.owners;
  const sp = await searchParams;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "owners.expense", p.id).allowed);
  const property = properties.find((p) => p.slug === one(sp.property)) ?? properties[0];
  if (!property) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const today = todayIn(property.timezone);
  const monthRaw = one(sp.month) ?? "";
  const month = monthStart(monthRaw) ? monthRaw : today.slice(0, 7);
  const first = monthStart(month)!;
  const db = getDb();
  const units = await db
    .select({ id: schema.units.id, code: schema.units.code })
    .from(schema.units)
    .where(eq(schema.units.propertyId, property.id))
    .orderBy(asc(schema.units.code));
  const code = new Map(units.map((u) => [u.id, u.code]));
  const expenses = await db
    .select()
    .from(schema.ownerExpenses)
    .where(and(eq(schema.ownerExpenses.propertyId, property.id), gte(schema.ownerExpenses.expenseDate, first), lt(schema.ownerExpenses.expenseDate, nextMonth(first))))
    .orderBy(asc(schema.ownerExpenses.expenseDate), asc(schema.ownerExpenses.createdAt));
  const recurring = await db.select().from(schema.recurringExpenses).where(eq(schema.recurringExpenses.propertyId, property.id)).orderBy(desc(schema.recurringExpenses.createdAt));
  const canManage = can(staff.actor, "owners.manage", property.id).allowed;
  const tabs: OwnersTab[] = can(staff.actor, "owners.view", property.id).allowed ? ["statements", "setup", "expenses"] : ["expenses"];
  const money = (n: number) => formatMoney(n, lang);
  const day = (d: string) => formatDate(d, lang, { day: "numeric", month: "short", year: "numeric" });
  const monthLabel = (m: string) => formatDate(m, lang, { month: "short", year: "numeric" });
  const done = one(sp.done) ? t.saved : undefined;
  const errorCode = one(sp.error);
  const error = errorCode ? ((t.errors as Record<string, string>)[errorCode] ?? t.errors.not_found) : undefined;
  const hidden = (anchor: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="anchor" value={anchor} />
    </>
  );
  const categories = (withAdjustment: boolean) =>
    EXPENSE_CATEGORIES.filter((c) => withAdjustment || c !== "adjustment").map((c) => (
      <option key={c} value={c}>
        {t.categories[c]}
      </option>
    ));
  const unitOptions = units.map((u) => (
    <option key={u.id} value={u.id}>
      {u.code}
    </option>
  ));
  const live = expenses.filter((e) => !e.voidedAt);

  return (
    <>
      <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
      <p className="mt-1 max-w-3xl text-sm text-stone">{t.expensesIntro}</p>
      <OwnersTabs lang={lang} dict={dict} current="expenses" tabs={tabs} property={property.slug} properties={properties} month={month} />
      <div className="mt-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>

      <Section id="add-expense" title={t.addExpenseTitle} intro={t.addExpenseIntro}>
        <form action={addExpenseAction} className="grid gap-3 sm:grid-cols-[0.8fr_1fr_1fr_2fr_1fr_auto] sm:items-end">
          {hidden("add-expense")}
          <label className="space-y-1 text-xs text-stone">
            <span>{t.villa}</span>
            <select name="unitId" required className={input}>
              {unitOptions}
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.date}</span>
            <input type="date" name="date" required defaultValue={today.startsWith(month) ? today : first} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.category}</span>
            <select name="category" required className={input}>
              {categories(true)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.description}</span>
            <input name="description" required maxLength={200} placeholder={t.descriptionPlaceholder} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span>{t.amount}</span>
            <input name="amount" required inputMode="numeric" className={input} />
          </label>
          <button type="submit" className={button}>
            {t.add}
          </button>
        </form>
      </Section>

      <Section id="expense-list" title={format(t.expensesFor, { month: formatDate(first, lang, { month: "long", year: "numeric" }) })}>
        {expenses.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-xs text-stone">
                <tr>
                  <th className="py-1 pr-3 font-normal">{t.date}</th>
                  <th className="py-1 pr-3 font-normal">{t.villa}</th>
                  <th className="py-1 pr-3 font-normal">{t.category}</th>
                  <th className="py-1 pr-3 font-normal">{t.description}</th>
                  <th className="py-1 pr-3 text-right font-normal">{t.amount}</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line align-top">
                {expenses.map((e) => (
                  <tr key={e.id} className={e.voidedAt ? "text-stone line-through" : "text-ink"}>
                    <td className="py-2 pr-3">{day(e.expenseDate)}</td>
                    <td className="py-2 pr-3">{code.get(e.unitId)}</td>
                    <td className="py-2 pr-3">
                      {t.categories[e.category as keyof Dictionary["owners"]["categories"]] ?? e.category}
                      {e.source === "maintenance" ? <span className="block text-xs text-stone no-underline">{t.fromMaintenance}</span> : null}
                    </td>
                    <td className="py-2 pr-3">
                      {e.description}
                      {e.voidedAt && e.voidReason ? <span className="block text-xs">{format(t.voidedBecause, { reason: e.voidReason })}</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-right">{money(e.amount)}</td>
                    <td className="py-2 text-right">
                      {!e.voidedAt ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-danger">{t.void}</summary>
                          <form action={voidExpenseAction} className="mt-1 flex gap-1">
                            {hidden("expense-list")}
                            <input type="hidden" name="expenseId" value={e.id} />
                            <input name="reason" required maxLength={200} placeholder={t.voidReason} aria-label={t.voidReason} className={`${input} py-1 text-xs`} />
                            <button type="submit" className="rounded-lg border border-danger px-2 py-1 text-xs text-danger">
                              {t.void}
                            </button>
                          </form>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-line font-medium text-ink">
                <tr>
                  <td className="py-2 pr-3" colSpan={4}>
                    {t.total}
                  </td>
                  <td className="py-2 pr-3 text-right">{money(live.reduce((s, e) => s + e.amount, 0))}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="text-sm text-stone">{t.noExpenses}</p>
        )}
      </Section>

      <Section id="recurring" title={t.recurringTitle} intro={t.recurringIntro}>
        {recurring.length ? (
          <ul className="divide-y divide-line text-sm">
            {recurring.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className={r.endMonth && r.endMonth < first ? "text-stone" : "text-ink"}>
                  {code.get(r.unitId)} · {t.categories[r.category as keyof Dictionary["owners"]["categories"]] ?? r.category} · {r.description} · {money(r.amount)} / {t.perMonth} ·{" "}
                  {r.endMonth ? `${monthLabel(r.startMonth)} – ${monthLabel(r.endMonth)}` : format(t.fromMonth, { month: monthLabel(r.startMonth) })}
                </span>
                {canManage && !r.endMonth ? (
                  <form action={stopRecurringAction} className="flex items-end gap-2">
                    {hidden("recurring")}
                    <input type="hidden" name="recurringId" value={r.id} />
                    <label className="space-y-1 text-xs text-stone">
                      <span className="block">{t.lastMonth}</span>
                      <input type="month" name="lastMonth" required defaultValue={today.slice(0, 7) >= r.startMonth.slice(0, 7) ? today.slice(0, 7) : r.startMonth.slice(0, 7)} className={`${input} py-1`} />
                    </label>
                    <button type="submit" className="rounded-lg border border-danger px-3 py-1.5 text-xs text-danger">
                      {t.stop}
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone">{t.noRecurring}</p>
        )}
        {canManage ? (
          <form action={addRecurringAction} className="mt-4 grid gap-3 sm:grid-cols-[0.8fr_1fr_2fr_1fr_1fr_auto] sm:items-end">
            {hidden("recurring")}
            <label className="space-y-1 text-xs text-stone">
              <span>{t.villa}</span>
              <select name="unitId" required className={input}>
                {unitOptions}
              </select>
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span>{t.category}</span>
              <select name="category" required className={input}>
                {categories(false)}
              </select>
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span>{t.description}</span>
              <input name="description" required maxLength={200} placeholder={t.recurringPlaceholder} className={input} />
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span>{t.amountPerMonth}</span>
              <input name="amount" required inputMode="numeric" className={input} />
            </label>
            <label className="space-y-1 text-xs text-stone">
              <span>{t.startMonth}</span>
              <input type="month" name="startMonth" required defaultValue={today.slice(0, 7)} className={input} />
            </label>
            <button type="submit" className={button}>
              {t.add}
            </button>
          </form>
        ) : null}
      </Section>
    </>
  );
}

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-6 scroll-mt-6 rounded-xl border border-line bg-white/70 p-5">
      <h2 className="font-display text-xl text-lagoon">{title}</h2>
      {intro ? <p className="mt-1 text-sm text-stone">{intro}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}
