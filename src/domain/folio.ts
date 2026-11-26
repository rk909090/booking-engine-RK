import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { todayIn } from "./dates";
import { PAYMENT_METHODS } from "./operations";
import { balanceDue } from "./pricing";
import { randomBytes } from "node:crypto";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Actor = { type: "staff"; id: string };
type Reservation = typeof schema.reservations.$inferSelect;

/*
 * Folio: extra charges on a booking and the invoices for it (decided with the
 * owner, 26 Nov 2026):
 * - Charges are entered by category with a free description, quantity and
 *   unit price. Prices include tax and service (like the late check-out fee).
 * - A charge is paid by the guest (it joins the booking total) or billed to
 *   another party (split bill: a company, an agent, a second guest), which
 *   gets its own invoice and records its own payments.
 * - Invoices are numbered per property and year (INV-UBUD-2026-00001); the
 *   number is fixed once issued and the content shows the bill as it stands.
 *   Each payment has a receipt.
 * A charge is never deleted: voiding it (with a reason) takes it off the bill
 * and leaves a refund owed if it was already paid.
 */

export const FOLIO_CATEGORIES = schema.folioCategories;
export type FolioCategory = (typeof FOLIO_CATEGORIES)[number];
const CHARGEABLE: Reservation["status"][] = ["confirmed", "in_house", "checked_out"];
const MAX_PRICE = 10_000_000_000;

export type FolioError =
  | "not_found"
  | "not_allowed"
  | "invalid_category"
  | "invalid_description"
  | "invalid_quantity"
  | "invalid_price"
  | "invalid_party"
  | "already_void"
  | "reason_required"
  | "invalid_amount"
  | "invalid_method"
  | "invalid_name";

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: FolioError };

async function lockReservation(tx: Tx, reservationId: string) {
  const [row] = await tx
    .select({ r: schema.reservations, timezone: schema.properties.timezone })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, reservationId))
    .for("update", { of: schema.reservations });
  return row ?? null;
}

async function audit(tx: Tx, r: Reservation, actor: Actor, action: string, after: object, now: Date) {
  await tx.insert(schema.auditEvents).values({
    actorType: actor.type,
    actorId: actor.id,
    propertyId: r.propertyId,
    entityType: "reservation",
    entityId: r.id,
    action,
    after,
    occurredAt: now,
  });
}

async function partyOf(tx: Tx | AnyDb, reservationId: string, partyId: string) {
  const [party] = await tx
    .select()
    .from(schema.folioParties)
    .where(and(eq(schema.folioParties.id, partyId), eq(schema.folioParties.reservationId, reservationId)));
  return party ?? null;
}

/** Adds another party who pays part of the bill. */
export async function addParty(
  db: AnyDb,
  input: { reservationId: string; name: string; details?: string | null; email?: string | null; actor: Actor; now?: Date },
): Promise<Result<{ partyId: string }>> {
  const now = input.now ?? new Date();
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (name.length < 2) return { ok: false, error: "invalid_name" };
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    if (!CHARGEABLE.includes(row.r.status)) return { ok: false, error: "not_allowed" } as const;
    const [party] = await tx
      .insert(schema.folioParties)
      .values({
        reservationId: row.r.id,
        name,
        details: input.details?.trim().slice(0, 500) || null,
        email: input.email?.trim().slice(0, 200) || null,
        createdBy: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.folioParties.id });
    await audit(tx, row.r, input.actor, "folio.party_added", { name }, now);
    return { ok: true, partyId: party.id } as const;
  });
}

/** Adds a charge, paid by the guest (joins the booking total) or billed to another party. */
export async function addCharge(
  db: AnyDb,
  input: {
    reservationId: string;
    category: string;
    description: string;
    quantity: number;
    unitPrice: number;
    partyId?: string | null;
    actor: Actor;
    now?: Date;
  },
): Promise<Result<{ chargeId: string; amount: number }>> {
  const now = input.now ?? new Date();
  if (!(FOLIO_CATEGORIES as readonly string[]).includes(input.category)) return { ok: false, error: "invalid_category" };
  const description = input.description.trim().replace(/\s+/g, " ").slice(0, 200);
  if (!description) return { ok: false, error: "invalid_description" };
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 999) return { ok: false, error: "invalid_quantity" };
  if (!Number.isSafeInteger(input.unitPrice) || input.unitPrice < 0 || input.unitPrice > MAX_PRICE) return { ok: false, error: "invalid_price" };
  const amount = input.quantity * input.unitPrice;
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const { r } = row;
    if (!CHARGEABLE.includes(r.status)) return { ok: false, error: "not_allowed" } as const;
    if (input.partyId && !(await partyOf(tx, r.id, input.partyId))) return { ok: false, error: "invalid_party" } as const;
    const [charge] = await tx
      .insert(schema.folioCharges)
      .values({
        reservationId: r.id,
        partyId: input.partyId ?? null,
        category: input.category,
        description,
        quantity: input.quantity,
        unitPrice: input.unitPrice,
        amount,
        chargeDate: todayIn(row.timezone, now),
        createdBy: input.actor.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: schema.folioCharges.id });
    if (!input.partyId && amount > 0) {
      await tx
        .update(schema.reservations)
        .set({ extrasAmount: r.extrasAmount + amount, totalAmount: r.totalAmount + amount, updatedAt: now })
        .where(eq(schema.reservations.id, r.id));
    }
    await audit(tx, r, input.actor, "folio.charge_added", { category: input.category, description, quantity: input.quantity, amount, party: input.partyId ?? null }, now);
    return { ok: true, chargeId: charge.id, amount } as const;
  });
}

/** Takes a charge off the bill. A guest charge already paid leaves a refund owed. */
export async function voidCharge(
  db: AnyDb,
  input: { reservationId: string; chargeId: string; reason: string; actor: Actor; now?: Date },
): Promise<Result> {
  const now = input.now ?? new Date();
  const reason = input.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, error: "reason_required" };
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const { r } = row;
    const [charge] = await tx
      .select()
      .from(schema.folioCharges)
      .where(and(eq(schema.folioCharges.id, input.chargeId), eq(schema.folioCharges.reservationId, r.id)))
      .for("update");
    if (!charge) return { ok: false, error: "not_found" } as const;
    if (charge.status === "void") return { ok: false, error: "already_void" } as const;
    await tx
      .update(schema.folioCharges)
      .set({ status: "void", voidReason: reason, voidedBy: input.actor.id, voidedAt: now, updatedAt: now })
      .where(eq(schema.folioCharges.id, charge.id));
    if (!charge.partyId && charge.amount > 0) {
      const total = r.totalAmount - charge.amount;
      const overpaid = r.amountPaid - total;
      await tx
        .update(schema.reservations)
        .set({
          extrasAmount: r.extrasAmount - charge.amount,
          totalAmount: total,
          refundAmount: overpaid > (r.refundAmount ?? 0) ? overpaid : r.refundAmount,
          updatedAt: now,
        })
        .where(eq(schema.reservations.id, r.id));
    }
    await audit(tx, r, input.actor, "folio.charge_voided", { description: charge.description, amount: charge.amount, reason }, now);
    return { ok: true } as const;
  });
}

/** What each other party owes: their active charges less their payments. */
export async function partyBalances(db: AnyDb | Tx, reservationId: string) {
  const parties = await db
    .select()
    .from(schema.folioParties)
    .where(eq(schema.folioParties.reservationId, reservationId))
    .orderBy(asc(schema.folioParties.createdAt));
  if (parties.length === 0) return [];
  const ids = parties.map((p) => p.id);
  const [charges, payments] = await Promise.all([
    db
      .select({ partyId: schema.folioCharges.partyId, total: sql<number>`coalesce(sum(${schema.folioCharges.amount}), 0)::bigint` })
      .from(schema.folioCharges)
      .where(and(inArray(schema.folioCharges.partyId, ids), eq(schema.folioCharges.status, "active")))
      .groupBy(schema.folioCharges.partyId),
    db
      .select({ partyId: schema.payments.folioPartyId, total: sql<number>`coalesce(sum(${schema.payments.amount}), 0)::bigint` })
      .from(schema.payments)
      .where(and(inArray(schema.payments.folioPartyId, ids), eq(schema.payments.status, "paid")))
      .groupBy(schema.payments.folioPartyId),
  ]);
  return parties.map((p) => {
    const total = Number(charges.find((c) => c.partyId === p.id)?.total ?? 0);
    const paid = Number(payments.find((c) => c.partyId === p.id)?.total ?? 0);
    return { ...p, total, paid, balance: total - paid };
  });
}

/** Records money another party paid toward their own charges (cash, transfer, card machine). */
export async function recordPartyPayment(
  db: AnyDb,
  input: { reservationId: string; partyId: string; amount: number; method: string; reference?: string | null; actor: Actor; now?: Date },
): Promise<Result> {
  const now = input.now ?? new Date();
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) return { ok: false, error: "invalid_method" };
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const party = (await partyBalances(tx, row.r.id)).find((p) => p.id === input.partyId);
    if (!party) return { ok: false, error: "invalid_party" } as const;
    if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > party.balance) return { ok: false, error: "invalid_amount" } as const;
    const reference = input.reference?.trim().slice(0, 200) || null;
    await tx.insert(schema.payments).values({
      reservationId: row.r.id,
      provider: "manual",
      providerRef: `party_${randomBytes(9).toString("base64url")}`,
      purpose: "balance",
      amount: input.amount,
      status: "paid",
      paidAt: now,
      folioPartyId: party.id,
      raw: { method: input.method, reference, recordedBy: input.actor.id },
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, row.r, input.actor, "folio.party_payment", { party: party.name, amount: input.amount, method: input.method, reference }, now);
    return { ok: true } as const;
  });
}

/** Short property code for invoice numbers ("ubud" → "UBUD"). */
const propertyCode = (slug: string) => slug.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 8) || "PROP";

/**
 * Issues the invoice for the guest (partyId null) or for a party, numbering it
 * once (INV-<property>-<year>-<5 digits>). Issuing again returns the same invoice.
 */
export async function issueInvoice(
  db: AnyDb,
  input: { reservationId: string; partyId?: string | null; actor?: Actor | null; now?: Date },
): Promise<Result<{ number: string }>> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const row = await lockReservation(tx, input.reservationId);
    if (!row) return { ok: false, error: "not_found" } as const;
    const { r } = row;
    if (input.partyId && !(await partyOf(tx, r.id, input.partyId))) return { ok: false, error: "invalid_party" } as const;
    const [existing] = await tx
      .select({ number: schema.invoices.number })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.reservationId, r.id), input.partyId ? eq(schema.invoices.partyId, input.partyId) : isNull(schema.invoices.partyId)));
    if (existing) return { ok: true, number: existing.number } as const;
    if (!CHARGEABLE.includes(r.status)) return { ok: false, error: "not_allowed" } as const;
    const [property] = await tx.select({ slug: schema.properties.slug }).from(schema.properties).where(eq(schema.properties.id, r.propertyId));
    const year = Number(todayIn(row.timezone, now).slice(0, 4));
    const [counter] = await tx
      .insert(schema.invoiceCounters)
      .values({ propertyId: r.propertyId, year, last: 1 })
      .onConflictDoUpdate({ target: [schema.invoiceCounters.propertyId, schema.invoiceCounters.year], set: { last: sql`${schema.invoiceCounters.last} + 1` } })
      .returning({ last: schema.invoiceCounters.last });
    const number = `INV-${propertyCode(property.slug)}-${year}-${String(counter.last).padStart(5, "0")}`;
    await tx.insert(schema.invoices).values({ reservationId: r.id, partyId: input.partyId ?? null, number, issuedAt: now, issuedBy: input.actor?.id ?? null, createdAt: now, updatedAt: now });
    if (input.actor) await audit(tx, r, input.actor, "folio.invoice_issued", { number, party: input.partyId ?? null }, now);
    return { ok: true, number } as const;
  });
}

export type InvoiceLine = { kind: "nights" | "discount" | "service" | "tax" | "late" | "early" | "charge" | "other"; label: string; quantity?: number; unitPrice?: number; amount: number; date?: string };

/**
 * Everything an invoice shows, for the guest (partyId null) or a party: lines
 * that add up to the total, payments (and refunds for the guest), balance.
 */
export async function invoiceData(db: AnyDb, input: { reservationId: string; partyId?: string | null }) {
  const [row] = await db
    .select({
      r: schema.reservations,
      guest: schema.guests,
      property: schema.properties,
      typeName: schema.unitTypes.name,
      unitCode: schema.units.code,
    })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .innerJoin(schema.unitTypes, eq(schema.unitTypes.id, schema.reservations.unitTypeId))
    .innerJoin(schema.units, eq(schema.units.id, schema.reservations.unitId))
    .where(eq(schema.reservations.id, input.reservationId));
  if (!row) return null;
  const { r } = row;
  const party = input.partyId ? await partyOf(db, r.id, input.partyId) : null;
  if (input.partyId && !party) return null;
  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.reservationId, r.id), party ? eq(schema.invoices.partyId, party.id) : isNull(schema.invoices.partyId)));
  const charges = await db
    .select()
    .from(schema.folioCharges)
    .where(
      and(
        eq(schema.folioCharges.reservationId, r.id),
        eq(schema.folioCharges.status, "active"),
        party ? eq(schema.folioCharges.partyId, party.id) : isNull(schema.folioCharges.partyId),
      ),
    )
    .orderBy(asc(schema.folioCharges.chargeDate), asc(schema.folioCharges.createdAt));
  const allPayments = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.reservationId, r.id), eq(schema.payments.status, "paid")))
    .orderBy(asc(schema.payments.paidAt));
  const payments = allPayments.filter((p) => (party ? p.folioPartyId === party.id : p.folioPartyId === null));

  const lines: InvoiceLine[] = [];
  let total: number;
  let paid: number;
  let balance: number;
  if (!party) {
    const nights = r.priceSnapshot?.nights.length ?? 0;
    lines.push({ kind: "nights", label: `${row.typeName} · ${row.unitCode}`, quantity: nights || undefined, amount: r.subtotalAmount });
    if (r.discountAmount) lines.push({ kind: "discount", label: r.discount?.reason ?? "", amount: -r.discountAmount });
    if (r.serviceAmount) lines.push({ kind: "service", label: "", amount: r.serviceAmount });
    if (r.taxAmount) lines.push({ kind: "tax", label: "", amount: r.taxAmount });
    const [late, early] = await Promise.all([
      db
        .select({ time: schema.lateCheckoutRequests.requestedTime, fee: schema.lateCheckoutRequests.fee, date: schema.lateCheckoutRequests.forDate })
        .from(schema.lateCheckoutRequests)
        .where(and(eq(schema.lateCheckoutRequests.reservationId, r.id), eq(schema.lateCheckoutRequests.status, "approved"))),
      db
        .select({ time: schema.earlyCheckinRequests.requestedTime, fee: schema.earlyCheckinRequests.fee, date: schema.earlyCheckinRequests.forDate })
        .from(schema.earlyCheckinRequests)
        .where(and(eq(schema.earlyCheckinRequests.reservationId, r.id), eq(schema.earlyCheckinRequests.status, "approved"))),
    ]);
    for (const e of early.filter((x) => x.fee > 0)) lines.push({ kind: "early", label: e.time.slice(0, 5), amount: e.fee, date: e.date });
    for (const l of late.filter((x) => x.fee > 0)) lines.push({ kind: "late", label: l.time.slice(0, 5), amount: l.fee, date: l.date });
    for (const c of charges) lines.push({ kind: "charge", label: c.description, quantity: c.quantity, unitPrice: c.unitPrice, amount: c.amount, date: c.chargeDate });
    // Older bookings may carry extras recorded before the folio existed: keep the total right.
    const listed = lines.reduce((s, l) => s + l.amount, 0);
    if (listed !== r.totalAmount) lines.push({ kind: "other", label: "", amount: r.totalAmount - listed });
    total = r.totalAmount;
    paid = r.amountPaid;
    balance = balanceDue(r);
  } else {
    for (const c of charges) lines.push({ kind: "charge", label: c.description, quantity: c.quantity, unitPrice: c.unitPrice, amount: c.amount, date: c.chargeDate });
    total = charges.reduce((s, c) => s + c.amount, 0);
    paid = payments.reduce((s, p) => s + p.amount, 0);
    balance = total - paid;
  }
  return {
    ...row,
    party,
    invoice: invoice ?? null,
    lines,
    payments: payments.filter((p) => p.purpose !== "refund"),
    refunds: party ? [] : payments.filter((p) => p.purpose === "refund"),
    total,
    paid,
    balance,
  };
}

/** A payment's receipt: the payment, its booking, and its receipt number (<code>-<n>, n in payment order). */
export async function receiptData(db: AnyDb, input: { reservationId: string; paymentId: string }) {
  const data = await db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.reservationId, input.reservationId), eq(schema.payments.status, "paid")))
    .orderBy(asc(schema.payments.paidAt), asc(schema.payments.createdAt));
  const received = data.filter((p) => p.purpose !== "refund");
  const index = received.findIndex((p) => p.id === input.paymentId);
  if (index < 0) return null;
  const [row] = await db
    .select({ r: schema.reservations, guest: schema.guests, property: schema.properties })
    .from(schema.reservations)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, input.reservationId));
  if (!row) return null;
  const payment = received[index];
  const party = payment.folioPartyId ? await partyOf(db, input.reservationId, payment.folioPartyId) : null;
  return { ...row, payment, party, number: `${row.r.code}-${index + 1}` };
}
