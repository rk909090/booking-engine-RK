import Link from "next/link";
import { FOLIO_CATEGORIES } from "@/domain/folio";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { addChargeAction, addPartyAction, issueInvoiceAction, partyPaymentAction, voidChargeAction } from "@/lib/ops/actions";

type Charge = {
  id: string;
  partyId: string | null;
  category: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  chargeDate: string;
  status: string;
  voidReason: string | null;
};
type Party = { id: string; name: string; details: string | null; total: number; paid: number; balance: number };
type Invoice = { partyId: string | null; number: string };

const input = "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink";

/**
 * The folio of a booking: extra charges (prices include tax and service),
 * other parties who pay part of the bill, and the invoices.
 */
export function FolioCard({
  lang,
  dict,
  code,
  charges,
  parties,
  invoices,
  canCharge,
  canCollect,
  open,
}: {
  lang: Locale;
  dict: Dictionary;
  code: string;
  charges: Charge[];
  parties: Party[];
  invoices: Invoice[];
  canCharge: boolean;
  canCollect: boolean;
  /** Charges can still be added (confirmed, in house or checked out). */
  open: boolean;
}) {
  const t = dict.folio;
  const money = (n: number) => formatMoney(n, lang);
  const partyName = (id: string | null) => (id ? (parties.find((p) => p.id === id)?.name ?? "") : t.guest);
  const invoiceOf = (partyId: string | null) => invoices.find((i) => i.partyId === partyId);
  const hidden = (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="code" value={code} />
    </>
  );
  const invoiceLink = (partyId: string | null) => {
    const inv = invoiceOf(partyId);
    const href = `/${lang}/ops/reservations/${code}/invoice${partyId ? `?party=${partyId}` : ""}`;
    return inv ? (
      <Link href={href} className="text-lagoon hover:underline">
        {format(t.openInvoice, { number: inv.number })}
      </Link>
    ) : canCharge && open ? (
      <form action={issueInvoiceAction} className="inline">
        {hidden}
        {partyId ? <input type="hidden" name="partyId" value={partyId} /> : null}
        <button type="submit" className="text-lagoon hover:underline">
          {t.issueInvoice}
        </button>
      </form>
    ) : (
      <Link href={href} className="text-lagoon hover:underline">
        {t.previewInvoice}
      </Link>
    );
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-xs text-stone">{t.intro}</p>
      {charges.length === 0 ? (
        <p className="text-stone">{t.none}</p>
      ) : (
        <ul className="divide-y divide-line/60">
          {charges.map((c) => (
            <li key={c.id} className={`py-2 ${c.status === "void" ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap justify-between gap-2">
                <span className={`text-ink ${c.status === "void" ? "line-through" : ""}`}>
                  {c.description}
                  <span className="block text-xs text-stone">
                    {(t.categories as Record<string, string>)[c.category] ?? c.category} · {formatDate(c.chargeDate, lang)} · {c.quantity} × {money(c.unitPrice)} ·{" "}
                    <span className={c.partyId ? "text-terracotta-deep" : ""}>{partyName(c.partyId)}</span>
                  </span>
                </span>
                <span className={`text-right text-ink ${c.status === "void" ? "line-through" : ""}`}>{money(c.amount)}</span>
              </div>
              {c.status === "void" ? (
                <p className="text-xs text-danger">{format(t.voided, { reason: c.voidReason ?? "" })}</p>
              ) : canCharge ? (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-stone hover:text-danger">{t.void}</summary>
                  <form action={voidChargeAction} className="mt-1 flex gap-2">
                    {hidden}
                    <input type="hidden" name="chargeId" value={c.id} />
                    <input name="reason" required maxLength={300} placeholder={t.voidReason} className={`${input} py-1 text-xs`} />
                    <button type="submit" className="rounded-lg border border-danger/40 px-3 py-1 text-danger hover:bg-danger/5">
                      {t.voidConfirm}
                    </button>
                  </form>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canCharge && open ? (
        <form action={addChargeAction} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
          {hidden}
          <p className="font-medium text-ink sm:col-span-2">{t.addTitle}</p>
          <label className="space-y-1 text-xs text-stone">
            <span className="block">{t.category}</span>
            <select name="category" defaultValue="food_beverage" className={input}>
              {FOLIO_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {(t.categories as Record<string, string>)[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span className="block">{t.billTo}</span>
            <select name="billTo" defaultValue="" className={input}>
              <option value="">{t.guest}</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-stone sm:col-span-2">
            <span className="block">{t.description}</span>
            <input name="description" required maxLength={200} placeholder={t.descriptionHint} className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span className="block">{t.quantity}</span>
            <input name="quantity" type="number" min={1} max={999} defaultValue={1} required className={input} />
          </label>
          <label className="space-y-1 text-xs text-stone">
            <span className="block">{t.unitPrice}</span>
            <input name="unitPrice" inputMode="numeric" required placeholder="150000" className={input} />
          </label>
          <p className="text-xs text-stone sm:col-span-2">{t.pricesInclude}</p>
          <button type="submit" className="rounded-lg bg-lagoon px-4 py-2 text-sm font-medium text-ivory hover:bg-lagoon-deep sm:col-span-2">
            {t.add}
          </button>
        </form>
      ) : null}

      <div className="space-y-2 border-t border-line pt-3">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.invoicesTitle}</p>
        <p className="flex flex-wrap justify-between gap-2">
          <span className="text-ink">{t.guestInvoice}</span>
          {invoiceLink(null)}
        </p>
        {parties.map((p) => (
          <div key={p.id} className="rounded-lg border border-line p-3">
            <p className="flex flex-wrap justify-between gap-2">
              <span className="font-medium text-ink">{p.name}</span>
              {invoiceLink(p.id)}
            </p>
            {p.details ? <p className="whitespace-pre-line text-xs text-stone">{p.details}</p> : null}
            <p className="text-xs text-ink">{format(t.partyTotals, { total: money(p.total), paid: money(p.paid), balance: money(p.balance) })}</p>
            {canCollect && p.balance > 0 ? (
              <form action={partyPaymentAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                {hidden}
                <input type="hidden" name="partyId" value={p.id} />
                <label className="space-y-1 text-xs text-stone">
                  <span className="block">{dict.resDetail.collectAmount}</span>
                  <input name="amount" inputMode="numeric" required defaultValue={String(p.balance)} className={input} />
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span className="block">{dict.resDetail.collectMethod}</span>
                  <select name="method" defaultValue="bank_transfer" className={input}>
                    {(["cash", "bank_transfer", "card", "other"] as const).map((m) => (
                      <option key={m} value={m}>
                        {dict.resDetail.methods[m]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1 text-xs text-stone">
                  <span className="block">{dict.resDetail.collectReference}</span>
                  <input name="reference" maxLength={200} className={input} />
                </label>
                <button type="submit" className="rounded-lg border border-lagoon px-3 py-2 text-sm text-lagoon hover:bg-lagoon-soft">
                  {t.recordPayment}
                </button>
              </form>
            ) : null}
          </div>
        ))}
        {canCharge && open ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-lagoon">{t.addParty}</summary>
            <form action={addPartyAction} className="mt-2 grid gap-2">
              {hidden}
              <label className="space-y-1 text-stone">
                <span className="block">{t.partyName}</span>
                <input name="name" required maxLength={120} placeholder={t.partyNameHint} className={input} />
              </label>
              <label className="space-y-1 text-stone">
                <span className="block">{t.partyDetails}</span>
                <textarea name="details" rows={2} maxLength={500} placeholder={t.partyDetailsHint} className={input} />
              </label>
              <label className="space-y-1 text-stone">
                <span className="block">{t.partyEmail}</span>
                <input name="email" type="email" maxLength={200} className={input} />
              </label>
              <button type="submit" className="rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-sand">
                {t.addPartySubmit}
              </button>
            </form>
          </details>
        ) : null}
      </div>
    </div>
  );
}
