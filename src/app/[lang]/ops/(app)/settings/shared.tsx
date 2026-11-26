import Link from "next/link";
import { PageHeader, Segmented } from "@/components/ops/ui";
import { ErrorNote, SuccessNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";

export type SettingsTab = "profile" | "policies" | "content" | "villas" | "properties" | "integrations";
const PATHS: Record<SettingsTab, string> = { profile: "", policies: "/policies", content: "/content", villas: "/villas", properties: "/properties", integrations: "/integrations" };
/** Tabs about one property (they show the property switcher). */
const PER_PROPERTY: SettingsTab[] = ["profile", "policies", "content", "villas"];

/** Who is looking, which property, and whether they may change it. Null when settings are not for them. */
export async function settingsContext(lang: Locale, sp: Record<string, string | string[] | undefined>) {
  const staff = await requireStaff(lang);
  const canProperties = can(staff.actor, "properties.manage").allowed;
  if (!can(staff.actor, "settings.view").allowed) return { staff, property: null, properties: [], canManage: false, canProperties } as const;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "settings.view", p.id).allowed);
  const property = properties.find((p) => p.slug === sp.property) ?? properties[0] ?? null;
  const canManage = property ? can(staff.actor, "settings.manage", property.id).allowed : false;
  return { staff, property, properties, canManage, canProperties } as const;
}

export function SettingsHeader({
  lang,
  dict,
  current,
  property,
  properties,
  sp,
  canProperties = false,
}: {
  lang: Locale;
  dict: Dictionary;
  current: SettingsTab;
  property: { slug: string } | null;
  properties: ReadonlyArray<{ slug: string; name: string }>;
  sp: Record<string, string | string[] | undefined>;
  /** Show the "all properties" tab (properties.manage). */
  canProperties?: boolean;
}) {
  const t = dict.settings;
  const q = property ? `?property=${property.slug}` : "";
  const done = sp.done === "created" ? t.createdType : sp.done === "property" ? t.createdProperty : sp.done ? t.saved : undefined;
  const error = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.invalid) : undefined;
  return (
    <>
      <PageHeader
        title={t.title}
        description={t.intro}
        actions={
          properties.length > 1 && PER_PROPERTY.includes(current) ? (
            <Segmented label={dict.ops.allProperties} items={properties.map((p) => ({ href: `/${lang}/ops/settings${PATHS[current]}?property=${p.slug}`, label: p.name, active: p.slug === property?.slug }))} />
          ) : null
        }
      />
      <nav aria-label={t.title} className="mb-6 flex flex-wrap gap-1 border-b border-line">
        {(Object.keys(PATHS) as SettingsTab[])
          .filter((tab) => tab !== "properties" || canProperties)
          .map((tab) => (
          <Link
            key={tab}
            href={`/${lang}/ops/settings${PATHS[tab]}${q}`}
            aria-current={tab === current ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === current ? "border-lagoon font-medium text-lagoon" : "border-transparent text-stone hover:text-ink"}`}
          >
            {t.tabs[tab]}
          </Link>
          ))}
      </nav>
      <div className="mb-4 space-y-2">
        {done ? <SuccessNote>{done}</SuccessNote> : null}
        <ErrorNote>{error}</ErrorNote>
      </div>
    </>
  );
}

/** The fields every settings form sends back. */
export function SettingsHidden({ lang, property, anchor }: { lang: Locale; property: { id: string; slug: string }; anchor: string }) {
  return (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="property" value={property.slug} />
      <input type="hidden" name="propertyId" value={property.id} />
      <input type="hidden" name="anchor" value={anchor} />
    </>
  );
}

/** Percent shown from basis points, without trailing zeros (1050 -> "10.5"). */
export const pct = (bp: number) => String(bp / 100);
