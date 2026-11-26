import { ErrorNote, SuccessNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { visibleProperties } from "@/lib/ops/queries";
import { SETTINGS_PER_PROPERTY, type SettingsTab } from "./tabs";

export type { SettingsTab } from "./tabs";

/** Who is looking, which property, and whether they may change it. Null when settings are not for them. */
export async function settingsContext(lang: Locale, sp: Record<string, string | string[] | undefined>) {
  const staff = await requireStaff(lang);
  const canProperties = can(staff.actor, "properties.manage").allowed;
  // The sign-in switches belong to whoever manages users (directors).
  const canAccess = can(staff.actor, "users.manage").allowed;
  if (!can(staff.actor, "settings.view").allowed) return { staff, property: null, properties: [], canManage: false, canProperties, canAccess } as const;
  const properties = (await visibleProperties(staff.actor)).filter((p) => can(staff.actor, "settings.view", p.id).allowed);
  const property = properties.find((p) => p.slug === sp.property) ?? properties.find((p) => p.isActive) ?? properties[0] ?? null;
  const canManage = property ? can(staff.actor, "settings.manage", property.id).allowed : false;
  return { staff, property, properties, canManage, canProperties, canAccess } as const;
}

/**
 * The top of a settings section: its name (with the property for property
 * sections) and the result of the last save. The page title and the menu
 * come from the settings layout.
 */
export function SettingsHeader({
  dict,
  current,
  property,
  sp,
}: {
  lang: Locale;
  dict: Dictionary;
  current: SettingsTab;
  property: { slug: string; name?: string } | null;
  properties: ReadonlyArray<{ slug: string; name: string }>;
  sp: Record<string, string | string[] | undefined>;
  canProperties?: boolean;
  canAccess?: boolean;
}) {
  const t = dict.settings;
  const done = sp.done === "created" ? t.createdType : sp.done === "property" ? t.createdProperty : sp.done === "deleted" ? t.deletedProperty : sp.done ? t.saved : undefined;
  const error = typeof sp.error === "string" ? ((t.errors as Record<string, string>)[sp.error] ?? t.errors.invalid) : undefined;
  return (
    <>
      <h2 className="mb-4 flex flex-wrap items-baseline gap-x-2 font-display text-2xl text-ink">
        {t.tabs[current]}
        {SETTINGS_PER_PROPERTY.includes(current) && property?.name ? <span className="text-lg text-stone">· {property.name}</span> : null}
      </h2>
      <div className="mb-4 space-y-2 empty:hidden">
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
