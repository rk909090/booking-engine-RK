import "server-only";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { brand } from "@/config/brand";
import * as schema from "@/db/schema";
import { diffDays, todayIn } from "@/domain/dates";
import type { MessageKind, OutboxMessage } from "@/domain/notifications";
import { balanceDue } from "@/domain/pricing";
import { hasLocale, type Locale } from "@/i18n/config";
import { format } from "@/i18n/format";
import { formatDate, formatDateRange, formatMoney } from "@/i18n/formatters";
import { getDictionary } from "@/i18n/get-dictionary";
import { appUrl, bookingAccessToken } from "@/lib/booking/access";
import type { EmailMessage, WhatsAppMessage } from "./providers";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Turns a queued message into an email (full details) or a WhatsApp template
 * (short, with a link). Content is read from the booking at send time, so
 * the guest sees the current state; the payload only carries what belongs to
 * the event (refund, decided time, amount due).
 *
 * WhatsApp template names and their numbered parameters must match the
 * templates approved in Meta (see docs/03-NOTIFIKASI.md).
 */

export async function loadMessageContext(db: AnyDb, reservationId: string) {
  const [row] = await db
    .select({
      r: schema.reservations,
      guestName: schema.guests.fullName,
      propertyName: schema.properties.name,
      timezone: schema.properties.timezone,
      checkInTime: schema.properties.checkInTime,
      checkOutTime: schema.properties.checkOutTime,
      typeName: schema.unitTypes.name,
    })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.reservations.unitTypeId))
    .where(eq(schema.reservations.id, reservationId));
  return row ?? null;
}

export type MessageContext = NonNullable<Awaited<ReturnType<typeof loadMessageContext>>>;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function bookingLink(code: string, locale: Locale) {
  return new URL(`/${locale}/booking/${code}?t=${bookingAccessToken(code)}`, appUrl()).toString();
}

/** First name for a friendly greeting. */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

type Payload = { refund?: number; fee?: number; approved?: boolean; time?: string; amount?: number; dueDate?: string; payBy?: string; depositDue?: number; addon?: { id: string; en: string }; date?: string };

export async function renderEmail(message: OutboxMessage, ctx: MessageContext): Promise<EmailMessage> {
  const { r } = ctx;
  const locale: Locale = hasLocale(r.locale) ? r.locale : "en";
  const d = await getDictionary(locale);
  const t = d.messages;
  const p = message.payload as Payload;
  const kind = message.kind as MessageKind;
  const money = (n: number) => formatMoney(n, locale);
  const date = (s: string) => formatDate(s, locale);
  const vars = { code: r.code, property: ctx.propertyName, name: firstName(ctx.guestName), brand: brand.name };
  const link = bookingLink(r.code, locale);

  const lines: string[] = [];
  let subject = "";
  switch (kind) {
    case "booking_confirmed":
      subject = format(t.confirmed.subject, vars);
      lines.push(format(t.confirmed.intro, vars));
      if (p.payBy && r.amountPaid < Math.min(r.depositAmount, r.totalAmount)) {
        lines.push(format(t.confirmed.payBy, { amount: money(Math.min(r.depositAmount, r.totalAmount) - r.amountPaid), date: date(p.payBy) }));
      }
      lines.push(t.confirmed.precheckin);
      break;
    case "booking_modified":
      subject = format(t.modified.subject, vars);
      lines.push(t.modified.intro);
      break;
    case "booking_cancelled":
      subject = format(t.cancelled.subject, vars);
      lines.push(t.cancelled.intro);
      lines.push(p.refund ? format(t.cancelled.refund, { amount: money(p.refund) }) : t.cancelled.noRefund);
      break;
    case "late_checkout_decided":
    case "early_checkin_decided": {
      const m = kind === "late_checkout_decided" ? t.lateCheckout : t.earlyCheckin;
      subject = format(m.subject, vars);
      lines.push(p.approved ? format(p.fee ? m.approvedFee : m.approved, { time: p.time ?? "", amount: money(p.fee ?? 0) }) : format(m.declined, { time: p.time ?? "" }));
      break;
    }
    case "precheckin_reminder":
      subject = format(t.precheckin.subject, vars);
      lines.push(format(t.precheckin.intro, { ...vars, days: Math.max(1, diffDays(todayIn(ctx.timezone), r.checkIn)) }));
      break;
    case "addon_decided": {
      const name = (p.addon as { id: string; en: string } | undefined)?.[locale] ?? "";
      const when = `${p.date ? date(String(p.date)) : ""}${p.time ? ` ${p.time}` : ""}`;
      subject = format(t.addon.subject, vars);
      lines.push(p.approved ? format(t.addon.confirmed, { addon: name, when, amount: money(Number(p.amount ?? 0)) }) : format(t.addon.declined, { addon: name, when }));
      break;
    }
    case "payment_reminder":
      subject = format(t.payment.subject, vars);
      lines.push(format(t.payment.intro, { amount: money(p.amount ?? balanceDue(r)), date: date(p.dueDate ?? r.balanceDueDate ?? r.checkIn) }));
      break;
  }

  const details: Array<[string, string]> = [
    [t.details.code, r.code],
    [t.details.villa, `${ctx.typeName} · ${ctx.propertyName}`],
    [t.details.dates, formatDateRange(r.checkIn, r.checkOut, locale)],
    [t.details.times, format(t.details.timesValue, { checkIn: ctx.checkInTime.slice(0, 5), checkOut: ctx.checkOutTime.slice(0, 5) })],
    [t.details.guests, format(d.search.guests, { count: r.adults + r.children })],
  ];
  if (kind !== "booking_cancelled") {
    details.push([t.details.total, money(r.totalAmount)], [t.details.paid, money(r.amountPaid)]);
    if (balanceDue(r) > 0) details.push([t.details.balance, money(balanceDue(r))]);
  }

  const greeting = format(t.greeting, vars);
  const signoff = format(t.signoff, vars);
  const text = [greeting, "", ...lines, "", ...details.map(([k, v]) => `${k}: ${v}`), "", `${t.viewBooking}: ${link}`, "", signoff, "", format(t.footer, vars)].join("\n");
  const html = `<!doctype html><html lang="${locale}"><body style="margin:0;background:#f6f1e7;font-family:Georgia,'Times New Roman',serif;color:#1f2a24">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:20px;color:#1d4d43;margin:0 0 16px">${escapeHtml(brand.name)}</p>
<div style="background:#ffffff;border:1px solid #e5dccb;border-radius:12px;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">
<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>
${lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join("\n")}
<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">${details
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#6b6b63;border-top:1px solid #efe8da">${escapeHtml(k)}</td><td style="padding:6px 0;text-align:right;border-top:1px solid #efe8da">${escapeHtml(v)}</td></tr>`)
    .join("")}</table>
<p style="margin:20px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1d4d43;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px">${escapeHtml(t.viewBooking)}</a></p>
<p style="margin:0">${escapeHtml(signoff).replace(/\n/g, "<br>")}</p>
</div>
<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a8a80;margin:16px 0 0">${escapeHtml(format(t.footer, vars))}</p>
</div></body></html>`;
  return { to: message.recipient, subject, html, text, idempotencyKey: message.id };
}

/** WhatsApp template parameters can't hold newlines, tabs or long runs of spaces. */
const param = (s: string) => s.replace(/[\n\t]+/g, " ").replace(/ {4,}/g, "   ").slice(0, 1000);

export function renderWhatsApp(message: OutboxMessage, ctx: MessageContext): WhatsAppMessage {
  const { r } = ctx;
  const locale: Locale = hasLocale(r.locale) ? r.locale : "en";
  const p = message.payload as Payload;
  const money = (n: number) => formatMoney(n, locale);
  const name = firstName(ctx.guestName);
  const link = bookingLink(r.code, locale);
  const dates = formatDateRange(r.checkIn, r.checkOut, locale);
  const kind = message.kind as MessageKind;
  const make = (template: string, params: string[]): WhatsAppMessage => ({ to: message.recipient, template, language: locale, params: params.map(param) });
  switch (kind) {
    case "booking_confirmed":
      return make("booking_confirmed", [name, r.code, `${ctx.typeName} · ${ctx.propertyName}`, dates, link]);
    case "booking_modified":
      return make("booking_modified", [name, r.code, dates, link]);
    case "booking_cancelled":
      return make("booking_cancelled", [name, r.code, money(p.refund ?? 0), link]);
    case "late_checkout_decided":
    case "early_checkin_decided": {
      const base = kind === "late_checkout_decided" ? "late_checkout" : "early_checkin";
      return p.approved ? make(`${base}_approved`, [name, p.time ?? "", money(p.fee ?? 0), link]) : make(`${base}_declined`, [name, p.time ?? "", link]);
    }
    case "precheckin_reminder":
      return make("precheckin_reminder", [name, ctx.propertyName, formatDate(r.checkIn, locale), link]);
    case "addon_decided": {
      const addon = (p.addon as { id: string; en: string } | undefined)?.[locale] ?? "";
      const when = `${p.date ? formatDate(String(p.date), locale) : ""}${p.time ? ` ${p.time}` : ""}`;
      return p.approved ? make("addon_confirmed", [name, addon, when, money(Number(p.amount ?? 0)), link]) : make("addon_declined", [name, addon, when, link]);
    }
    case "payment_reminder":
      return make("payment_reminder", [name, money(p.amount ?? balanceDue(r)), formatDate(p.dueDate ?? r.balanceDueDate ?? r.checkIn, locale), link]);
  }
}
