import type { Dictionary } from "@/i18n/get-dictionary";

/*
 * The inputs of one add-on order: the day (within the stay, departure day
 * included), the time when the add-on needs one, and the persons, nights or
 * quantity its pricing counts. Plain markup, so the checkout (a client form),
 * the guest's booking page and the staff reservation page share it.
 */

export type AddonView = {
  id: string;
  name: string;
  description: string | null;
  pricing: string;
  price: string;
  needsTime: boolean;
  leadHours: number;
};

const box = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

export function AddonFields({
  addon,
  prefix,
  t,
  dates,
  guests,
  nights,
}: {
  addon: AddonView;
  prefix: string;
  t: Dictionary["addons"];
  dates: Array<{ value: string; label: string }>;
  guests: number;
  nights: number;
}) {
  const perPerson = addon.pricing === "per_person" || addon.pricing === "per_person_night";
  const perNight = addon.pricing === "per_night" || addon.pricing === "per_person_night";
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  return (
    <div className="grid gap-2 sm:grid-cols-4">
      <label className="space-y-1 text-xs text-stone">
        <span className="block">{t.day}</span>
        <select name={`${prefix}date`} defaultValue={dates[Math.min(1, dates.length - 1)]?.value} className={box}>
          {dates.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {addon.needsTime ? (
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.time}</span>
          <input type="time" name={`${prefix}time`} defaultValue="19:00" className={box} />
        </label>
      ) : null}
      {perPerson ? (
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.persons}</span>
          <select name={`${prefix}persons`} defaultValue={guests} className={box}>
            {range(guests).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {perNight ? (
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.nights}</span>
          <select name={`${prefix}nights`} defaultValue={nights} className={box}>
            {range(nights).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {addon.pricing === "per_booking" ? (
        <label className="space-y-1 text-xs text-stone">
          <span className="block">{t.quantity}</span>
          <select name={`${prefix}quantity`} defaultValue={1} className={box}>
            {range(10).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="space-y-1 text-xs text-stone sm:col-span-4">
        <span className="block">{t.note}</span>
        <input name={`${prefix}note`} maxLength={500} placeholder={t.notePlaceholder} className={box} />
      </label>
    </div>
  );
}
