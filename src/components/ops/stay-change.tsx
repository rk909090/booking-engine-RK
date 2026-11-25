import Link from "next/link";
import { ErrorNote } from "@/components/ui";
import { addDays, diffDays } from "@/domain/dates";
import type { StayChangeResult } from "@/domain/modify";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { changeStayAction } from "@/lib/ops/actions";

type Props = {
  lang: Locale;
  dict: Dictionary;
  reservation: { code: string; checkIn: string; checkOut: string; unitId: string; status: string; priceSnapshot: { nights: Array<{ date: string }> } | null };
  units: Array<{ id: string; code: string }>;
  today: string;
  canMove: boolean;
  /** Values the form was submitted with, when a preview is shown. */
  request: { checkIn: string; checkOut: string; unitId: string } | null;
  preview: StayChangeResult | null;
  priceChanged: boolean;
};

const input = "w-full rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-ink";

/**
 * Change dates or villa in two steps: a GET form shows the preview on this
 * page (dates and a villa id in the URL, no personal data), then a POST
 * confirms exactly the previewed total.
 */
export function StayChange({ lang, dict, reservation: r, units, today, canMove, request, preview, priceChanged }: Props) {
  const t = dict.stayChange;
  const inHouse = r.status === "in_house";
  const values = request ?? { checkIn: r.checkIn, checkOut: r.checkOut, unitId: r.unitId };
  const unitCode = (id: string) => units.find((u) => u.id === id)?.code ?? "";
  const base = `/${lang}/ops/reservations/${r.code}`;
  const oldNights = new Set(r.priceSnapshot?.nights.map((n) => n.date) ?? []);

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone">{inHouse ? t.inHouseNote : t.intro}</p>
      {/* Keyed on its values so a soft navigation to another preview resets the fields. */}
      <form key={`${values.checkIn}|${values.checkOut}|${values.unitId}`} method="get" action={base} className="grid grid-cols-2 gap-2">
        <label className="block space-y-1 text-xs text-stone">
          <span>{t.checkIn}</span>
          {inHouse ? (
            <>
              <input type="hidden" name="newIn" value={r.checkIn} />
              <input type="date" value={r.checkIn} disabled className={`${input} opacity-60`} />
            </>
          ) : (
            <input type="date" name="newIn" required min={today} defaultValue={values.checkIn} className={input} />
          )}
        </label>
        <label className="block space-y-1 text-xs text-stone">
          <span>{t.checkOut}</span>
          <input type="date" name="newOut" required min={addDays(today, 1)} defaultValue={values.checkOut} className={input} />
        </label>
        {canMove && !inHouse && units.length > 1 ? (
          <label className="col-span-2 block space-y-1 text-xs text-stone">
            <span>{t.unit}</span>
            <select name="unit" defaultValue={values.unitId} className={input}>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id === r.unitId ? format(t.current, { code: u.code }) : u.code}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <input type="hidden" name="unit" value={r.unitId} />
        )}
        <button type="submit" className="col-span-2 rounded-lg border border-lagoon px-3 py-2 text-sm font-medium text-lagoon hover:bg-lagoon-soft">
          {t.previewSubmit}
        </button>
      </form>

      {priceChanged ? <ErrorNote>{t.errors.price_changed}</ErrorNote> : null}

      {preview && !preview.ok ? (
        <div className="space-y-2">
          <ErrorNote>
            {format((t.errors as Record<string, string>)[preview.error] ?? t.errors.not_found, {
              min: preview.minNights ?? "",
              max: preview.maxNights ?? "",
            })}
          </ErrorNote>
          {preview.codes?.length ? (
            <p className="text-xs text-ink">
              {t.conflictWith}{" "}
              {preview.codes.map((c, i) => (
                <span key={c}>
                  {i > 0 ? ", " : ""}
                  <Link href={`/${lang}/ops/reservations/${c}`} className="font-mono text-lagoon hover:underline">
                    {c}
                  </Link>
                </span>
              ))}
            </p>
          ) : null}
          {canMove && preview.alternatives?.length && request ? (
            <div className="text-xs text-ink">
              <p>{t.alternatives}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {preview.alternatives.map((u) => (
                  <Link
                    key={u.id}
                    href={`${base}?${new URLSearchParams({ newIn: request.checkIn, newOut: request.checkOut, unit: u.id })}`}
                    className="rounded-lg border border-line px-2 py-1 font-mono text-lagoon hover:bg-sand"
                  >
                    {format(t.useUnit, { code: u.code })}
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {preview?.ok ? (
        <div className="space-y-3 rounded-lg border border-lagoon/30 bg-lagoon-soft/40 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.previewTitle}</h3>
          <dl className="space-y-1 text-sm">
            <Row label={t.before} value={`${formatDateRange(r.checkIn, r.checkOut, lang)} · ${unitCode(r.unitId)}`} />
            <Row
              label={t.after}
              value={`${formatDateRange(preview.plan.checkIn, preview.plan.checkOut, lang)} · ${preview.plan.unitCode} · ${format(t.nights, { count: diffDays(preview.plan.checkIn, preview.plan.checkOut) })}`}
              strong
            />
            <Row label={t.oldTotal} value={formatMoney(preview.plan.previousTotal, lang)} />
            <Row label={t.newTotal} value={formatMoney(preview.plan.total, lang)} strong />
            <Row
              label={t.difference}
              value={`${preview.plan.difference > 0 ? "+" : preview.plan.difference < 0 ? "−" : ""}${formatMoney(Math.abs(preview.plan.difference), lang)}`}
            />
            <Row
              label={preview.plan.balanceDueDate ? `${t.balanceAfter} (${format(t.balanceDue, { date: formatDate(preview.plan.balanceDueDate, lang) })})` : t.balanceAfter}
              value={formatMoney(Math.max(0, preview.plan.balanceAfter), lang)}
              strong={preview.plan.balanceAfter > 0}
            />
            {preview.plan.refundOutstandingAfter > 0 ? (
              <Row label={t.refundAfter} value={formatMoney(preview.plan.refundOutstandingAfter, lang)} strong danger />
            ) : null}
          </dl>
          <details className="text-xs">
            <summary className="cursor-pointer text-lagoon">{t.nightly}</summary>
            <ul className="mt-2 space-y-1">
              {preview.plan.price.nights.map((n) => (
                <li key={n.date} className="flex justify-between gap-2 text-stone">
                  <span>
                    {formatDate(n.date, lang)}
                    {n.season ? ` · ${n.season}` : ""}
                    {oldNights.has(n.date) ? "" : <span className="ml-1 rounded bg-sand px-1 text-ink">{t.newNight}</span>}
                  </span>
                  <span className="text-ink">{formatMoney(n.rate, lang)}</span>
                </li>
              ))}
            </ul>
          </details>
          <p className="text-xs text-stone">{t.keptPrice}</p>
          {preview.plan.lateCheckoutCancelled ? <p className="text-xs text-danger">{t.lateCheckoutCancelled}</p> : null}
          <p className="text-xs text-stone">{t.guestNotice}</p>
          <form action={changeStayAction} className="flex gap-2">
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="code" value={r.code} />
            <input type="hidden" name="newIn" value={preview.plan.checkIn} />
            <input type="hidden" name="newOut" value={preview.plan.checkOut} />
            <input type="hidden" name="unit" value={preview.plan.unitId} />
            <input type="hidden" name="expectedTotal" value={String(preview.plan.total)} />
            <button type="submit" className="flex-1 rounded-lg bg-lagoon px-3 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep">
              {t.confirm}
            </button>
            <Link href={base} className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-sand">
              {t.discard}
            </Link>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-medium" : ""} ${danger ? "text-danger" : strong ? "text-ink" : "text-stone"}`}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
