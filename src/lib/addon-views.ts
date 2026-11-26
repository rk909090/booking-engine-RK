import type * as schema from "@/db/schema";
import type { AddonView } from "@/components/addon-fields";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";

/** Add-ons as shown to a guest or staff member: name in their language and the price with its unit. */
export function addonViews(addons: Array<typeof schema.addons.$inferSelect>, lang: Locale, dict: Dictionary): AddonView[] {
  const units = dict.addons.pricing as Record<string, string>;
  return addons.map((a) => ({
    id: a.id,
    name: a.name[lang] || a.name.id,
    description: a.description?.[lang] || null,
    pricing: a.pricing,
    price: format(units[a.pricing] ?? "{price}", { price: formatMoney(a.price, lang) }),
    needsTime: a.needsTime,
    leadHours: a.leadHours,
  }));
}
