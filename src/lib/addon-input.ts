import type { AddonChoice } from "@/domain/addons";

/** Reads one add-on order from a form (fields named `${prefix}date`, `${prefix}time`, ...). */
export function parseAddonChoice(form: FormData, prefix: string, addonId: string): AddonChoice {
  const get = (k: string) => {
    const v = form.get(`${prefix}${k}`);
    return typeof v === "string" ? v.trim() : "";
  };
  const num = (k: string) => (get(k) ? Number(get(k)) : undefined);
  return { addonId, serviceDate: get("date"), serviceTime: get("time") || null, persons: num("persons"), nights: num("nights"), quantity: num("quantity"), note: get("note") || null };
}

/** Add-ons ticked on the checkout form (`addon_<id>_on`). */
export function parseCheckoutAddons(form: FormData): AddonChoice[] {
  const ids = [...form.keys()].map((k) => /^addon_([0-9a-f-]{36})_on$/i.exec(k)?.[1]).filter((x): x is string => Boolean(x));
  return [...new Set(ids)].slice(0, 10).map((id) => parseAddonChoice(form, `addon_${id}_`, id));
}

/** Days an add-on can be booked for: check-in to check-out, inclusive. */
export function stayDays(checkIn: string, checkOut: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${checkIn}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    out.push(iso);
    if (iso >= checkOut || out.length > 60) break;
  }
  return out;
}
