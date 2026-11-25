import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorNote } from "@/components/ui";
import type { lateCheckoutStatus } from "@/domain/late-checkout";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { cancelLateCheckoutAction, decideLateCheckoutAction, requestLateCheckoutAction } from "@/lib/ops/actions";

type Status = NonNullable<Awaited<ReturnType<typeof lateCheckoutStatus>>>;

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";
const add30 = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + 30;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** Request, decide and withdraw a late check-out, with the next arrival in view. */
export function LateCheckout({
  lang,
  dict,
  code,
  checkOut,
  status,
  canEdit,
}: {
  lang: Locale;
  dict: Dictionary;
  code: string;
  checkOut: string;
  status: Status;
  canEdit: boolean;
}) {
  const t = dict.lateCheckout;
  const { request, check, stale } = status;
  const hidden: ReactNode = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
    </>
  );
  const next = check.nextArrival;

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-stone">{format(t.standard, { time: check.standardCheckOut, minutes: check.turnoverMinutes })}</p>
      {next ? (
        <p className="text-xs text-ink">
          {format(t.nextArrival, { code: next.code, guest: next.guestName, time: next.arrivalTime })} ({next.etaKnown ? t.etaGuest : t.etaStandard}).{" "}
          <strong>{format(t.latest, { time: check.latestAllowed ?? "" })}</strong>
        </p>
      ) : (
        <p className="text-xs text-ink">{format(t.noArrival, { date: formatDate(checkOut, lang) })}</p>
      )}

      {stale && request ? <ErrorNote>{format(t.stale, { date: formatDate(request.forDate, lang) })}</ErrorNote> : null}

      {request ? (
        <p className="font-medium text-ink">
          {format(request.status === "approved" ? t.approved : t.requested, { time: request.requestedTime.slice(0, 5) })}
          {request.status === "approved" && request.fee > 0 ? ` · ${format(t.feeCharged, { amount: formatMoney(request.fee, lang) })}` : ""}
          {request.note ? <span className="block text-xs font-normal text-stone">{request.note}</span> : null}
        </p>
      ) : null}

      {request && check.conflict && !stale ? (
        <div className="space-y-1">
          <ErrorNote>{format(request.status === "approved" ? t.conflictApproved : t.conflict, { time: check.latestAllowed ?? "" })}</ErrorNote>
          {next ? (
            <p className="text-xs text-stone">
              {t.moveHint}{" "}
              <Link href={`/${lang}/ops/reservations/${next.code}`} className="text-lagoon hover:underline">
                {format(t.openNext, { code: next.code })}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {canEdit && !request ? (
        <form action={requestLateCheckoutAction} className="space-y-2">
          {hidden}
          <label className="block space-y-1 text-xs text-stone">
            <span>{t.time}</span>
            <input type="time" name="time" required step={1800} min={add30(check.standardCheckOut)} defaultValue={add30(check.standardCheckOut)} className={input} />
          </label>
          <label className="block space-y-1 text-xs text-stone">
            <span>{t.note}</span>
            <input name="note" maxLength={500} className={input} />
          </label>
          <button type="submit" className="w-full rounded-lg border border-lagoon px-4 py-2 text-sm font-medium text-lagoon hover:bg-lagoon-soft">
            {t.request}
          </button>
        </form>
      ) : null}

      {canEdit && request?.status === "requested" && !stale ? (
        <form action={decideLateCheckoutAction} className="space-y-2">
          {hidden}
          <label className="block space-y-1 text-xs text-stone">
            <span>{t.fee}</span>
            <input name="fee" inputMode="numeric" defaultValue="0" className={input} />
          </label>
          <label className="block space-y-1 text-xs text-stone">
            <span>{t.decisionNote}</span>
            <input name="note" maxLength={500} className={input} />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              name="decision"
              value="approve"
              disabled={check.conflict}
              className="flex-1 rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep disabled:cursor-not-allowed disabled:bg-stone/40"
            >
              {t.approve}
            </button>
            <button type="submit" name="decision" value="decline" className="flex-1 rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5">
              {t.decline}
            </button>
          </div>
        </form>
      ) : null}

      {canEdit && request && (request.status === "approved" || stale) ? (
        <form action={cancelLateCheckoutAction}>
          {hidden}
          <button type="submit" className="w-full rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
            {t.cancel}
          </button>
        </form>
      ) : null}
    </div>
  );
}
