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
import { authorize, canAccessProperty, hasGlobalScope } from "@/lib/authz/permissions";
import { SignOutButton } from "./_components/sign-out-button";

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
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-6 py-4 sm:px-10">
        <Link href={`/${lang}/ops`} className="font-display text-xl text-lagoon">
          {brand.name} <span className="text-sm text-stone">· {dict.ops.title}</span>
        </Link>
      </header>
      <main className="flex-1 px-6 py-10 sm:px-10">
        <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
          <StaffHome lang={lang} dict={dict} />
        </Suspense>
      </main>
    </div>
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

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl text-lagoon">{format(dict.ops.welcome, { name: staff.fullName })}</h1>
          <p className="mt-1 text-sm text-stone">
            {dict.ops.role}: {dict.ops.roles[staff.role]} · {staff.email}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/${lang}/ops/security`}
            className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink hover:bg-sand"
          >
            {dict.ops.security}
          </Link>
          <SignOutButton lang={lang} label={dict.ops.signOut} />
        </div>
      </div>

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
