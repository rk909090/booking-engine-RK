import { asc, count, eq } from "drizzle-orm";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { brand } from "@/config/brand";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { OpsNav, OpsShell } from "@/components/ops/ops-shell";
import { todayIn } from "@/domain/dates";
import { authorize, can, canAccessProperty, hasGlobalScope } from "@/lib/authz/permissions";
import { todayCounts } from "@/lib/ops/queries";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  return { title: (await getDictionary(lang)).ops.title };
}

export default async function OpsHomePage({ params }: PageProps<"/[lang]/ops">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);

  return (
    <OpsShell lang={lang} dict={dict}>
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <StaffHome lang={lang} dict={dict} />
      </Suspense>
    </OpsShell>
  );
}

async function StaffHome({ lang, dict }: { lang: Locale; dict: Dictionary }) {
  const staff = await requireStaff(lang);
  authorize(staff.actor, "dashboard.view");

  const rows = await getDb()
    .select({
      id: schema.properties.id,
      name: schema.properties.name,
      units: count(schema.units.id),
    })
    .from(schema.properties)
    .leftJoin(schema.units, eq(schema.units.propertyId, schema.properties.id))
    .groupBy(schema.properties.id)
    .orderBy(asc(schema.properties.name));
  const visible = rows.filter((p) => canAccessProperty(staff.actor, p.id));
  const today = todayIn(brand.timezone);
  const counts = can(staff.actor, "reservation.view").allowed ? await todayCounts(staff.actor, today) : null;
  const listHref = (qs: string) => `/${lang}/ops/reservations?${qs}`;

  return (
    <div className="space-y-8">
      <OpsNav lang={lang} dict={dict} staff={staff} current="home" />
      <div>
        <h1 className="font-display text-3xl text-lagoon">{format(dict.ops.welcome, { name: staff.fullName })}</h1>
        <p className="mt-1 text-sm text-stone">
          {dict.ops.role}: {dict.ops.roles[staff.role]} · {staff.email}
        </p>
      </div>

      {counts ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label={dict.opsHome.arrivals} value={counts.arrivals} href={listHref(`from=${today}&to=${today}`)} />
          <Stat label={dict.opsHome.departures} value={counts.departures} href={listHref(`departOn=${today}`)} />
          <Stat label={dict.opsHome.inHouse} value={counts.inHouse} href={listHref("status=in_house")} />
          <Stat label={dict.opsHome.refundsDue} value={counts.refundsDue} href={listHref("refund=due")} warn={counts.refundsDue > 0} />
          <Stat label={dict.opsHome.depositOverdue} value={counts.depositsOverdue} href={listHref("deposit=overdue")} warn={counts.depositsOverdue > 0} />
        </ul>
      ) : null}

      <section aria-labelledby="properties-heading">
        <h2 id="properties-heading" className="text-sm font-semibold uppercase tracking-[0.15em] text-terracotta-deep">
          {hasGlobalScope(staff.actor) ? dict.ops.allProperties : dict.ops.propertiesTitle}
        </h2>
        {visible.length === 0 ? (
          <p className="mt-3 text-stone">{dict.ops.noProperties}</p>
        ) : (
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {visible.map((p) => (
              <li key={p.id} className="rounded-xl border border-line bg-white/70 p-5">
                <p className="font-display text-xl text-lagoon">{p.name}</p>
                <p className="mt-1 text-sm text-stone">{format(dict.ops.units, { count: p.units })}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="rounded-lg border border-dashed border-line px-4 py-3 text-sm text-stone">{dict.ops.comingNext}</p>
    </div>
  );
}

function Stat({ label, value, href, warn }: { label: string; value: number; href: string; warn?: boolean }) {
  return (
    <li>
      <Link href={href} className={`block rounded-xl border p-4 hover:bg-sand/40 ${warn ? "border-danger/40" : "border-line"} bg-white/70`}>
        <span className="block text-sm text-stone">{label}</span>
        <span className={`mt-1 block font-display text-3xl ${warn ? "text-danger" : "text-lagoon"}`}>{value}</span>
      </Link>
    </li>
  );
}
