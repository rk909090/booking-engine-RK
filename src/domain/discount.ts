import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { loadUnitTypes } from "./booking";
import { refundsPaid } from "./modify";
import { repriceStay, validDiscount } from "./pricing";
import type { Discount, DiscountTerms } from "./types";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Staff discounts on the nights' price. Each role has a ceiling set per
 * property (front office and branch manager); a reason is always required
 * and every change is in the audit log. Service and tax are charged on the
 * discounted price.
 */

export type DiscountRole = "front_office" | "branch_manager";

/** The largest discount a role may give at a property, in basis points of the nights' price. */
export function discountLimitBp(
  property: { discountLimitFrontOfficeBp: number; discountLimitManagerBp: number },
  role: string,
): number {
  // Directors give discounts up to the branch manager's limit.
  if (role === "branch_manager" || role === "director") return property.discountLimitManagerBp;
  if (role === "front_office") return property.discountLimitFrontOfficeBp;
  return 0;
}

/** Whether a discount amount stays within a ceiling of the nights' price (exact integer comparison). */
export function withinLimit(discountAmount: number, nightsSubtotal: number, limitBp: number): boolean {
  return discountAmount * 10_000 <= nightsSubtotal * limitBp;
}

export type DiscountError = "not_found" | "not_allowed" | "invalid_discount" | "reason_required" | "over_limit" | "smaller_than_offer";

export type DiscountResult =
  | { ok: true; total: number; discountAmount: number }
  | { ok: false; error: DiscountError; limitBp?: number };

/**
 * Gives, changes or removes (discount null) the discount of a confirmed or
 * in-house booking. Holds are excluded: their payment link is for a fixed
 * amount. A total that drops below what was paid leaves a refund owed.
 */
export async function setDiscount(
  db: AnyDb,
  input: {
    reservationId: string;
    discount: Discount | null;
    reason?: string | null;
    role: string;
    actor: { type: "staff"; id: string };
    now?: Date;
  },
): Promise<DiscountResult> {
  const now = input.now ?? new Date();
  const reason = input.reason?.trim().slice(0, 300) ?? "";
  if (input.discount && !validDiscount(input.discount)) return { ok: false, error: "invalid_discount" };
  if (input.discount && !reason) return { ok: false, error: "reason_required" };

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ r: schema.reservations, property: schema.properties })
      .from(schema.reservations)
      .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
      .where(eq(schema.reservations.id, input.reservationId))
      .for("update", { of: schema.reservations });
    if (!row) return { ok: false, error: "not_found" } as const;
    const { r, property } = row;
    if (r.status !== "confirmed" && r.status !== "in_house") return { ok: false, error: "not_allowed" } as const;

    const loaded = (await loadUnitTypes(tx, [r.unitTypeId])).get(r.unitTypeId);
    if (!loaded) return { ok: false, error: "not_found" } as const;
    const terms: DiscountTerms | null = input.discount ? { ...input.discount, reason, givenBy: input.actor.id, givenAt: now.toISOString() } : null;
    const price = repriceStay(loaded.rules, r.priceSnapshot ?? null, r.checkIn, r.checkOut, terms, r.pricingTerms ?? null);
    const off = price.discount ?? 0;
    // Only one discount applies besides the plan: a staff discount must beat the booking's best offer.
    const staffOff = price.staffDiscount ?? 0;
    if (terms && staffOff === 0) return { ok: false, error: "smaller_than_offer" } as const;
    const limitBp = discountLimitBp(property, input.role);
    if (terms && !withinLimit(staffOff, price.subtotal, limitBp)) return { ok: false, error: "over_limit", limitBp } as const;

    const total = price.total + r.extrasAmount;
    const paidOut = await refundsPaid(tx, r.id);
    const refundAmount = Math.max(paidOut, r.amountPaid - total);
    await tx
      .update(schema.reservations)
      .set({
        totalAmount: total,
        subtotalAmount: price.subtotal,
        serviceAmount: price.service,
        taxAmount: price.tax,
        discountAmount: off,
        discount: terms && staffOff > 0 ? terms : null,
        priceSnapshot: price,
        refundAmount: refundAmount > 0 ? refundAmount : null,
        updatedAt: now,
      })
      .where(eq(schema.reservations.id, r.id));
    await tx.insert(schema.auditEvents).values({
      actorType: input.actor.type,
      actorId: input.actor.id,
      propertyId: r.propertyId,
      entityType: "reservation",
      entityId: r.id,
      action: terms ? "reservation.discounted" : "reservation.discount_removed",
      before: { total: r.totalAmount, discount: r.discountAmount },
      after: { total, discount: off, terms: terms ?? null },
      occurredAt: now,
    });
    return { ok: true, total, discountAmount: off } as const;
  });
}
