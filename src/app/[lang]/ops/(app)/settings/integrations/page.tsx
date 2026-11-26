import { like, sql } from "drizzle-orm";
import { CalendarSync, CircleCheck, CircleDashed, CreditCard, KeyRound, Mail, MessageCircle, Search, Timer, TriangleExclamationPoint, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NoAccess } from "@/components/ops/ops-shell";
import { Card } from "@/components/ops/ui";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { channelStatus } from "@/lib/notifications/providers";
import { siteIndexable } from "@/lib/site/seo";
import { SettingsHeader, settingsContext } from "../shared";

export async function generateMetadata({ params }: PageProps<"/[lang]/ops/settings/integrations">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  return { title: `${dict.settings.tabs.integrations} · ${dict.settings.title}` };
}

export default async function IntegrationsPage({ params, searchParams }: PageProps<"/[lang]/ops/settings/integrations">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
      <Integrations lang={lang} dict={dict} searchParams={searchParams} />
    </Suspense>
  );
}

type Status = "on" | "off" | "warn";

/*
 * Only whether a key is present (and Xendit's mode, read from the key's
 * prefix) is shown; key values never leave the server.
 */
async function Integrations({ lang, dict, searchParams }: { lang: Locale; dict: Dictionary; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ctx = await settingsContext(lang, sp);
  if (!ctx.property) return <NoAccess lang={lang} dict={dict} staff={ctx.staff} />;
  const t = dict.settings.integrations;
  const channels = channelStatus();
  const xendit = process.env.XENDIT_SECRET_KEY;
  const db = getDb();
  const [[feeds], [demo]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.icalFeeds),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.staffMembers).where(like(schema.staffMembers.email, "demo-%@example.com")),
  ]);
  const from = process.env.EMAIL_FROM ?? "";
  const items: Array<{ key: string; icon: LucideIcon; name: string; status: Status; text: string }> = [
    { key: "email", icon: Mail, name: t.email.name, status: channels.email ? "on" : "off", text: channels.email ? format(t.email.on, { from }) : t.email.off },
    { key: "whatsapp", icon: MessageCircle, name: t.whatsapp.name, status: channels.whatsapp ? "on" : "off", text: channels.whatsapp ? t.whatsapp.on : t.whatsapp.off },
    {
      key: "payments",
      icon: CreditCard,
      name: t.payments.name,
      status: xendit && process.env.XENDIT_CALLBACK_TOKEN ? "on" : "off",
      text: xendit && process.env.XENDIT_CALLBACK_TOKEN ? (xendit.startsWith("xnd_production") ? t.payments.live : t.payments.test) : t.payments.off,
    },
    { key: "cron", icon: Timer, name: t.cron.name, status: process.env.CRON_SECRET ? "on" : "off", text: process.env.CRON_SECRET ? t.cron.on : t.cron.off },
    { key: "guestData", icon: KeyRound, name: t.guestData.name, status: process.env.GUEST_DATA_KEY ? "on" : "warn", text: process.env.GUEST_DATA_KEY ? t.guestData.on : t.guestData.off },
    { key: "seo", icon: Search, name: t.seo.name, status: siteIndexable() ? "on" : "off", text: siteIndexable() ? t.seo.on : t.seo.off },
    { key: "ical", icon: CalendarSync, name: t.ical.name, status: feeds.n ? "on" : "off", text: feeds.n ? format(t.ical.on, { count: feeds.n }) : t.ical.off },
    { key: "demo", icon: TriangleExclamationPoint, name: t.demo.name, status: demo.n ? "warn" : "on", text: demo.n ? t.demo.on : t.demo.off },
  ];
  const badge: Record<Status, { label: string; className: string; icon: LucideIcon }> = {
    on: { label: t.on, className: "bg-success/10 text-success", icon: CircleCheck },
    off: { label: t.off, className: "bg-sand text-stone", icon: CircleDashed },
    warn: { label: t.warn, className: "bg-terracotta/15 text-terracotta-deep", icon: TriangleExclamationPoint },
  };

  return (
    <>
      <SettingsHeader lang={lang} dict={dict} current="integrations" property={ctx.property} properties={ctx.properties} sp={sp} canProperties={ctx.canProperties} />
      <p className="mb-4 max-w-3xl text-sm text-stone">{t.intro}</p>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((i) => {
          const b = badge[i.status];
          return (
            <Card key={i.key}>
              <div className="flex items-start gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-lagoon-soft text-lagoon">
                  <i.icon className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-ink">{i.name}</h2>
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${b.className}`}>
                      <b.icon className="size-3.5" aria-hidden />
                      {b.label}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-stone">{i.text}</p>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-stone">{t.docs}</p>
    </>
  );
}
