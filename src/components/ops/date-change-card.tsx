import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDateRange, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { approveDateChangeAction, declineDateChangeAction } from "@/lib/ops/date-change-actions";

const input = "w-full rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink";

/** A guest's open date change request with the price now, a villa to put them in, and approve or decline. */
export function DateChangeCard({
  lang,
  dict,
  code,
  request,
  preview,
  villas,
  canDecide,
}: {
  lang: Locale;
  dict: Dictionary;
  code: string;
  request: { checkIn: string; checkOut: string; quotedTotal: number | null; previousTotal: number; note: string | null };
  /** Price now on the guest's villa, or why it does not fit there. */
  preview: { total: number; difference: number } | { error: string } | null;
  /** Villas that can take the dates (the guest's first when free). */
  villas: Array<{ id: string; code: string; current: boolean }>;
  canDecide: boolean;
}) {
  const t = dict.portal;
  const money = (n: number) => formatMoney(n, lang);
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
    </>
  );
  return (
    <div id="date-change" className="scroll-mt-6 space-y-3 text-sm">
      <p className="text-ink">
        {format(t.staffRequested, { dates: formatDateRange(request.checkIn, request.checkOut, lang) })}
        {request.note ? <span className="block text-xs text-stone">“{request.note}”</span> : null}
      </p>
      {preview && "total" in preview ? (
        <p className="text-stone">{format(t.staffPrice, { total: money(preview.total), difference: `${preview.difference >= 0 ? "+" : "−"}${money(Math.abs(preview.difference))}` })}</p>
      ) : (
        <p className="text-stone">{villas.length ? t.staffOtherVilla : t.staffNoVilla}</p>
      )}
      {canDecide ? (
        <div className="space-y-2">
          {villas.length ? (
            <form action={approveDateChangeAction} className="flex flex-wrap items-end gap-2">
              {hidden}
              <label className="space-y-1 text-xs text-stone">
                <span className="block">{t.staffVilla}</span>
                <select name="unitId" defaultValue={villas[0].id} className={input}>
                  {villas.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.code}
                      {v.current ? ` (${t.staffCurrent})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep">
                {t.staffApprove}
              </button>
            </form>
          ) : null}
          <form action={declineDateChangeAction} className="flex gap-1">
            {hidden}
            <input name="reason" required maxLength={300} placeholder={t.staffDeclineReason} aria-label={t.staffDeclineReason} className={input} />
            <button type="submit" className="shrink-0 rounded-lg border border-danger px-3 py-1.5 text-xs text-danger">
              {t.staffDecline}
            </button>
          </form>
          <p className="text-xs text-stone">{t.staffHint}</p>
        </div>
      ) : null}
    </div>
  );
}
