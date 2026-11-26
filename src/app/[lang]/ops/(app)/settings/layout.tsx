import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { PageHeader } from "@/components/ops/ui";
import { hasLocale, type Locale } from "@/i18n/config";
import { getDictionary, type Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";
import { SettingsNav } from "./settings-nav";
import type { SettingsTab } from "./tabs";

/** Every settings page: the title, the settings menu on the left and the section on the right. */
export default async function SettingsLayout({ children, params }: LayoutProps<"/[lang]/ops/settings">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  return (
    <>
      <PageHeader title={dict.settings.title} description={dict.settings.intro} />
      <Suspense fallback={<p className="text-sm text-stone">{dict.ops.loading}</p>}>
        <SettingsFrame lang={lang} dict={dict}>
          {children}
        </SettingsFrame>
      </Suspense>
    </>
  );
}

/** Reads who is looking to show only the sections they may open. */
async function SettingsFrame({ lang, dict, children }: { lang: Locale; dict: Dictionary; children: ReactNode }) {
  const staff = await requireStaff(lang);
  const t = dict.settings;
  const canView = can(staff.actor, "settings.view").allowed;
  const properties = canView ? (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "settings.view", p.id).allowed) : [];
  const allowed: Record<SettingsTab, boolean> = {
    profile: properties.length > 0,
    policies: properties.length > 0,
    content: properties.length > 0,
    villas: properties.length > 0,
    properties: can(staff.actor, "properties.manage").allowed,
    access: can(staff.actor, "users.manage").allowed,
    integrations: properties.length > 0,
  };
  const tabs = (Object.keys(allowed) as SettingsTab[]).filter((k) => allowed[k]).map((key) => ({ key, label: t.tabs[key] }));
  // Nothing to choose from: the page says why.
  if (!tabs.length) return <>{children}</>;
  return (
    <div className="lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
      <SettingsNav
        base={`/${lang}/ops/settings`}
        tabs={tabs}
        properties={properties.map((p) => ({ slug: p.slug, name: p.name, isActive: p.isActive }))}
        t={{ property: t.groups.property, group: t.groups.group, section: t.section, picker: dict.ops.picker }}
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
