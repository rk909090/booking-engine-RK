import type { ReactNode } from "react";
import { brand } from "@/config/brand";
import type { invoiceData, receiptData } from "@/domain/folio";
import type { Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import type { Dictionary } from "@/i18n/get-dictionary";
import { offerLabel } from "@/lib/pricing-labels";
import { PrintButton } from "./print-button";

type Invoice = NonNullable<Awaited<ReturnType<typeof invoiceData>>>;
type Receipt = NonNullable<Awaited<ReturnType<typeof receiptData>>>;

function dateTime(lang: Locale, timeZone: string, d: Date) {
  return new Intl.DateTimeFormat(lang === "id" ? "id-ID" : "en-GB", { dateStyle: "medium", timeZone }).format(d);
}

/** Seller block: brand, property and, when set, legal details. */
function Seller({ property, t }: { property: Invoice["property"]; t: Dictionary["invoice"] }) {
  const inv = property.content.invoice;
  return (
    <div className="text-sm text-ink">
      <p className="font-display text-2xl text-lagoon">{brand.name}</p>
      <p>{inv?.legalName ?? property.name}</p>
      {inv?.address ? <p className="whitespace-pre-line text-stone">{inv.address}</p> : null}
      {inv?.taxId ? <p className="text-stone">{format(t.taxId, { id: inv.taxId })}</p> : null}
      {inv?.phone || inv?.email ? <p className="text-stone">{[inv.phone, inv.email].filter(Boolean).join(" · ")}</p> : null}
    </div>
  );
}

/** Printable page frame: toolbar hidden when printing. */
export function Shell({ toolbar, children }: { toolbar: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-full bg-sand/40 print:bg-white">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-2 px-4 py-4 print:hidden">{toolbar}</div>
      <article className="mx-auto mb-10 max-w-3xl rounded-xl border border-line bg-white p-8 shadow-sm print:m-0 print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {children}
      </article>
    </div>
  );
}

/** A printable invoice (guest or other party). */
export function InvoiceDocument({ lang, dict, data, toolbar }: { lang: Locale; dict: Dictionary; data: Invoice; toolbar: ReactNode }) {
  const t = dict.invoice;
  const money = (n: number) => formatMoney(n, lang);
  const tz = data.property.timezone;
  const methods = dict.resDetail.methods as Record<string, string>;
  const lineLabel = (l: Invoice["lines"][number]) => {
    switch (l.kind) {
      case "nights":
        return l.quantity ? format(t.lines.nights, { villa: l.label, count: l.quantity }) : l.label;
      case "discount":
        return l.label ? format(t.lines.discountReason, { reason: l.label }) : t.lines.discount;
      case "plan_discount":
        return dict.pricing.planDiscount;
      case "offer":
        return offerLabel(dict.pricing, { kind: l.variant ?? "", code: l.label });
      case "breakfast":
        return format(dict.pricing.breakfastLine, { count: l.quantity ?? 0 });
      case "service":
        return t.lines.service;
      case "tax":
        return t.lines.tax;
      case "late":
        return format(t.lines.late, { time: l.label });
      case "early":
        return format(t.lines.early, { time: l.label });
      case "other":
        return t.lines.other;
      default:
        return l.label;
    }
  };
  return (
    <Shell
      toolbar={
        <>
          {toolbar}
          <PrintButton label={t.print} />
        </>
      }
    >
      <header className="flex flex-wrap justify-between gap-6 border-b border-line pb-6">
        <Seller property={data.property} t={t} />
        <div className="text-right text-sm">
          <p className="font-display text-3xl text-ink">{t.title}</p>
          <p className="font-mono text-ink">{data.invoice?.number ?? t.draft}</p>
          {data.invoice ? <p className="text-stone">{format(t.issued, { date: dateTime(lang, tz, data.invoice.issuedAt) })}</p> : null}
          <p className="text-stone">{format(t.booking, { code: data.r.code })}</p>
        </div>
      </header>

      <section className="grid gap-6 border-b border-line py-6 text-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.billTo}</p>
          {data.party ? (
            <>
              <p className="mt-1 font-medium text-ink">{data.party.name}</p>
              {data.party.details ? <p className="whitespace-pre-line text-stone">{data.party.details}</p> : null}
              {data.party.email ? <p className="text-stone">{data.party.email}</p> : null}
              <p className="mt-1 text-stone">{format(t.forGuest, { name: data.guest.fullName })}</p>
            </>
          ) : (
            <>
              <p className="mt-1 font-medium text-ink">{data.guest.fullName}</p>
              {data.guest.email ? <p className="text-stone">{data.guest.email}</p> : null}
              {data.guest.phone ? <p className="text-stone">{data.guest.phone}</p> : null}
            </>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.15em] text-terracotta-deep">{t.stay}</p>
          <p className="mt-1 text-ink">{formatDateRange(data.r.checkIn, data.r.checkOut, lang)}</p>
          <p className="text-stone">
            {data.typeName} · {data.unitCode} · {data.property.name}
          </p>
          <p className="text-stone">{format(dict.search.guests, { count: data.r.adults + data.r.children })}</p>
        </div>
      </section>

      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs uppercase tracking-wider text-stone">
          <tr>
            <th className="py-2">{t.description}</th>
            <th className="py-2 text-right">{t.quantity}</th>
            <th className="py-2 text-right">{t.unitPrice}</th>
            <th className="py-2 text-right">{t.amount}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i} className="border-b border-line/60">
              <td className="py-2 text-ink">
                {lineLabel(l)}
                {l.date && l.kind === "charge" ? <span className="block text-xs text-stone">{formatDate(l.date, lang)}</span> : null}
              </td>
              <td className="py-2 text-right text-ink">{l.kind === "charge" && l.quantity ? l.quantity : ""}</td>
              <td className="py-2 text-right text-ink">{l.kind === "charge" && l.unitPrice !== undefined ? money(l.unitPrice) : ""}</td>
              <td className="py-2 text-right text-ink">{l.amount < 0 ? `−${money(-l.amount)}` : money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="text-sm">
          <tr>
            <td colSpan={3} className="pt-3 text-right font-medium text-ink">
              {t.total}
            </td>
            <td className="pt-3 text-right font-medium text-ink">{money(data.total)}</td>
          </tr>
          {data.payments.map((p) => (
            <tr key={p.id}>
              <td colSpan={3} className="text-right text-stone">
                {format(t.paidOn, {
                  date: dateTime(lang, tz, p.paidAt ?? p.createdAt),
                  method: methods[(p.raw as { method?: string } | null)?.method ?? ""] ?? (t.providers as Record<string, string>)[p.provider] ?? p.provider,
                })}
              </td>
              <td className="text-right text-stone">−{money(p.amount)}</td>
            </tr>
          ))}
          {data.refunds.map((p) => (
            <tr key={p.id}>
              <td colSpan={3} className="text-right text-stone">
                {format(t.refundOn, { date: dateTime(lang, tz, p.paidAt ?? p.createdAt) })}
              </td>
              <td className="text-right text-stone">+{money(p.amount)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3} className="pt-2 text-right text-base font-semibold text-ink">
              {data.balance > 0 ? t.balanceDue : t.settled}
            </td>
            <td className="pt-2 text-right text-base font-semibold text-ink">{money(Math.max(0, data.balance))}</td>
          </tr>
        </tfoot>
      </table>
      <p className="mt-6 text-xs text-stone">{data.lines.some((l) => l.kind === "service" || l.kind === "tax") ? t.notePrices : t.notePartyPrices}</p>
    </Shell>
  );
}

/** A printable receipt for one payment. */
export function ReceiptDocument({ lang, dict, data, toolbar }: { lang: Locale; dict: Dictionary; data: Receipt; toolbar: ReactNode }) {
  const t = dict.invoice;
  const raw = (data.payment.raw ?? {}) as { method?: string; reference?: string | null };
  const methods = dict.resDetail.methods as Record<string, string>;
  return (
    <Shell
      toolbar={
        <>
          {toolbar}
          <PrintButton label={t.print} />
        </>
      }
    >
      <header className="flex flex-wrap justify-between gap-6 border-b border-line pb-6">
        <Seller property={data.property} t={t} />
        <div className="text-right text-sm">
          <p className="font-display text-3xl text-ink">{t.receiptTitle}</p>
          <p className="font-mono text-ink">{data.number}</p>
          <p className="text-stone">{dateTime(lang, data.property.timezone, data.payment.paidAt ?? data.payment.createdAt)}</p>
        </div>
      </header>
      <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-stone">{t.receivedFrom}</dt>
          <dd className="font-medium text-ink">{data.party?.name ?? data.guest.fullName}</dd>
        </div>
        <div>
          <dt className="text-stone">{t.amount}</dt>
          <dd className="font-display text-2xl text-ink">{formatMoney(data.payment.amount, lang)}</dd>
        </div>
        <div>
          <dt className="text-stone">{t.method}</dt>
          <dd className="text-ink">
            {methods[raw.method ?? ""] ?? (t.providers as Record<string, string>)[data.payment.provider] ?? data.payment.provider}
            {raw.reference ? ` · ${raw.reference}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-stone">{t.forBooking}</dt>
          <dd className="text-ink">
            {data.r.code} · {formatDateRange(data.r.checkIn, data.r.checkOut, lang)}
          </dd>
        </div>
      </dl>
      <p className="mt-8 text-xs text-stone">{t.receiptNote}</p>
    </Shell>
  );
}
