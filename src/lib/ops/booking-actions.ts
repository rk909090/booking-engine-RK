"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { brand } from "@/config/brand";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { createPendingPayment } from "@/domain/booking";
import { PAYMENT_METHODS, type PaymentMethod } from "@/domain/operations";
import { createStaffBooking, LINK_HOLD_HOURS, STAFF_SOURCES, type StaffSource } from "@/domain/staff-booking";
import { RATE_PLANS, type RatePlan } from "@/domain/types";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can } from "@/lib/authz/permissions";
import { appUrl, bookingAccessToken } from "@/lib/booking/access";
import { getPaymentProvider } from "@/lib/payments/provider";
import { deliverSoon } from "@/lib/notifications/deliver";
import { parseDiscountInput } from "./discount-input";

export type StaffBookingFormError =
  | "invalid_guest"
  | "sold_out"
  | "too_many_guests"
  | "unknown_unit_type"
  | "quote"
  | "invalid_amount"
  | "payment"
  | "role"
  | "invalid_discount"
  | "smaller_than_offer"
  | "promo"
  | "addon"
  | "over_limit"
  | "guarantee_reason_required"
  | "guarantee_invalid_pay_by"
  | "guarantee_failed"
  | "guarantee_role";

/** Kept in memory only (never in the URL) so the form can be shown again after an error. */
export type StaffBookingFormState = {
  error?: StaffBookingFormError;
  amountRange?: { min: number; max: number };
  /** The staff member's discount ceiling, when the discount was over it. */
  limitBp?: number;
  values?: Record<string, string>;
};

const KEPT_FIELDS = ["fullName", "email", "phone", "country", "arrival", "requests", "source", "unitId", "mode", "amount", "method", "reference", "holdHours", "amountTouched", "discountKind", "discountValue", "discountReason", "guaranteeReason", "payBy"];

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Creates a staff booking: confirmed with money received or without deposit, or held with a payment link. */
export async function createStaffBookingAction(_prev: StaffBookingFormState, form: FormData): Promise<StaffBookingFormState> {
  const langRaw = text(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const values = Object.fromEntries(KEPT_FIELDS.map((k) => [k, text(form, k)]));
  const fail = (error: StaffBookingFormError, extra: Partial<StaffBookingFormState> = {}): StaffBookingFormState => ({ error, values, ...extra });

  const staff = await requireStaff(lang);
  const unitTypeId = text(form, "unitTypeId");
  if (!UUID.test(unitTypeId)) return fail("unknown_unit_type");
  const [type] = await getDb()
    .select({ propertyId: schema.unitTypes.propertyId })
    .from(schema.unitTypes)
    .where(eq(schema.unitTypes.id, unitTypeId))
    .limit(1);
  if (!type) return fail("unknown_unit_type");
  if (!can(staff.actor, "reservation.create", type.propertyId).allowed) return fail("role");

  const unitId = text(form, "unitId");
  const source = text(form, "source");
  const mode = text(form, "mode");
  const method = text(form, "method");
  const holdHours = Number(text(form, "holdHours"));
  if (mode === "guarantee" && !can(staff.actor, "reservation.guarantee", type.propertyId).allowed) return fail("guarantee_role");
  const result = await createStaffBooking(getDb(), {
    unitTypeId,
    unitId: UUID.test(unitId) ? unitId : null,
    checkIn: text(form, "checkIn"),
    checkOut: text(form, "checkOut"),
    adults: Number(text(form, "adults")),
    children: Number(text(form, "children") || "0"),
    guest: {
      fullName: text(form, "fullName").slice(0, 120),
      email: text(form, "email").slice(0, 200) || null,
      phone: text(form, "phone").slice(0, 40) || null,
      countryCode: text(form, "country").slice(0, 2) || null,
    },
    estimatedArrival: /^\d{2}:\d{2}$/.test(text(form, "arrival")) ? text(form, "arrival") : null,
    specialRequests: text(form, "requests").slice(0, 2000) || null,
    locale: lang,
    ratePlan: (RATE_PLANS as readonly string[]).includes(text(form, "ratePlan")) ? (text(form, "ratePlan") as RatePlan) : "standard",
    promoCode: text(form, "promo").slice(0, 20) || null,
    source: (STAFF_SOURCES as readonly string[]).includes(source) ? (source as StaffSource) : "direct",
    actorId: staff.staffId,
    role: staff.actor.role,
    discount: (() => {
      const d = parseDiscountInput(text(form, "discountKind"), text(form, "discountValue"));
      return d ? { ...d, reason: text(form, "discountReason") } : null;
    })(),
    payment:
      mode === "link"
        ? { kind: "link", holdHours: (LINK_HOLD_HOURS as readonly number[]).includes(holdHours) ? holdHours : 24 }
        : mode === "guarantee"
          ? { kind: "guarantee", reason: text(form, "guaranteeReason"), payBy: text(form, "payBy") }
          : {
            kind: "received",
            amount: Number(text(form, "amount").replace(/[^\d]/g, "")),
            method: (PAYMENT_METHODS as readonly string[]).includes(method) ? (method as PaymentMethod) : "other",
            reference: text(form, "reference") || null,
          },
  });

  if (!result.ok) {
    const e = result.error;
    if (e.kind === "invalid_amount") return fail("invalid_amount", { amountRange: { min: e.dueNow, max: e.total } });
    if (e.kind === "payment") return fail("payment");
    if (e.kind === "over_limit") return fail("over_limit", { limitBp: e.limitBp });
    if (e.kind === "guarantee") {
      return fail(e.error === "reason_required" ? "guarantee_reason_required" : e.error === "invalid_pay_by" ? "guarantee_invalid_pay_by" : "guarantee_failed");
    }
    return fail(e.kind);
  }

  const r = result.reservation;
  if (mode === "link") {
    try {
      const provider = getPaymentProvider();
      const returnUrl = new URL(`/${lang}/booking/${r.code}?t=${bookingAccessToken(r.code)}`, appUrl()).toString();
      const session = await provider.createCheckout(
        {
          amount: r.depositAmount,
          currency: r.currency,
          description: `${brand.name} · ${r.code}`,
          customer: { name: values.fullName, email: values.email || null, phone: values.phone || null },
          successUrl: returnUrl,
          failureUrl: returnUrl,
          expiresAt: r.holdExpiresAt ?? new Date(Date.now() + 60 * 60_000),
          locale: lang,
        },
        appUrl(),
      );
      await createPendingPayment(getDb(), {
        reservationId: r.id,
        provider: provider.name,
        providerRef: session.providerRef,
        purpose: r.depositAmount === r.totalAmount ? "full" : "deposit",
        amount: r.depositAmount,
        checkoutUrl: session.checkoutUrl,
        expiresAt: session.expiresAt,
      });
    } catch (error) {
      console.error("[ops] payment link failed", r.code, error);
      await getDb().update(schema.reservations).set({ status: "expired", updatedAt: new Date() }).where(eq(schema.reservations.id, r.id));
      return fail("payment");
    }
  }
  if (result.confirmed) deliverSoon();
  redirect(`/${lang}/ops/reservations/${r.code}?created=${result.confirmed ? "1" : "link"}`);
}
