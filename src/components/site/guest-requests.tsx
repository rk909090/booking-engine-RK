import { ErrorNote, SuccessNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDateRange, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { cancelDateChangeFromPortal, cancelEarlyCheckinFromPortal, requestDateChangeFromPortal, requestEarlyCheckinFromPortal } from "@/lib/booking/actions";

/*
 * Guest requests on the booking page besides late check-out: arriving early
 * (from the times still possible) and changing dates (estimate first, then a
 * request staff approve). Staff decide both.
 */

type Hidden = { lang: Locale; code: string; token: string | undefined };
const field = "w-full rounded-lg border border-line bg-white px-3 py-2.5 text-ink";

function HiddenFields({ lang, code, token }: Hidden) {
  return (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="t" value={token} />
    </>
  );
}

function Message({ text, ok }: { text: string | undefined; ok: boolean }) {
  if (!text) return null;
  return ok ? <SuccessNote>{text}</SuccessNote> : <ErrorNote>{text}</ErrorNote>;
}

export function EarlyCheckinSection({
  dict,
  hidden,
  early,
  message,
}: {
  dict: Dictionary;
  hidden: Hidden;
  early: { standardCheckIn: string; request: { status: string; time: string; fee: number } | null; times: string[] };
  message: { code: string | undefined };
}) {
  const t = dict.portal;
  const text = message.code ? ((t.earlyMessages as Record<string, string>)[message.code] ?? t.earlyMessages.not_allowed) : undefined;
  return (
    <section id="early" className="scroll-mt-6 rounded-2xl border border-line p-5" aria-labelledby="early-title">
      <h2 id="early-title" className="font-display text-xl text-lagoon">
        {t.earlyTitle}
      </h2>
      <Message text={text} ok={message.code === "sent" || message.code === "withdrawn"} />
      {early.request?.status === "requested" ? (
        <div className="mt-2 space-y-3 text-sm text-ink">
          <p>{format(t.earlyRequested, { time: early.request.time })}</p>
          <form action={cancelEarlyCheckinFromPortal}>
            <HiddenFields {...hidden} />
            <button type="submit" className="rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
              {t.withdraw}
            </button>
          </form>
        </div>
      ) : early.request?.status === "approved" ? (
        <p className="mt-2 text-sm font-medium text-ink">
          {early.request.fee > 0 ? format(t.earlyApprovedFee, { time: early.request.time, amount: formatMoney(early.request.fee, hidden.lang) }) : format(t.earlyApproved, { time: early.request.time })}
        </p>
      ) : (
        <div className="mt-2 space-y-3 text-sm text-ink">
          {early.request?.status === "declined" ? <p>{format(t.earlyDeclined, { time: early.request.time })}</p> : null}
          {early.times.length ? (
            <form action={requestEarlyCheckinFromPortal} className="space-y-3">
              <p className="text-stone">{format(t.earlyIntro, { time: early.standardCheckIn })}</p>
              <HiddenFields {...hidden} />
              <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
                <label className="space-y-1.5 font-medium">
                  <span className="block">{t.earlyTime}</span>
                  <select name="time" required defaultValue={early.times[early.times.length - 1]} className={field}>
                    {early.times.map((time) => (
                      <option key={time} value={time}>
                        {time}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1.5 font-medium">
                  <span className="block">{t.note}</span>
                  <input name="note" maxLength={500} className={field} />
                </label>
              </div>
              <button type="submit" className="rounded-lg bg-lagoon px-4 py-2.5 font-medium text-ivory hover:bg-lagoon-deep">
                {t.sendRequest}
              </button>
            </form>
          ) : (
            <p className="text-stone">{t.earlyNone}</p>
          )}
        </div>
      )}
    </section>
  );
}

export type DateChangeView = {
  request: { status: string; checkIn: string; checkOut: string; quotedTotal: number | null; declineReason: string | null } | null;
  /** The estimate for dates the guest is looking at (from the URL), if any. */
  preview:
    | { checkIn: string; checkOut: string; ok: true; sameVilla: boolean; total: number | null; difference: number | null }
    | { checkIn: string; checkOut: string; ok: false; error: string; minNights?: number; maxNights?: number }
    | null;
  current: { checkIn: string; checkOut: string; total: number };
  today: string;
};

export function DateChangeSection({ dict, hidden, view, message }: { dict: Dictionary; hidden: Hidden; view: DateChangeView; message: { code: string | undefined } }) {
  const t = dict.portal;
  const lang = hidden.lang;
  const money = (n: number) => formatMoney(n, lang);
  const text = message.code ? ((t.dateMessages as Record<string, string>)[message.code] ?? (t.dateErrors as Record<string, string>)[message.code] ?? t.dateErrors.not_allowed) : undefined;
  const p = view.preview;
  const open = view.request?.status === "requested";
  return (
    <section id="dates" className="scroll-mt-6 rounded-2xl border border-line p-5" aria-labelledby="dates-title">
      <h2 id="dates-title" className="font-display text-xl text-lagoon">
        {t.datesTitle}
      </h2>
      <Message text={text} ok={message.code === "sent" || message.code === "withdrawn"} />
      {open && view.request ? (
        <div className="mt-2 space-y-3 text-sm text-ink">
          <p>
            {format(t.datesRequested, { dates: formatDateRange(view.request.checkIn, view.request.checkOut, lang) })}
            {view.request.quotedTotal !== null ? ` ${format(t.datesEstimate, { total: money(view.request.quotedTotal) })}` : ` ${t.datesOtherVilla}`}
          </p>
          <form action={cancelDateChangeFromPortal}>
            <HiddenFields {...hidden} />
            <button type="submit" className="rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
              {t.withdraw}
            </button>
          </form>
        </div>
      ) : (
        <div className="mt-2 space-y-3 text-sm text-ink">
          {view.request?.status === "declined" ? (
            <p>
              {format(t.datesDeclined, { dates: formatDateRange(view.request.checkIn, view.request.checkOut, lang) })}
              {view.request.declineReason ? ` (${view.request.declineReason})` : ""}
            </p>
          ) : null}
          <p className="text-stone">{t.datesIntro}</p>
          {/* Dates in the URL are not personal data; each change re-estimates on the server. */}
          <form method="get" action="#dates" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="t" value={hidden.token} />
            <label className="space-y-1.5 font-medium">
              <span className="block">{dict.search.checkIn}</span>
              <input type="date" name="ci" required min={view.today} defaultValue={p?.checkIn ?? view.current.checkIn} className={field} />
            </label>
            <label className="space-y-1.5 font-medium">
              <span className="block">{dict.search.checkOut}</span>
              <input type="date" name="co" required min={view.today} defaultValue={p?.checkOut ?? view.current.checkOut} className={field} />
            </label>
            <button type="submit" className="rounded-lg border border-lagoon px-4 py-2.5 font-medium text-lagoon hover:bg-lagoon-soft">
              {t.datesCheck}
            </button>
          </form>
          {p && p.ok ? (
            <form action={requestDateChangeFromPortal} className="space-y-3 rounded-xl bg-sand/60 p-4">
              <HiddenFields {...hidden} />
              <input type="hidden" name="checkIn" value={p.checkIn} />
              <input type="hidden" name="checkOut" value={p.checkOut} />
              <p className="font-medium">{formatDateRange(p.checkIn, p.checkOut, lang)}</p>
              {p.sameVilla && p.total !== null && p.difference !== null ? (
                <p>
                  {format(t.datesNewTotal, { total: money(p.total) })}{" "}
                  <span className="text-stone">
                    {p.difference > 0 ? format(t.datesMore, { amount: money(p.difference) }) : p.difference < 0 ? format(t.datesLess, { amount: money(-p.difference) }) : t.datesSame}
                  </span>
                </p>
              ) : (
                <p>{t.datesOtherVilla}</p>
              )}
              <label className="block space-y-1.5 font-medium">
                <span className="block">{t.note}</span>
                <input name="note" maxLength={500} className={field} />
              </label>
              <p className="text-xs text-stone">{t.datesFinePrint}</p>
              <button type="submit" className="rounded-lg bg-lagoon px-4 py-2.5 font-medium text-ivory hover:bg-lagoon-deep">
                {t.sendRequest}
              </button>
            </form>
          ) : p && !p.ok ? (
            <p role="alert" className="text-danger">
              {format((t.dateErrors as Record<string, string>)[p.error] ?? t.dateErrors.not_allowed, { nights: p.minNights ?? p.maxNights ?? "" })}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
