import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorNote } from "@/components/ui";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import {
  cancelEarlyCheckinAction,
  cancelLateCheckoutAction,
  decideEarlyCheckinAction,
  decideLateCheckoutAction,
  requestEarlyCheckinAction,
  requestLateCheckoutAction,
} from "@/lib/ops/actions";

/** Late check-out or early check-in, in one shape for the card. */
export type TimeRequestView = {
  kind: "late" | "early";
  standardTime: string;
  turnoverMinutes: number;
  /** The neighbouring stay in the same villa: the next arrival (late) or the previous departure (early). */
  other: { code: string; guestName: string; time: string; source: string } | null;
  /** Latest check-out (late) or earliest check-in (early); null when no neighbouring stay. */
  limit: string | null;
  conflict: boolean;
  request: { status: string; requestedTime: string; fee: number; note: string | null; forDate: string; requestedBy?: string | null } | null;
  stale: boolean;
};

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

function shift(time: string, minutes: number) {
  const [h, m] = time.split(":").map(Number);
  const total = Math.min(23 * 60 + 30, Math.max(6 * 60, h * 60 + m + minutes));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Request, decide and withdraw a change of arrival or departure time, with the neighbouring stay in view. */
export function TimeRequest({
  lang,
  dict,
  code,
  date,
  view,
  canEdit,
}: {
  lang: Locale;
  dict: Dictionary;
  code: string;
  /** The departure (late) or arrival (early) date. */
  date: string;
  view: TimeRequestView;
  canEdit: boolean;
}) {
  const t = view.kind === "late" ? dict.lateCheckout : dict.earlyCheckin;
  const actions =
    view.kind === "late"
      ? { request: requestLateCheckoutAction, decide: decideLateCheckoutAction, cancel: cancelLateCheckoutAction }
      : { request: requestEarlyCheckinAction, decide: decideEarlyCheckinAction, cancel: cancelEarlyCheckinAction };
  const { request, other, stale } = view;
  const hidden: ReactNode = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
    </>
  );
  const sources = t.sources as Record<string, string>;
  const suggested = view.kind === "late" ? shift(view.standardTime, 30) : shift(view.standardTime, -120);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-stone">{format(t.standard, { time: view.standardTime, minutes: view.turnoverMinutes })}</p>
      {other ? (
        <p className="text-xs text-ink">
          {format(t.other, { code: other.code, guest: other.guestName, time: other.time })} ({sources[other.source] ?? other.source}).{" "}
          <strong>{format(t.limit, { time: view.limit ?? "" })}</strong>
        </p>
      ) : (
        <p className="text-xs text-ink">{format(t.noOther, { date: formatDate(date, lang) })}</p>
      )}

      {stale && request ? <ErrorNote>{format(t.stale, { date: formatDate(request.forDate, lang) })}</ErrorNote> : null}

      {request ? (
        <p className="font-medium text-ink">
          {format(request.status === "approved" ? t.approved : t.requested, { time: request.requestedTime.slice(0, 5) })}
          {request.status === "approved" && request.fee > 0 ? ` · ${format(t.feeCharged, { amount: formatMoney(request.fee, lang) })}` : ""}
          {request.requestedBy === "guest" ? <span className="block text-xs font-normal text-terracotta-deep">{t.byGuest}</span> : null}
          {request.note ? <span className="block text-xs font-normal text-stone">{request.note}</span> : null}
        </p>
      ) : null}

      {request && view.conflict && !stale ? (
        <div className="space-y-1">
          <ErrorNote>{format(request.status === "approved" ? t.conflictApproved : t.conflict, { time: view.limit ?? "" })}</ErrorNote>
          {other ? (
            <p className="text-xs text-stone">
              {t.moveHint}{" "}
              <Link href={`/${lang}/ops/reservations/${other.code}`} className="text-lagoon hover:underline">
                {format(t.openOther, { code: other.code })}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {canEdit && !request ? (
        <form action={actions.request} className="space-y-2">
          {hidden}
          <label className="block space-y-1 text-xs text-stone">
            <span>{t.time}</span>
            <input
              type="time"
              name="time"
              required
              step={1800}
              {...(view.kind === "late" ? { min: shift(view.standardTime, 30) } : { max: shift(view.standardTime, -30) })}
              defaultValue={suggested}
              className={input}
            />
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
        <form action={actions.decide} className="space-y-2">
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
              disabled={view.conflict}
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
        <form action={actions.cancel}>
          {hidden}
          <button type="submit" className="w-full rounded-lg border border-line px-4 py-2 text-sm text-ink hover:bg-sand">
            {t.cancel}
          </button>
        </form>
      ) : null}
    </div>
  );
}
