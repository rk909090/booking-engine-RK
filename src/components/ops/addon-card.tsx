import { AddonFields, type AddonView } from "@/components/addon-fields";
import type * as schema from "@/db/schema";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { addAddonAction, cancelAddonAction, confirmAddonAction, declineAddonAction } from "@/lib/ops/addon-actions";

type Order = { order: typeof schema.addonOrders.$inferSelect; addon: typeof schema.addons.$inferSelect };
const input = "w-full rounded-lg border border-line bg-white px-3 py-1.5 text-xs text-ink";

/** Add-on orders of a booking on the reservation page: decide guest requests, cancel, or add one. */
export function AddonCard({
  lang,
  dict,
  code,
  orders,
  catalog,
  dates,
  guests,
  nights,
  canManage,
  open,
}: {
  lang: Locale;
  dict: Dictionary;
  code: string;
  orders: Order[];
  catalog: AddonView[];
  dates: Array<{ value: string; label: string }>;
  guests: number;
  nights: number;
  canManage: boolean;
  open: boolean;
}) {
  const t = dict.addons;
  const hidden = (orderId?: string) => (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
      {orderId ? <input type="hidden" name="orderId" value={orderId} /> : null}
    </>
  );
  return (
    <div id="addons" className="scroll-mt-6 space-y-4">
      {orders.length ? (
        <ul className="divide-y divide-line/60 text-sm">
          {orders.map(({ order: o, addon: a }) => (
            <li key={o.id} className="space-y-2 py-2">
              <div className="flex flex-wrap justify-between gap-2">
                <span>
                  <span className="font-medium text-ink">{a.name[lang] || a.name.id}</span>
                  <span className="block text-xs text-stone">
                    {formatDate(o.serviceDate, lang, { weekday: "short", day: "numeric", month: "short" })}
                    {o.serviceTime ? ` · ${o.serviceTime.slice(0, 5)}` : ""} · {format(t.unitsLine, { units: o.units, price: formatMoney(o.unitPrice, lang) })} · {(t.sources as Record<string, string>)[o.source]}
                  </span>
                  {o.note ? <span className="block text-xs text-ink">“{o.note}”</span> : null}
                  {o.declineReason ? <span className="block text-xs text-stone">{format(t.reasonLine, { reason: o.declineReason })}</span> : null}
                </span>
                <span className="text-right">
                  <span className="block font-medium text-ink">{formatMoney(o.amount, lang)}</span>
                  <span className={`text-xs ${o.status === "requested" ? "font-medium text-terracotta-deep" : o.status === "confirmed" ? "text-success" : "text-stone"}`}>
                    {(t.status as Record<string, string>)[o.status]}
                    {o.status === "requested" && o.folioChargeId ? ` · ${t.onBill}` : ""}
                  </span>
                </span>
              </div>
              {canManage && o.status === "requested" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <form action={confirmAddonAction}>
                    {hidden(o.id)}
                    <button type="submit" className="rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep">
                      {t.confirm}
                    </button>
                  </form>
                  <form action={declineAddonAction} className="flex flex-1 gap-1">
                    {hidden(o.id)}
                    <input name="reason" required maxLength={300} placeholder={t.declineReason} aria-label={t.declineReason} className={input} />
                    <button type="submit" className="shrink-0 rounded-lg border border-danger px-3 py-1.5 text-xs text-danger">
                      {t.decline}
                    </button>
                  </form>
                </div>
              ) : null}
              {canManage && o.status === "confirmed" ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-stone hover:text-ink">{t.cancelOrder}</summary>
                  <form action={cancelAddonAction} className="mt-1 flex gap-1">
                    {hidden(o.id)}
                    <input name="reason" required maxLength={300} placeholder={t.cancelReason} aria-label={t.cancelReason} className={input} />
                    <button type="submit" className="shrink-0 rounded-lg border border-danger px-3 py-1.5 text-xs text-danger">
                      {t.cancelOrder}
                    </button>
                  </form>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-stone">{t.noOrders}</p>
      )}
      {canManage && open && catalog.length ? (
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium text-lagoon">{t.addForGuest}</summary>
          <p className="mt-2 text-xs text-stone">{t.staffAddHint}</p>
          <div className="mt-2 space-y-3">
            {catalog.map((a) => (
              <details key={a.id} className="rounded-lg border border-line/70 bg-white p-3">
                <summary className="flex cursor-pointer flex-wrap justify-between gap-2 text-sm">
                  <span className="text-ink">{a.name}</span>
                  <span className="text-stone">{a.price}</span>
                </summary>
                <form action={addAddonAction} className="mt-2 space-y-2">
                  {hidden()}
                  <input type="hidden" name="addonId" value={a.id} />
                  <AddonFields addon={a} prefix="" t={t} dates={dates} guests={guests} nights={nights} />
                  <button type="submit" className="rounded-lg bg-lagoon px-3 py-1.5 text-xs font-medium text-ivory hover:bg-lagoon-deep">
                    {t.addConfirmed}
                  </button>
                </form>
              </details>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
