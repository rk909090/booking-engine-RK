"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PropertyPicker } from "@/components/ops/property-picker";
import { inputClass } from "@/components/ops/ui";
import { SETTINGS_PATHS, SETTINGS_PER_PROPERTY, type SettingsTab } from "./tabs";

export type SettingsNavProps = {
  base: string;
  tabs: Array<{ key: SettingsTab; label: string }>;
  properties: Array<{ slug: string; name: string; isActive: boolean }>;
  t: { property: string; group: string; section: string; picker: { label: string; search: string; closed: string; noMatch: string } };
};

/**
 * The settings menu: the property sections under a property picker, then the
 * sections for the whole group. A list on wide screens, a picker and a
 * section select on phones. Stays tidy with any number of properties.
 */
export function SettingsNav({ base, tabs, properties, t }: SettingsNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useSearchParams();
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const current = (Object.keys(SETTINGS_PATHS) as SettingsTab[]).find((k) => SETTINGS_PATHS[k] === rest) ?? "profile";
  // Same choice as the pages make: the property in the address, else the first open one.
  const property = properties.find((p) => p.slug === params.get("property")) ?? properties.find((p) => p.isActive) ?? properties[0];
  const q = property ? `?property=${property.slug}` : "";
  const href = (tab: SettingsTab) => `${base}${SETTINGS_PATHS[tab]}${q}`;
  const perProperty = tabs.filter((tab) => SETTINGS_PER_PROPERTY.includes(tab.key));
  const group = tabs.filter((tab) => !SETTINGS_PER_PROPERTY.includes(tab.key));
  // Choosing a property opens the same section for it (or its profile, from a group section).
  const pickTab = SETTINGS_PER_PROPERTY.includes(current) ? current : "profile";
  const picker =
    perProperty.length && properties.length > 1 ? (
      <PropertyPicker
        label={t.picker.label}
        t={t.picker}
        align="start"
        className="w-full"
        options={properties.map((p) => ({ href: `${base}${SETTINGS_PATHS[pickTab]}?property=${p.slug}`, label: p.name, active: SETTINGS_PER_PROPERTY.includes(current) && p.slug === property?.slug, closed: !p.isActive }))}
      />
    ) : null;

  const link = (tab: { key: SettingsTab; label: string }) => (
    <li key={tab.key}>
      <Link
        href={href(tab.key)}
        aria-current={tab.key === current ? "page" : undefined}
        className={`relative block rounded-lg px-3 py-2 text-sm ${tab.key === current ? "bg-white font-medium text-lagoon shadow-sm" : "text-stone hover:bg-white/60 hover:text-ink"}`}
      >
        {tab.key === current ? <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-lagoon" /> : null}
        {tab.label}
      </Link>
    </li>
  );
  const heading = (text: string) => <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone">{text}</p>;

  return (
    <>
      {/* Phones and tablets: the property and the section as two choices. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:hidden">
        {picker}
        <label className="block">
          <span className="sr-only">{t.section}</span>
          <select value={current} onChange={(e) => router.push(href(e.target.value as SettingsTab))} className={inputClass}>
            {perProperty.length ? (
              <optgroup label={property ? `${t.property}: ${property.name}` : t.property}>
                {perProperty.map((tab) => (
                  <option key={tab.key} value={tab.key}>
                    {tab.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {group.length ? (
              <optgroup label={t.group}>
                {group.map((tab) => (
                  <option key={tab.key} value={tab.key}>
                    {tab.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </label>
      </div>

      {/* Wide screens: a menu beside the page. */}
      <nav aria-label={t.section} className="sticky top-8 hidden space-y-6 self-start lg:block">
        {perProperty.length ? (
          <div>
            {heading(t.property)}
            {picker ? <div className="mb-2">{picker}</div> : property ? <p className="mb-2 px-3 text-sm font-medium text-ink">{property.name}</p> : null}
            <ul className="space-y-0.5">{perProperty.map(link)}</ul>
          </div>
        ) : null}
        {group.length ? (
          <div>
            {heading(t.group)}
            <ul className="space-y-0.5">{group.map(link)}</ul>
          </div>
        ) : null}
      </nav>
    </>
  );
}
