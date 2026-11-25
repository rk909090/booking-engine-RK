"use client";

import { useActionState, type ReactNode } from "react";
import { ErrorNote, PrimaryButton } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import type { Dictionary } from "@/i18n/get-dictionary";
import { savePreCheckinFromPortal, type PreCheckinFormState } from "@/lib/booking/actions";

type Saved = {
  arrivalTime: string;
  flightNumber: string;
  landingDate: string;
  landingTime: string;
  transferRequested: boolean;
  transferNote: string;
  requests: string;
  guests: Array<{ fullName: string; nationality: string; birthDate: string; documentType: string | null; documentLast4: string | null }>;
};

type Props = {
  lang: Locale;
  code: string;
  token: string;
  adults: number;
  checkIn: string;
  today: string;
  saved: Saved | null;
  countries: Array<[string, string]>;
  houseRules: string[];
  t: Dictionary["preCheckin"];
};

const box = "w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink outline-none focus:border-lagoon focus:ring-2 focus:ring-lagoon/20";

/** The guest's online pre-check-in. Values come back after an error, document numbers never do. */
export function PreCheckinForm(props: Props) {
  const [state, action, pending] = useActionState<PreCheckinFormState, FormData>(savePreCheckinFromPortal, {});
  return <Fields key={JSON.stringify(state)} {...props} state={state} action={action} pending={pending} />;
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function Fields({ lang, code, token, adults, checkIn, today, saved, countries, houseRules, t, state, action, pending }: Props & { state: PreCheckinFormState; action: (f: FormData) => void; pending: boolean }) {
  const v = state.values;
  const val = (key: string, fallback: string) => (v ? (v[key] ?? "") : fallback);
  const e = state.error;
  const errorText = !e
    ? null
    : e.kind === "guest"
      ? format(t.errors.guest, { n: e.index + 1, field: t.fields[e.field] })
      : e.kind === "guest_count"
        ? format(t.errors.guest_count, { count: e.expected })
        : t.errors[e.kind];
  const invalid = (i: number, field: string) => e?.kind === "guest" && e.index === i && e.field === field;

  return (
    <form action={action} className="space-y-5 text-sm">
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="t" value={token} />
      <input type="hidden" name="guestCount" value={adults} />

      <fieldset className="space-y-3">
        <legend className="font-medium text-ink">{t.arrivalTitle}</legend>
        <div className="grid gap-3 sm:grid-cols-4">
          <Label text={t.arrival}>
            <input type="time" name="arrival" defaultValue={val("arrival", saved?.arrivalTime ?? "")} className={box} />
          </Label>
          <Label text={t.flight}>
            <input name="flight" maxLength={10} placeholder="GA 404" autoComplete="off" defaultValue={val("flight", saved?.flightNumber ?? "")} className={box} />
          </Label>
          <Label text={t.landingDate}>
            <input type="date" name="landingDate" min={addDays(checkIn, -2)} max={checkIn} defaultValue={val("landingDate", saved?.landingDate ?? "")} className={box} />
          </Label>
          <Label text={t.landingTime}>
            <input type="time" name="landingTime" defaultValue={val("landingTime", saved?.landingTime ?? "")} className={box} />
          </Label>
        </div>
        <label className="flex items-start gap-2 text-ink">
          <input type="checkbox" name="transfer" defaultChecked={v ? v.transfer === "on" : (saved?.transferRequested ?? false)} className="mt-1 h-4 w-4 accent-lagoon" />
          <span>
            {t.transfer}
            <span className="block text-xs text-stone">{t.transferHint}</span>
          </span>
        </label>
        <Label text={t.transferNote}>
          <input name="transferNote" maxLength={300} defaultValue={val("transferNote", saved?.transferNote ?? "")} className={box} />
        </Label>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="font-medium text-ink">{format(t.guestsTitle, { count: adults })}</legend>
        <p className="text-xs text-stone">{t.guestsHint}</p>
        {Array.from({ length: adults }, (_, i) => {
          const g = saved?.guests[i];
          return (
            <div key={i} className="space-y-3 rounded-xl border border-line p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{format(t.guestN, { n: i + 1 })}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Label text={t.fields.fullName} invalid={invalid(i, "fullName")}>
                  <input name={`g${i}_name`} required maxLength={120} autoComplete="off" defaultValue={val(`g${i}_name`, g?.fullName ?? "")} className={box} />
                </Label>
                <Label text={t.fields.nationality} invalid={invalid(i, "nationality")}>
                  <select name={`g${i}_nationality`} required defaultValue={val(`g${i}_nationality`, g?.nationality ?? "")} className={box}>
                    <option value="">{t.choose}</option>
                    {countries.map(([c, name]) => (
                      <option key={c} value={c}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Label>
                <Label text={t.fields.birthDate} invalid={invalid(i, "birthDate")}>
                  <input type="date" name={`g${i}_birth`} required min="1900-01-01" max={today} defaultValue={val(`g${i}_birth`, g?.birthDate ?? "")} className={box} />
                </Label>
                <Label text={t.fields.documentType} invalid={invalid(i, "documentType")}>
                  <select name={`g${i}_docType`} required defaultValue={val(`g${i}_docType`, g?.documentType ?? "passport")} className={box}>
                    <option value="passport">{t.passport}</option>
                    <option value="id_card">{t.idCard}</option>
                  </select>
                </Label>
                <div className="sm:col-span-2">
                  <Label text={t.fields.documentNumber} invalid={invalid(i, "documentNumber")}>
                    <input
                      name={`g${i}_docNumber`}
                      required={!g?.documentLast4}
                      maxLength={30}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={g?.documentLast4 ? format(t.docSaved, { last4: g.documentLast4 }) : ""}
                      className={box}
                    />
                  </Label>
                </div>
              </div>
            </div>
          );
        })}
        <p className="text-xs text-stone">{t.privacy}</p>
      </fieldset>

      <Label text={t.requests}>
        <textarea name="requests" rows={3} maxLength={1000} placeholder={t.requestsHint} defaultValue={val("requests", saved?.requests ?? "")} className={box} />
      </Label>

      <fieldset className="space-y-2 rounded-xl bg-sand/60 p-4">
        <legend className="sr-only">{t.rulesTitle}</legend>
        <p className="font-medium text-ink">{t.rulesTitle}</p>
        <ul className="list-disc space-y-1 pl-5 text-ink">
          {houseRules.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <label className="flex items-start gap-2 pt-1 text-ink">
          <input type="checkbox" name="rules" required defaultChecked={v?.rules === "on"} className="mt-1 h-4 w-4 accent-lagoon" />
          <span>{t.rulesAccept}</span>
        </label>
      </fieldset>

      <ErrorNote>{errorText}</ErrorNote>
      <PrimaryButton type="submit" disabled={pending}>
        {pending ? t.working : saved ? t.update : t.submit}
      </PrimaryButton>
    </form>
  );
}

function Label({ text, invalid, children }: { text: string; invalid?: boolean; children: ReactNode }) {
  return (
    <label className={`block space-y-1.5 font-medium ${invalid ? "text-danger" : "text-ink"}`}>
      <span className="block">{text}</span>
      {children}
    </label>
  );
}
