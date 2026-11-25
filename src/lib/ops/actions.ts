"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import * as schema from "@/db/schema";
import { cancelReservation } from "@/domain/booking";
import { cancelLateCheckout, decideLateCheckout, requestLateCheckout } from "@/domain/late-checkout";
import { applyStayChange } from "@/domain/modify";
import { checkIn, checkOut, markNoShow, recordManualPayment, recordRefundPayout } from "@/domain/operations";
import { hasLocale, type Locale } from "@/i18n/config";
import { requireStaff } from "@/lib/auth/current-staff";
import { can, type Action, type Actor } from "@/lib/authz/permissions";
import { closeCheckouts, openCheckouts } from "@/lib/payments/checkouts";

/*
 * Staff actions on a reservation. Each one re-reads the session and checks
 * role and property scope on the server, then reports the outcome back to
 * the reservation page through a short code in the URL (no personal data).
 */

function field(form: FormData, key: string) {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

type Ctx = { reservationId: string; propertyId: string; unitId: string; staffId: string; actor: Actor };

/**
 * @param keepOnError query kept when the action fails, so the page can show
 *   the same form again (never personal data).
 */
async function run(
  form: FormData,
  action: Action,
  op: (ctx: Ctx) => Promise<{ ok: true } | { ok: false; error: string }>,
  keepOnError = "",
) {
  const langRaw = field(form, "lang");
  const lang: Locale = hasLocale(langRaw) ? langRaw : "id";
  const code = field(form, "code").toUpperCase();
  const back: (query: string) => never = (query) => redirect(`/${lang}/ops/reservations/${encodeURIComponent(code)}?${query}`);

  const staff = await requireStaff(lang);
  const [r] = await getDb()
    .select({ id: schema.reservations.id, propertyId: schema.reservations.propertyId, unitId: schema.reservations.unitId })
    .from(schema.reservations)
    .where(eq(schema.reservations.code, code))
    .limit(1);
  if (!r) back("error=not_found");
  const decision = can(staff.actor, action, r.propertyId);
  if (!decision.allowed) back(decision.reason === "outside_property_scope" ? "error=not_found" : "error=role");

  const result = await op({ reservationId: r.id, propertyId: r.propertyId, unitId: r.unitId, staffId: staff.staffId, actor: staff.actor });
  back(result.ok ? "done=1" : `${keepOnError ? `${keepOnError}&` : ""}error=${result.error}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Confirms a previewed change of dates and/or villa. */
export async function changeStayAction(form: FormData) {
  const checkInDate = field(form, "newIn");
  const checkOutDate = field(form, "newOut");
  const unitId = field(form, "unit");
  const expectedTotal = Number(field(form, "expectedTotal"));
  const keep = new URLSearchParams({ newIn: checkInDate, newOut: checkOutDate, unit: unitId }).toString();
  await run(
    form,
    "reservation.modify",
    async (ctx) => {
      if (!UUID.test(unitId) || !Number.isSafeInteger(expectedTotal)) return { ok: false, error: "invalid_dates" };
      // Moving to another villa is its own permission.
      if (unitId !== ctx.unitId && !can(ctx.actor, "reservation.move", ctx.propertyId).allowed) return { ok: false, error: "role" };
      const result = await applyStayChange(getDb(), {
        reservationId: ctx.reservationId,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        unitId,
        expectedTotal,
        actor: { type: "staff", id: ctx.staffId },
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    keep,
  );
}

export async function checkInAction(form: FormData) {
  await run(form, "reservation.check_in", ({ reservationId, staffId }) =>
    checkIn(getDb(), { reservationId, actor: { type: "staff", id: staffId } }),
  );
}

export async function checkOutAction(form: FormData) {
  await run(form, "reservation.check_out", ({ reservationId, staffId }) =>
    checkOut(getDb(), {
      reservationId,
      actor: { type: "staff", id: staffId },
      acknowledgeBalance: form.get("acknowledgeBalance") === "on",
    }),
  );
}

export async function noShowAction(form: FormData) {
  await run(form, "reservation.no_show", ({ reservationId, staffId }) =>
    markNoShow(getDb(), { reservationId, actor: { type: "staff", id: staffId } }),
  );
}

export async function cancelAction(form: FormData) {
  await run(form, "reservation.cancel", async ({ reservationId, staffId }) => {
    const links = await openCheckouts(reservationId);
    const result = await cancelReservation(getDb(), {
      reservationId,
      actor: { type: "staff", id: staffId },
      reason: field(form, "reason").slice(0, 500) || null,
    });
    if (result.ok) await closeCheckouts(reservationId, links);
    return result.ok ? { ok: true } : { ok: false, error: result.error === "not_found" ? "not_found" : "final_status" };
  });
}

export async function refundAction(form: FormData) {
  await run(form, "payment.refund", ({ reservationId, staffId }) =>
    recordRefundPayout(getDb(), {
      reservationId,
      amount: Number(field(form, "amount").replace(/[^\d]/g, "")),
      reference: field(form, "reference"),
      actor: { type: "staff", id: staffId },
    }),
  );
}

/** Money received at the front desk: confirms a hold, or pays toward the balance. */
export async function recordPaymentAction(form: FormData) {
  await run(form, "payment.record", async ({ reservationId, staffId }) => {
    const links = await openCheckouts(reservationId);
    const result = await recordManualPayment(getDb(), {
      reservationId,
      amount: Number(field(form, "amount").replace(/[^\d]/g, "")),
      method: field(form, "method"),
      reference: field(form, "reference") || null,
      actor: { type: "staff", id: staffId },
    });
    if (result.ok) {
      // Confirming a hold closes its payment links (the database side is done already).
      if (result.confirmed) await closeCheckouts(reservationId, links);
      return { ok: true };
    }
    return { ok: false, error: result.error === "invalid_amount" ? "payment_amount" : result.error };
  });
}

const lateError = (e: string) => (e === "not_found" ? e : `late_${e}`);

/** Records a guest's request to check out late. */
export async function requestLateCheckoutAction(form: FormData) {
  await run(form, "reservation.modify", async ({ reservationId, staffId }) => {
    const result = await requestLateCheckout(getDb(), {
      reservationId,
      time: field(form, "time").slice(0, 5),
      note: field(form, "note") || null,
      actor: { type: "staff", id: staffId },
    });
    return result.ok ? { ok: true } : { ok: false, error: lateError(result.error) };
  });
}

/** Approves (with an optional fee) or declines a pending late check-out. */
export async function decideLateCheckoutAction(form: FormData) {
  await run(form, "reservation.modify", async ({ reservationId, staffId }) => {
    const approve = field(form, "decision") === "approve";
    const result = await decideLateCheckout(getDb(), {
      reservationId,
      approve,
      fee: approve ? Number(field(form, "fee").replace(/[^\d]/g, "") || "0") : 0,
      note: field(form, "note") || null,
      actor: { type: "staff", id: staffId },
    });
    return result.ok ? { ok: true } : { ok: false, error: lateError(result.error) };
  });
}

/** Withdraws a late check-out request or approval. */
export async function cancelLateCheckoutAction(form: FormData) {
  await run(form, "reservation.modify", async ({ reservationId, staffId }) => {
    const result = await cancelLateCheckout(getDb(), { reservationId, actor: { type: "staff", id: staffId } });
    return result.ok ? { ok: true } : { ok: false, error: lateError(result.error) };
  });
}
