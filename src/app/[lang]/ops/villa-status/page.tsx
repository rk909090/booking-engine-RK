import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { OpsNav, OpsShell, NoAccess } from "@/components/ops/ops-shell";
import { ErrorNote, SuccessNote } from "@/components/ui";
import { addDays } from "@/domain/dates";
import type { Readiness } from "@/domain/housekeeping";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate } from "@/i18n/formatters";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { changeUnitStateAction, createBlockAction, resolveBlockAction } from "@/lib/ops/housekeeping-actions";
import { villaStatus } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/villa-status">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).villaStatus.title };
}

export default async function VillaStatusPage({ params, searchParams }: PageProps<"/[lang]/ops/villa-status">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <Board lang={lang} dict={dict} searchParams={searchParams} />
      </Suspense>
    </OpsShell>
  );
}

const tone: Record<Readiness, string> = {
  maintenance: "bg-danger/10 text-danger border-danger/30",
  dirty: "bg-terracotta/10 text-terracotta-deep border-terracotta/30",
  inspect: "bg-sand text-ink border-line",
  occupied: "bg-lagoon-soft text-lagoon border-lagoon/20",
  ready: "bg-success/10 text-success border-success/30",
};

function one(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

async function Board({
  lang,
  dict,
  searchParams,
}: {
  lang: Locale;
  dict: Dictionary;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireStaff(lang);
  if (!can(staff.actor, "villa_status.view").allowed) return <NoAccess lang={lang} dict={dict} staff={staff} />;
  const sp = await searchParams;
  const t = dict.villaStatus;
  const data = await villaStatus(staff.actor, one(sp.property), new Date());
  const property = data.property;
  const timeFmt = new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: property?.timezone ?? "Asia/Makassar",
  });
  const error = one(sp.error);
  const errorText = error
    ? format((t.errors as Record<string, string>)[error] ?? t.errors.not_found, { codes: one(sp.codes) ?? "" })
    : null;
  const canUpdate = property ? can(staff.actor, "housekeeping.update", property.id).allowed : false;
  const canBlock = property ? can(staff.actor, "unit.block", property.id).allowed : false;
  const attention = data.units.filter((u) => u.needsAttention).length;

  const hidden = (unitId: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property?.slug ?? ""} />
      <input type="hidden" name="unitId" value={unitId} />
    </>
  );

  return (
    <>
      <OpsNav lang={lang} dict={dict} staff={staff} current="villaStatus" />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-lagoon">{t.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-stone">{t.intro}</p>
        </div>
        {data.properties.length > 1 ? (
          <div className="flex gap-2 text-sm">
            {data.properties.map((p) => (
              <Link
                key={p.slug}
                href={`/${lang}/ops/villa-status?property=${p.slug}`}
                aria-current={p.slug === property?.slug ? "page" : undefined}
                className={p.slug === property?.slug ? "rounded-lg bg-lagoon px-3 py-1.5 text-ivory" : "rounded-lg border border-line px-3 py-1.5 text-ink hover:bg-sand"}
              >
                {p.name}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <div className="mt-4 space-y-2">
        {one(sp.done) ? <SuccessNote>{t.done}</SuccessNote> : null}
        {errorText ? <ErrorNote>{errorText}</ErrorNote> : null}
      </div>

      {property ? (
        <p className="mt-4 text-sm text-ink">
          {property.name} · {formatDate(data.today, lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" })} ·{" "}
          {format(t.summary, {
            attention,
            ready: data.units.filter((u) => u.readiness === "ready").length,
            occupied: data.units.filter((u) => u.readiness === "occupied").length,
          })}
        </p>
      ) : null}

      {data.units.length === 0 ? <p className="mt-6 text-stone">{t.empty}</p> : null}
      <ul className="mt-4 grid gap-4 lg:grid-cols-2">
        {data.units.map((u) => (
          <li key={u.id} id={`unit-${u.id}`} className={`rounded-xl border bg-white/70 p-4 ${u.priority === 0 ? "border-danger/50 ring-1 ring-danger/20" : "border-line"}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-display text-xl text-lagoon">{u.name}</p>
                <p className="font-mono text-xs text-stone">
                  {u.code} · {u.typeName}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {u.priority === 0 ? <span className="rounded-full bg-danger px-2 py-0.5 text-xs font-medium text-ivory">{t.urgent}</span> : null}
                {u.priority === 1 ? <span className="rounded-full bg-terracotta px-2 py-0.5 text-xs font-medium text-ivory">{t.turnover}</span> : null}
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone[u.readiness]}`}>{t.readiness[u.readiness]}</span>
              </div>
            </div>

            <ul className="mt-3 space-y-1 text-sm text-ink">
              {u.arrival ? (
                <li>
                  <Link href={`/${lang}/ops/reservations/${u.arrival.code}`} className="text-lagoon hover:underline">
                    {format(t.arrival, { guest: u.arrival.guestName })}
                  </Link>{" "}
                  <span className="text-stone">· {u.arrival.eta ? format(t.eta, { time: u.arrival.eta.slice(0, 5) }) : t.noEta}</span>
                </li>
              ) : null}
              {u.inHouse ? (
                <li>
                  <Link href={`/${lang}/ops/reservations/${u.inHouse.code}`} className="text-lagoon hover:underline">
                    {format(t.inHouse, { guest: u.inHouse.guestName, date: formatDate(u.inHouse.checkOut, lang) })}
                  </Link>
                  {u.departingToday ? <span className="ml-2 rounded bg-sand px-1.5 py-0.5 text-xs">{t.departing}</span> : null}
                  {u.lateCheckout ? (
                    <span className="mt-1 block text-xs">
                      <span className={u.lateCheckout.approved ? "font-medium text-terracotta-deep" : "text-stone"}>
                        {format(u.lateCheckout.approved ? t.lateCheckout : t.lateRequested, { time: u.lateCheckout.time })}
                      </span>
                      {u.lateCheckout.conflict ? (
                        <span className="ml-2 font-medium text-danger">{format(t.lateConflict, { time: u.lateCheckout.latestAllowed ?? "" })}</span>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ) : null}
              {u.blockToday ? (
                <li className="text-danger">{format(t.blockToday, { date: formatDate(u.blockToday.endDate, lang), reason: u.blockToday.reason })}</li>
              ) : null}
              {u.upcomingBlocks.map((b) => (
                <li key={b.id} className="text-stone">
                  {format(t.upcomingBlock, { from: formatDate(b.startDate, lang), to: formatDate(b.endDate, lang), reason: b.reason })}
                </li>
              ))}
              {u.lastChange ? (
                <li className="text-xs text-stone">
                  {format(t.lastChange, {
                    state: t.readiness[u.lastChange.toState],
                    who: u.lastChange.actorName ?? t.someone,
                    time: timeFmt.format(u.lastChange.occurredAt),
                  })}
                </li>
              ) : null}
            </ul>

            {canUpdate && !u.inHouse ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {u.state === "dirty" ? <StateButton hidden={hidden(u.id)} to="inspect" label={t.markCleaned} primary /> : null}
                {u.state === "inspect" ? (
                  <>
                    <StateButton hidden={hidden(u.id)} to="ready" label={t.markInspected} primary />
                    <StateButton hidden={hidden(u.id)} to="dirty" label={t.failInspection} />
                  </>
                ) : null}
                {u.state === "ready" ? <StateButton hidden={hidden(u.id)} to="dirty" label={t.markDirty} /> : null}
              </div>
            ) : null}

            {canBlock ? (
              <div className="mt-3 space-y-2">
                {[u.blockToday, ...u.upcomingBlocks].filter(Boolean).map((b) => (
                  <form key={b!.id} action={resolveBlockAction}>
                    {hidden(u.id)}
                    <input type="hidden" name="blockId" value={b!.id} />
                    <button type="submit" className="rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-sand">
                      {t.resolve}: {b!.reason}
                    </button>
                  </form>
                ))}
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-lagoon">{t.blockTitle}</summary>
                  <form action={createBlockAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                    {hidden(u.id)}
                    <Labeled label={t.blockFrom}>
                      <input type="date" name="startDate" required defaultValue={data.today} min={data.today} className="w-full rounded-lg border border-line bg-white px-2 py-1.5" />
                    </Labeled>
                    <Labeled label={t.blockTo}>
                      <input type="date" name="endDate" required defaultValue={addDays(data.today, 1)} min={addDays(data.today, 1)} className="w-full rounded-lg border border-line bg-white px-2 py-1.5" />
                    </Labeled>
                    <div className="sm:col-span-2">
                      <Labeled label={t.blockReason}>
                        <input name="reason" required maxLength={300} className="w-full rounded-lg border border-line bg-white px-2 py-1.5" />
                      </Labeled>
                    </div>
                    <button type="submit" className="rounded-lg border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/5 sm:col-span-2">
                      {t.blockSubmit}
                    </button>
                  </form>
                </details>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function StateButton({ hidden, to, label, primary }: { hidden: ReactNode; to: string; label: string; primary?: boolean }) {
  return (
    <form action={changeUnitStateAction}>
      {hidden}
      <input type="hidden" name="to" value={to} />
      <button
        type="submit"
        className={
          primary
            ? "rounded-lg bg-lagoon px-3 py-1.5 text-sm font-medium text-ivory hover:bg-lagoon-deep"
            : "rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-sand"
        }
      >
        {label}
      </button>
    </form>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-xs text-stone">
      <span>{label}</span>
      {children}
    </label>
  );
}
