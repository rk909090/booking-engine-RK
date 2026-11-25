import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/get-dictionary";

export type SearchValues = {
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  property?: string;
};

const selectClass = "w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink";

/** Plain GET form to the results page: works without JavaScript. */
export function SearchForm({
  lang,
  t,
  properties,
  values = {},
}: {
  lang: Locale;
  t: Dictionary["search"];
  properties: Array<{ slug: string; name: string }>;
  values?: SearchValues;
}) {
  return (
    <form
      action={`/${lang}/stay`}
      method="get"
      className="grid gap-3 rounded-2xl border border-line bg-white/80 p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_0.7fr_0.7fr_auto] lg:items-end"
    >
      <label className="space-y-1 text-sm">
        <span className="font-medium text-ink">{t.destination}</span>
        <select name="property" defaultValue={values.property ?? ""} className={selectClass}>
          <option value="">{t.anyDestination}</option>
          {properties.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium text-ink">{t.checkIn}</span>
        <input type="date" name="checkIn" required defaultValue={values.checkIn} className={selectClass} />
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium text-ink">{t.checkOut}</span>
        <input type="date" name="checkOut" required defaultValue={values.checkOut} className={selectClass} />
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium text-ink">{t.adults}</span>
        <select name="adults" defaultValue={String(values.adults ?? 2)} className={selectClass}>
          {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-sm">
        <span className="font-medium text-ink">{t.children}</span>
        <select name="children" defaultValue={String(values.children ?? 0)} className={selectClass}>
          {Array.from({ length: 7 }, (_, i) => i).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="rounded-lg bg-lagoon px-5 py-2.5 font-medium text-ivory hover:bg-lagoon-deep sm:col-span-2 lg:col-span-1"
      >
        {t.submit}
      </button>
    </form>
  );
}
