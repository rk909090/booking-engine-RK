"use server";

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { brand } from "@/config/brand";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { cancelReservation, createHold, createPendingPayment, findGuestReservation, recordPaymentPaid } from "@/domain/booking";
import { cancelLateCheckoutAsGuest, requestLateCheckoutAsGuest } from "@/domain/late-checkout";
import { savePreCheckin, type PreCheckinError } from "@/domain/pre-checkin";
import { sealGuestData } from "@/lib/crypto/guest-data";
import { isCountryCode } from "@/lib/countries";
import { hasLocale, type Locale } from "@/i18n/config";
import { closeCheckouts, openCheckouts } from "@/lib/payments/checkouts";
import { getPaymentProvider, simulatorEnabled } from "@/lib/payments/provider";
import { appUrl, bookingAccessToken, verifyBookingAccessToken } from "./access";
import { allowRequest, clientIp } from "./rate-limit";

export type StartBookingError =
  | "sold_out"
  | "too_many_guests"
  | "invalid_guest"
  | "unknown_unit_type"
  | "quote"
  | "agree"
  | "payment"
  | "rate_limited";

export type StartBookingState = { error?: StartBookingError };

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function localeOf(form: FormData): Locale {
  const lang = text(form, "lang");
  return hasLocale(lang) ? lang : "en";
}

function bookingPath(lang: Locale, code: string, extra = "") {
  return `/${lang}/booking/${code}?t=${bookingAccessToken(code)}${extra}`;
}

/** Holds a villa, opens the payment and sends the guest to the payment page. */
export async function startBooking(_prev: StartBookingState, form: FormData): Promise<StartBookingState> {
  const lang = localeOf(form);
  if (!allowRequest(`book:${clientIp(await headers())}`, 10, 10 * 60_000)) return { error: "rate_limited" };
  if (form.get("agree") !== "on") return { error: "agree" };

  const db = getDb();
  const held = await createHold(db, {
    unitTypeId: text(form, "unitTypeId"),
    checkIn: text(form, "checkIn"),
    checkOut: text(form, "checkOut"),
    adults: Number(text(form, "adults")),
    children: Number(text(form, "children") || "0"),
    guest: {
      fullName: text(form, "fullName"),
      email: text(form, "email"),
      phone: text(form, "phone") || null,
      countryCode: text(form, "country").slice(0, 2) || null,
    },
    estimatedArrival: /^\d{2}:\d{2}$/.test(text(form, "arrival")) ? text(form, "arrival") : null,
    specialRequests: text(form, "requests").slice(0, 2000) || null,
    locale: lang,
    source: "website",
  });
  if (!held.ok) return { error: held.error.kind };

  const { reservation, quote } = held;
  const returnUrl = new URL(bookingPath(lang, reservation.code), appUrl()).toString();
  let checkoutUrl: string;
  try {
    const provider = getPaymentProvider();
    const session = await provider.createCheckout(
      {
        amount: reservation.depositAmount,
        currency: reservation.currency,
        description: `${brand.name} · ${reservation.code}`,
        customer: { name: text(form, "fullName"), email: text(form, "email"), phone: text(form, "phone") || null },
        successUrl: returnUrl,
        failureUrl: returnUrl,
        expiresAt: reservation.holdExpiresAt ?? new Date(Date.now() + 15 * 60_000),
        locale: lang,
      },
      appUrl(),
    );
    await createPendingPayment(db, {
      reservationId: reservation.id,
      provider: provider.name,
      providerRef: session.providerRef,
      purpose: quote.payInFull ? "full" : "deposit",
      amount: reservation.depositAmount,
      checkoutUrl: session.checkoutUrl,
      expiresAt: session.expiresAt,
    });
    checkoutUrl = session.checkoutUrl;
  } catch (error) {
    console.error("[booking] payment start failed", reservation.code, error);
    // Release the villa straight away rather than blocking it for the hold time.
    await db
      .update(schema.reservations)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(schema.reservations.id, reservation.id), eq(schema.reservations.status, "hold")));
    return { error: "payment" };
  }
  redirect(checkoutUrl);
}

async function findPendingSimulatedPayment(ref: string) {
  const [row] = await getDb()
    .select({ payment: schema.payments, code: schema.reservations.code })
    .from(schema.payments)
    .innerJoin(schema.reservations, eq(schema.reservations.id, schema.payments.reservationId))
    .where(and(eq(schema.payments.provider, "simulated"), eq(schema.payments.providerRef, ref)))
    .limit(1);
  return row ?? null;
}

/** Simulator only: behaves like a successful provider notification. */
export async function approveSimulatedPayment(form: FormData) {
  const lang = localeOf(form);
  if (!simulatorEnabled()) redirect(`/${lang}`);
  const row = await findPendingSimulatedPayment(text(form, "ref"));
  if (!row) redirect(`/${lang}/booking`);
  if (row.payment.status === "pending") {
    await recordPaymentPaid(getDb(), {
      provider: "simulated",
      providerRef: row.payment.providerRef,
      amount: row.payment.amount,
      paidAt: new Date(),
      raw: { simulated: true },
    });
  }
  redirect(bookingPath(lang, row.code));
}

/**
 * Simulator only: a declined card. Like a real payment page, the same link
 * stays usable for another attempt until the hold expires.
 */
export async function declineSimulatedPayment(form: FormData) {
  const lang = localeOf(form);
  if (!simulatorEnabled()) redirect(`/${lang}`);
  const row = await findPendingSimulatedPayment(text(form, "ref"));
  if (!row) redirect(`/${lang}/booking`);
  redirect(bookingPath(lang, row.code, "&declined=1"));
}

export type LookupState = { notFound?: boolean; rateLimited?: boolean };

/** Guest portal sign-in: code plus email, never shown in the URL. */
export async function lookupBooking(_prev: LookupState, form: FormData): Promise<LookupState> {
  const lang = localeOf(form);
  if (!allowRequest(`lookup:${clientIp(await headers())}`, 20, 10 * 60_000)) return { rateLimited: true };
  const found = await findGuestReservation(getDb(), text(form, "code"), text(form, "email"));
  if (!found) return { notFound: true };
  redirect(bookingPath(lang, found.reservation.code));
}

/** Guest cancels from their booking page, authorised by the signed link. */
export async function cancelBookingAsGuest(form: FormData) {
  const lang = localeOf(form);
  const code = text(form, "code");
  const token = text(form, "t");
  if (!verifyBookingAccessToken(code, token) || form.get("confirm") !== "on") redirect(bookingPath(lang, code));
  const [reservation] = await getDb()
    .select({ id: schema.reservations.id })
    .from(schema.reservations)
    .where(eq(schema.reservations.code, code))
    .limit(1);
  if (reservation) {
    const links = await openCheckouts(reservation.id);
    const result = await cancelReservation(getDb(), { reservationId: reservation.id, actor: { type: "guest" }, reason: "Cancelled by guest" });
    if (result.ok) await closeCheckouts(reservation.id, links);
  }
  redirect(bookingPath(lang, code));
}

/** Finds the booking a guest may act on: the access token must match the code. */
async function guestReservation(form: FormData) {
  const code = text(form, "code").toUpperCase().slice(0, 40);
  if (!verifyBookingAccessToken(code, text(form, "t"))) return { code, id: null };
  const [row] = await getDb().select({ id: schema.reservations.id }).from(schema.reservations).where(eq(schema.reservations.code, code)).limit(1);
  return { code, id: row?.id ?? null };
}

/** The guest asks for a late check-out from their booking page; staff decide. */
export async function requestLateCheckoutFromPortal(form: FormData) {
  const lang = localeOf(form);
  const { code, id } = await guestReservation(form);
  if (!id) redirect(bookingPath(lang, code));
  if (!allowRequest(`late:${clientIp(await headers())}`, 10, 10 * 60_000)) redirect(bookingPath(lang, code, "&late=rate_limited"));
  const result = await requestLateCheckoutAsGuest(getDb(), { reservationId: id, time: text(form, "time"), note: text(form, "note") || null });
  redirect(bookingPath(lang, code, `&late=${result.ok ? "sent" : result.error}`));
}

/** The guest withdraws a late check-out request that is still waiting. */
export async function cancelLateCheckoutFromPortal(form: FormData) {
  const lang = localeOf(form);
  const { code, id } = await guestReservation(form);
  if (!id) redirect(bookingPath(lang, code));
  const result = await cancelLateCheckoutAsGuest(getDb(), { reservationId: id });
  redirect(bookingPath(lang, code, `&late=${result.ok ? "withdrawn" : result.error}`));
}

export type PreCheckinFormState = {
  error?: PreCheckinError;
  /** Submitted values to show again after an error; document numbers are never sent back. */
  values?: Record<string, string>;
};

/** Saves the guest's online pre-check-in from their booking page. */
export async function savePreCheckinFromPortal(_prev: PreCheckinFormState, form: FormData): Promise<PreCheckinFormState> {
  const lang = localeOf(form);
  const { code, id } = await guestReservation(form);
  if (!id) redirect(bookingPath(lang, code));
  if (!allowRequest(`precheckin:${clientIp(await headers())}`, 20, 10 * 60_000)) return { error: { kind: "rate_limited" } };

  const count = Math.min(20, Math.max(0, Number(text(form, "guestCount")) || 0));
  const guests = Array.from({ length: count }, (_, i) => ({
    fullName: text(form, `g${i}_name`).slice(0, 200),
    nationality: text(form, `g${i}_nationality`).toUpperCase().slice(0, 2),
    birthDate: text(form, `g${i}_birth`),
    documentType: text(form, `g${i}_docType`),
    documentNumber: text(form, `g${i}_docNumber`).slice(0, 40),
  }));
  const values: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string" && !key.startsWith("$") && !/_docNumber$/.test(key) && key !== "t") values[key] = value.slice(0, 1000);
  }
  const badCountry = guests.findIndex((g) => !isCountryCode(g.nationality));
  if (badCountry >= 0) return { error: { kind: "guest", index: badCountry, field: "nationality" }, values };

  const result = await savePreCheckin(
    getDb(),
    {
      reservationId: id,
      arrivalTime: text(form, "arrival"),
      flightNumber: text(form, "flight").slice(0, 20),
      landingDate: text(form, "landingDate"),
      landingTime: text(form, "landingTime"),
      transferRequested: form.get("transfer") === "on",
      transferNote: text(form, "transferNote"),
      requests: text(form, "requests"),
      acceptRules: form.get("rules") === "on",
      guests,
    },
    sealGuestData,
  );
  if (!result.ok) return { error: result.error, values };
  redirect(bookingPath(lang, code, `&precheckin=${result.updated ? "updated" : "saved"}`));
}
