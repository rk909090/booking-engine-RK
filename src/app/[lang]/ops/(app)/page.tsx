import {
  BedDouble,
  CircleCheck,
  ClipboardList,
  Cable,
  Hourglass,
  PlaneLanding,
  PlaneTakeoff,
  Plus,
  Undo2,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { BarChart } from "@/components/ops/bar-chart";
import { GuestBadges } from "@/components/ops/guest-badges";
import { Card, CardLink, PageHeader, Pill, primaryButton, Segmented } from "@/components/ops/ui";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { authorize, can } from "@/lib/authz/permissions";
import { dashboardData } from "@/lib/ops/dashboard";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).opsNav.home };
}

export default async function OpsHomePage({ params, searchParams }: PageProps<"/[lang]/ops">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

function DashboardSkeleton() {
  return (
    <div aria-hidden className="animate-pulse space-y-6">
      <div className="h-9 w-72 rounded-lg bg-line/60" />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-32 rounded-2xl bg-white" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="h-80 rounded-2xl bg-white xl:col-span-2" />
        <div className="h-80 rounded-2xl bg-white" />
      </div>
    </div>
  );
}

async function Dashboard({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff(lang);
  authorize(staff.actor, "dashboard.view");
  const sp = await searchParams;
  const t = dict.dash;
  const d = await dashboardData(staff.actor, { property: typeof sp.property === "string" ? sp.property : undefined });
  const base = `/${lang}/ops`;
  const money = (n: number) => formatMoney(n, lang);
  const pct = (x: number) => `${new Intl.NumberFormat(lang === "id" ? "id-ID" : "en-GB", { maximumFractionDigits: 0 }).format(x * 100)}%`;
  const firstName = staff.fullName.split(/\s+/)[0];
  const hour = Number((d.empty ? "09:00" : d.nowTime).slice(0, 2));
  const greeting = format(hour < 11 ? t.greeting.morning : hour < 18 ? t.greeting.afternoon : t.greeting.evening, { name: firstName });
  const withProperty = (path: string, extra = "") => {
    const q = new URLSearchParams(extra);
    if (d.selected) q.set("property", d.selected.slug);
    const s = q.toString();
    return `${base}${path}${s ? `?${s}` : ""}`;
  };

  const header = (
    <PageHeader
      eyebrow={formatDate(d.today, lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
      title={greeting}
      description={`${dict.ops.roles[staff.role]} · ${d.selected?.name ?? t.allProperties}`}
      actions={
        <>
          {d.properties.length > 1 ? (
            <Segmented
              label={dict.ops.allProperties}
              items={[{ href: base, label: t.allProperties, active: !d.selected }, ...d.properties.map((p) => ({ href: `${base}?property=${p.slug}`, label: p.name, active: d.selected?.id === p.id }))]}
            />
          ) : null}
          {can(staff.actor, "reservation.create").allowed ? (
            <Link href={`${base}/new-booking`} className={primaryButton}>
              <Plus className="size-4" aria-hidden />
              {t.newBooking}
            </Link>
          ) : null}
        </>
      }
    />
  );

  if (d.empty) {
    return (
      <>
        {header}
        <Card>
          <p className="text-sm text-stone">{dict.ops.noProperties}</p>
        </Card>
      </>
    );
  }

  const arrivedCount = d.arrivals.filter((a) => a.status === "in_house").length;
  const departedCount = d.departures.filter((a) => a.status === "checked_out").length;
  const balanceToday = d.arrivals.filter((a) => a.status === "confirmed" && a.balance > 0).length;
  const attention: Array<{ key: string; icon: LucideIcon; count: number; label: string; href: string; tone: "bad" | "warn" }> = [
    ...(d.counts
      ? [
          { key: "requests", icon: Hourglass, count: d.counts.requestsPending, label: t.attentionItems.requests, href: withProperty("/reservations", "requests=pending"), tone: "warn" as const },
          { key: "deposit", icon: Wallet, count: d.counts.depositsOverdue, label: t.attentionItems.depositOverdue, href: withProperty("/reservations", "deposit=overdue"), tone: "bad" as const },
          { key: "refunds", icon: Undo2, count: d.counts.refundsDue, label: t.attentionItems.refunds, href: withProperty("/reservations", "refund=due"), tone: "bad" as const },
          { key: "balance", icon: Wallet, count: balanceToday, label: t.attentionItems.balanceToday, href: withProperty("/reservations", `from=${d.today}&to=${d.today}`), tone: "warn" as const },
        ]
      : []),
    ...(d.sees.villas ? [{ key: "notReady", icon: BedDouble, count: d.notReady.length, label: t.attentionItems.notReady, href: withProperty("/villa-status"), tone: "bad" as const }] : []),
    ...(d.sees.tasks
      ? [
          { key: "tasksLate", icon: ClipboardList, count: d.taskSummary.late, label: t.attentionItems.tasksLate, href: withProperty("/tasks"), tone: "bad" as const },
          { key: "tasksUnassigned", icon: UserRound, count: d.taskSummary.unassigned, label: t.attentionItems.tasksUnassigned, href: withProperty("/tasks"), tone: "warn" as const },
        ]
      : []),
    ...(can(staff.actor, "channels.manage").allowed ? [{ key: "conflicts", icon: Cable, count: d.conflicts, label: t.attentionItems.conflicts, href: `${base}/channels`, tone: "bad" as const }] : []),
  ].filter((a) => a.count > 0);

  const states = dict.villaStatus.readiness;
  const villaBars: Array<{ key: keyof typeof states; count: number; color: string }> = [
    { key: "occupied", count: d.villaSummary.occupied, color: "bg-lagoon" },
    { key: "ready", count: d.villaSummary.ready, color: "bg-success" },
    { key: "inspect", count: d.villaSummary.inspect, color: "bg-terracotta" },
    { key: "dirty", count: d.villaSummary.dirty, color: "bg-terracotta-deep" },
    { key: "maintenance", count: d.villaSummary.maintenance, color: "bg-danger" },
  ];

  return (
    <>
      {header}

      {d.counts ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Kpi
            icon={BedDouble}
            label={t.tonight}
            value={d.tonight.available ? pct(d.tonight.sold / d.tonight.available) : "—"}
            sub={format(t.tonightSub, { sold: d.tonight.sold, total: d.tonight.available })}
            href={`${base}/calendar`}
            meter={d.tonight.available ? d.tonight.sold / d.tonight.available : 0}
          />
          <Kpi icon={PlaneLanding} label={t.arrivals} value={String(d.counts.arrivals)} sub={format(t.arrivalsSub, { done: arrivedCount })} href={withProperty("/reservations", `from=${d.today}&to=${d.today}`)} />
          <Kpi icon={PlaneTakeoff} label={t.departures} value={String(d.counts.departures)} sub={format(t.departuresSub, { done: departedCount })} href={withProperty("/reservations", `departOn=${d.today}`)} />
          <Kpi icon={UserRound} label={t.inHouse} value={String(d.counts.inHouse)} sub={t.inHouseSub} href={withProperty("/reservations", "status=in_house")} />
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {d.sees.reservations ? (
            <>
              <Card title={`${t.arrivalsTitle} · ${d.arrivals.length}`} action={<CardLink href={withProperty("/reservations", `from=${d.today}&to=${d.today}`)}>{t.viewAll}</CardLink>} bodyClassName="">
                {d.arrivals.length ? (
                  <ul className="divide-y divide-line/70">
                    {d.arrivals.map((a) => (
                      <Movement key={a.id} lang={lang} dict={dict} row={a}>
                        <span className="text-xs text-stone">{a.eta ? format(t.eta, { time: a.eta.slice(0, 5) }) : t.etaUnknown}</span>
                        {a.status === "in_house" ? <Pill tone="good">{t.arrived}</Pill> : <Pill>{t.notArrived}</Pill>}
                        {a.status === "confirmed" && a.readiness && a.readiness !== "ready" ? <Pill tone="bad">{states[a.readiness]}</Pill> : null}
                        {a.earlyCheckin ? <Pill tone={a.earlyCheckin.approved ? "info" : "warn"}>{format(a.earlyCheckin.approved ? t.early : t.earlyPending, { time: a.earlyCheckin.time })}</Pill> : null}
                        {a.status === "confirmed" && a.balance > 0 ? <Pill tone="warn">{format(t.balance, { amount: money(a.balance) })}</Pill> : null}
                      </Movement>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-6 text-sm text-stone">{t.noArrivals}</p>
                )}
              </Card>
              <Card title={`${t.departuresTitle} · ${d.departures.length}`} action={<CardLink href={withProperty("/reservations", `departOn=${d.today}`)}>{t.viewAll}</CardLink>} bodyClassName="">
                {d.departures.length ? (
                  <ul className="divide-y divide-line/70">
                    {d.departures.map((a) => (
                      <Movement key={a.id} lang={lang} dict={dict} row={a}>
                        {a.status === "checked_out" ? <Pill tone="good">{t.departed}</Pill> : <Pill tone="info">{t.staying}</Pill>}
                        {a.lateCheckout ? <Pill tone={a.lateCheckout.approved ? "info" : "warn"}>{format(a.lateCheckout.approved ? t.late : t.latePending, { time: a.lateCheckout.time })}</Pill> : null}
                        {a.status === "in_house" && a.balance > 0 ? <Pill tone="warn">{format(t.balance, { amount: money(a.balance) })}</Pill> : null}
                      </Movement>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-6 text-sm text-stone">{t.noDepartures}</p>
                )}
              </Card>
            </>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card title={t.attention}>
            {attention.length ? (
              <ul className="-my-1 space-y-1">
                {attention.map((a) => (
                  <li key={a.key}>
                    <Link href={a.href} className="group flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-sand/50">
                      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${a.tone === "bad" ? "bg-danger/10 text-danger" : "bg-terracotta/15 text-terracotta-deep"}`}>
                        <a.icon className="size-[18px]" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 text-sm text-ink">{a.label}</span>
                      <span className={`text-lg font-semibold tabular-nums ${a.tone === "bad" ? "text-danger" : "text-terracotta-deep"}`}>{a.count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-sm text-success">
                <CircleCheck className="size-5" aria-hidden />
                {t.allClear}
              </p>
            )}
          </Card>

        </div>
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
        {d.sees.villas && d.villaSummary.total ? (
          <Card title={t.villasTitle} action={<CardLink href={withProperty("/villa-status")}>{t.villasLink}</CardLink>}>
            <div className="flex h-2.5 overflow-hidden rounded-full bg-sand" aria-hidden>
              {villaBars.map((b) => (b.count ? <div key={b.key} className={b.color} style={{ width: `${(b.count / d.villaSummary.total) * 100}%` }} /> : null))}
            </div>
            <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {villaBars.map((b) => (
                <li key={b.key} className="flex items-center gap-2">
                  <span aria-hidden className={`size-2.5 rounded-full ${b.color}`} />
                  <span className="flex-1 text-stone">{states[b.key]}</span>
                  <span className="font-semibold tabular-nums text-ink">{b.count}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {d.sees.tasks ? (
          <Card title={`${t.tasksTitle} · ${format(t.tasksOpen, { count: d.taskSummary.open })}`} action={<CardLink href={withProperty("/tasks")}>{t.tasksLink}</CardLink>}>
            <dl className="grid grid-cols-3 gap-3 text-center">
              <Mini label={t.tasksDueToday} value={d.taskSummary.dueToday} />
              <Mini label={t.tasksLate} value={d.taskSummary.late} bad={d.taskSummary.late > 0} />
              <Mini label={t.tasksUnassigned} value={d.taskSummary.unassigned} warn={d.taskSummary.unassigned > 0} />
            </dl>
          </Card>
        ) : null}
        {d.counts ? (
          <BarChart
            title={t.forwardTitle}
            max={1}
            format={pct}
            tableLabel={t.forwardTable}
            columnLabel={t.forwardColumn}
            points={d.nights.map((n) => ({
              key: n.date,
              label: formatDate(n.date, lang, { weekday: "short", day: "numeric", month: "short" }),
              short: formatDate(n.date, lang, { day: "numeric" }),
              value: n.available ? n.sold / n.available : 0,
            }))}
          />
        ) : null}
      </div>

      {d.perf ? (
        <section aria-labelledby="month-heading" className="mt-8">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="month-heading" className="text-sm font-semibold text-ink">
                {format(t.monthTitle, { month: formatDate(d.perf.from, lang, { month: "long", year: "numeric" }) })}
              </h2>
              <p className="text-xs text-stone">{t.monthNote}</p>
            </div>
            <CardLink href={withProperty("/reports", `from=${d.perf.from}&to=${d.perf.to}`)}>{t.reportsLink}</CardLink>
          </div>
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Compare label={t.occupancy} now={pct(d.perf.current.occupancy)} before={d.perf.previous.available && d.perf.previous.sold ? pct(d.perf.previous.occupancy) : null} up={d.perf.current.occupancy >= d.perf.previous.occupancy} t={t} />
            <Compare label={t.revenue} now={money(d.perf.current.revenue)} before={d.perf.previous.revenue ? money(d.perf.previous.revenue) : null} up={d.perf.current.revenue >= d.perf.previous.revenue} t={t} />
            <Compare label={t.adr} now={money(d.perf.current.adr)} before={d.perf.previous.adr ? money(d.perf.previous.adr) : null} up={d.perf.current.adr >= d.perf.previous.adr} t={t} />
            <Compare label={t.revpar} now={money(d.perf.current.revpar)} before={d.perf.previous.revpar ? money(d.perf.previous.revpar) : null} up={d.perf.current.revpar >= d.perf.previous.revpar} t={t} />
          </div>
        </section>
      ) : null}

    </>
  );
}

function Kpi({ icon: Icon, label, value, sub, href, meter }: { icon: LucideIcon; label: string; value: string; sub: string; href: string; meter?: number }) {
  return (
    <Link href={href} className="group rounded-2xl border border-line/80 bg-white p-5 shadow-sm transition-colors hover:border-lagoon/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-stone">{label}</span>
        <span className="grid size-9 place-items-center rounded-xl bg-lagoon-soft text-lagoon">
          <Icon className="size-[18px]" aria-hidden />
        </span>
      </div>
      <p className="mt-2 font-display text-3xl text-ink tabular-nums sm:text-4xl">{value}</p>
      <p className="mt-1 text-xs text-stone">{sub}</p>
      {meter !== undefined ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sand" aria-hidden>
          <div className="h-full rounded-full bg-lagoon" style={{ width: `${Math.min(100, Math.round(meter * 100))}%` }} />
        </div>
      ) : null}
    </Link>
  );
}

function Mini({ label, value, bad, warn }: { label: string; value: number; bad?: boolean; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-canvas px-2 py-3">
      <dd className={`text-2xl font-semibold tabular-nums ${bad ? "text-danger" : warn ? "text-terracotta-deep" : "text-ink"}`}>{value}</dd>
      <dt className="mt-0.5 text-xs text-stone">{label}</dt>
    </div>
  );
}

function Compare({ label, now, before, up, t }: { label: string; now: string; before: string | null; up: boolean; t: Dictionary["dash"] }) {
  return (
    <div className="rounded-2xl border border-line/80 bg-white p-5 shadow-sm">
      <p className="text-sm text-stone">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-ink tabular-nums">{now}</p>
      <p className={`mt-1 text-xs ${before === null ? "text-stone" : up ? "text-success" : "text-danger"}`}>
        {before === null ? t.noLastYear : `${up ? "▲" : "▼"} ${format(t.lastYear, { value: before })}`}
      </p>
    </div>
  );
}

function Movement({
  lang,
  dict,
  row,
  children,
}: {
  lang: Locale;
  dict: Dictionary;
  row: { code: string; guestName: string; guestTags: string[]; guestPastStays: number; unitCode: string; propertyName: string; adults: number; children: number };
  children: ReactNode;
}) {
  const initials = row.guestName
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <li>
      <Link href={`/${lang}/ops/reservations/${row.code}`} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 hover:bg-sand/40">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-lagoon-soft text-xs font-semibold text-lagoon">
          {initials}
        </span>
        {/* At least 12rem for the name, so the badges move under it on a phone. */}
        <span className="min-w-0 flex-1 basis-48">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{row.guestName}</span>
            <GuestBadges dict={dict} tags={row.guestTags} pastStays={row.guestPastStays} />
          </span>
          <span className="block text-xs text-stone">
            {row.unitCode} · {row.propertyName} · {format(dict.dash.guests, { count: row.adults + row.children })} · {row.code}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 pl-[52px] sm:pl-0">{children}</span>
      </Link>
    </li>
  );
}
