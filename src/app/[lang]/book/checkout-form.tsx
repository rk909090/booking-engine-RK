"use client";

import { useActionState, useState } from "react";
import { AddonFields, type AddonView } from "@/components/addon-fields";
import { ErrorNote, Field, PrimaryButton } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import type { Dictionary } from "@/i18n/get-dictionary";
import { startBooking, type StartBookingState } from "@/lib/booking/actions";

export function CheckoutForm({
  lang,
  t,
  stay,
  holdMinutes,
  addons,
}: {
  lang: Locale;
  t: Dictionary["checkout"];
  stay: { unitTypeId: string; checkIn: string; checkOut: string; adults: number; children: number; ratePlan: string; promo: string };
  holdMinutes: number;
  addons: { items: AddonView[]; dates: Array<{ value: string; label: string }>; guests: number; nights: number; t: Dictionary["addons"] };
}) {
  const [state, action, pending] = useActionState<StartBookingState, FormData>(startBooking, {});
  const [chosen, setChosen] = useState<string[]>([]);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="unitTypeId" value={stay.unitTypeId} />
      <input type="hidden" name="checkIn" value={stay.checkIn} />
      <input type="hidden" name="checkOut" value={stay.checkOut} />
      <input type="hidden" name="adults" value={stay.adults} />
      <input type="hidden" name="children" value={stay.children} />
      <input type="hidden" name="ratePlan" value={stay.ratePlan} />
      <input type="hidden" name="promo" value={stay.promo} />

      <Field label={t.fullName} name="fullName" autoComplete="name" required maxLength={120} />
      <Field label={t.email} name="email" type="email" autoComplete="email" required hint={t.emailHint} maxLength={200} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.phone} name="phone" type="tel" autoComplete="tel" maxLength={40} />
        <Field label={t.country} name="country" autoComplete="country" maxLength={2} />
      </div>
      <Field label={t.arrival} name="arrival" type="time" />
      <div className="space-y-1.5">
        <label htmlFor="requests" className="block text-sm font-medium text-ink">
          {t.requests}
        </label>
        <textarea
          id="requests"
          name="requests"
          rows={3}
          maxLength={2000}
          className="w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink outline-none focus:border-lagoon focus:ring-2 focus:ring-lagoon/20"
        />
      </div>
      {addons.items.length ? (
        <fieldset className="space-y-3 rounded-xl border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">{addons.t.checkoutTitle}</legend>
          <p className="text-xs text-stone">{addons.t.checkoutIntro}</p>
          {addons.items.map((a) => {
            const on = chosen.includes(a.id);
            return (
              <div key={a.id} className={`rounded-lg border p-3 ${on ? "border-lagoon bg-lagoon-soft/40" : "border-line"}`}>
                <label className="flex items-start gap-3 text-sm text-ink">
                  <input
                    type="checkbox"
                    name={`addon_${a.id}_on`}
                    checked={on}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id)))}
                    className="mt-1 h-4 w-4 accent-lagoon"
                  />
                  <span className="flex-1">
                    <span className="flex flex-wrap justify-between gap-2 font-medium">
                      <span>{a.name}</span>
                      <span className="text-stone">{a.price}</span>
                    </span>
                    {a.description ? <span className="block text-xs text-stone">{a.description}</span> : null}
                  </span>
                </label>
                {on ? (
                  <div className="mt-3 pl-7">
                    <AddonFields addon={a} prefix={`addon_${a.id}_`} t={addons.t} dates={addons.dates} guests={addons.guests} nights={addons.nights} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}
      <label className="flex items-start gap-3 text-sm text-ink">
        <input type="checkbox" name="agree" required className="mt-1 h-4 w-4 accent-lagoon" />
        <span>{t.agree}</span>
      </label>
      <ErrorNote>{state.error === "addon" && state.addonError ? (addons.t.errors as Record<string, string>)[state.addonError] : state.error ? t.errors[state.error] : null}</ErrorNote>
      {/* A choice made above (plan, promo) re-renders this form with new hidden values. */}
      <p className="text-xs text-stone">{format(t.holdNotice, { minutes: holdMinutes })}</p>
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? t.working : t.submit}
      </PrimaryButton>
    </form>
  );
}
