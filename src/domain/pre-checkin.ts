import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { addDays, isIsoDate, todayIn } from "./dates";
import { syncRequestTask } from "./tasks";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/*
 * Online pre-check-in (decided with the owner, 25 Nov 2026). Before arrival the
 * guest fills in, from their booking page:
 * - arrival details: estimated arrival time, flight and landing time, and
 *   whether they want an airport transfer (staff follow up on the price);
 * - every adult guest: full name, nationality, date of birth, and the type and
 *   number of their passport or ID card (foreign guests must be reported to
 *   immigration);
 * - requests and preferences, and agreement to the house rules.
 * It can be changed until the arrival day. Document numbers are encrypted
 * (the caller passes the sealing function), shown to the front desk masked
 * unless revealed (each reveal is logged), and erased 30 days after
 * check-out, or right away once a booking is cancelled or a no-show. The
 * document itself is still checked at the desk.
 */

export const DOCUMENT_RETENTION_DAYS = 30;
export const DOCUMENT_TYPES = ["passport", "id_card"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export type PreCheckinGuestInput = {
  fullName: string;
  nationality: string;
  birthDate: string;
  documentType: string;
  /** Empty keeps the number saved before for this guest. */
  documentNumber: string;
};

export type PreCheckinInput = {
  reservationId: string;
  arrivalTime: string;
  flightNumber: string;
  landingDate: string;
  landingTime: string;
  transferRequested: boolean;
  transferNote: string;
  requests: string;
  acceptRules: boolean;
  guests: PreCheckinGuestInput[];
  now?: Date;
};

export type PreCheckinField = "fullName" | "nationality" | "birthDate" | "documentType" | "documentNumber";
export type PreCheckinError =
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "rules_required" }
  | { kind: "guest_count"; expected: number }
  | { kind: "guest"; index: number; field: PreCheckinField }
  | { kind: "arrival_time" }
  | { kind: "flight" }
  | { kind: "rate_limited" };

/** Normalised document number: letters and digits only, upper case. */
export function cleanDocumentNumber(value: string): string {
  return value.replace(/[^0-9a-z]/gi, "").toUpperCase();
}

export function validDocumentNumber(value: string): boolean {
  return /^[0-9A-Z]{5,20}$/.test(value);
}

type Reservation = typeof schema.reservations.$inferSelect;

/** Pre-check-in is open for confirmed bookings until the arrival day. */
export function preCheckinOpen(r: Pick<Reservation, "status" | "checkIn">, today: string): boolean {
  return r.status === "confirmed" && r.checkIn >= today;
}

async function load(db: AnyDb, reservationId: string) {
  const [row] = await db
    .select({ r: schema.reservations, timezone: schema.properties.timezone })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.id, reservationId));
  return row ?? null;
}

async function current(db: AnyDb, reservationId: string) {
  const [pre] = await db.select().from(schema.preCheckins).where(eq(schema.preCheckins.reservationId, reservationId));
  if (!pre) return null;
  const guests = await db
    .select()
    .from(schema.preCheckinGuests)
    .where(eq(schema.preCheckinGuests.preCheckinId, pre.id))
    .orderBy(asc(schema.preCheckinGuests.position));
  return { pre, guests };
}

/**
 * Saves (or replaces) the guest's pre-check-in. `seal` encrypts a document
 * number; numbers left empty keep what was saved before for that guest.
 */
export async function savePreCheckin(
  db: AnyDb,
  input: PreCheckinInput,
  seal: (plain: string) => string,
): Promise<{ ok: true; updated: boolean } | { ok: false; error: PreCheckinError }> {
  const now = input.now ?? new Date();
  const row = await load(db, input.reservationId);
  if (!row) return { ok: false, error: { kind: "not_found" } };
  const { r } = row;
  const today = todayIn(row.timezone, now);
  if (!preCheckinOpen(r, today)) return { ok: false, error: { kind: "closed" } };
  if (!input.acceptRules) return { ok: false, error: { kind: "rules_required" } };
  if (input.guests.length !== r.adults) return { ok: false, error: { kind: "guest_count", expected: r.adults } };

  const arrival = input.arrivalTime.trim();
  if (arrival && !HHMM.test(arrival)) return { ok: false, error: { kind: "arrival_time" } };
  const flight = input.flightNumber.replace(/\s/g, "").toUpperCase();
  const landingDate = input.landingDate.trim();
  const landingTime = input.landingTime.trim();
  if ((flight && !/^[0-9A-Z]{2,8}$/.test(flight)) || (landingDate && !isIsoDate(landingDate)) || (landingTime && !HHMM.test(landingTime))) {
    return { ok: false, error: { kind: "flight" } };
  }
  if (landingDate && (landingDate < addDays(r.checkIn, -2) || landingDate > r.checkIn)) return { ok: false, error: { kind: "flight" } };

  const before = await current(db, r.id);
  const guests: Array<typeof schema.preCheckinGuests.$inferInsert> = [];
  for (const [index, g] of input.guests.entries()) {
    const fullName = g.fullName.trim().replace(/\s+/g, " ");
    if (fullName.length < 2 || fullName.length > 120) return { ok: false, error: { kind: "guest", index, field: "fullName" } };
    const nationality = g.nationality.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(nationality)) return { ok: false, error: { kind: "guest", index, field: "nationality" } };
    if (!isIsoDate(g.birthDate) || g.birthDate < "1900-01-01" || g.birthDate > today) return { ok: false, error: { kind: "guest", index, field: "birthDate" } };
    if (!(DOCUMENT_TYPES as readonly string[]).includes(g.documentType)) return { ok: false, error: { kind: "guest", index, field: "documentType" } };
    const number = cleanDocumentNumber(g.documentNumber);
    const kept = before?.guests.find((x) => x.position === index && x.documentNumberEnc);
    if (number && !validDocumentNumber(number)) return { ok: false, error: { kind: "guest", index, field: "documentNumber" } };
    if (!number && !kept) return { ok: false, error: { kind: "guest", index, field: "documentNumber" } };
    guests.push({
      preCheckinId: "",
      position: index,
      fullName,
      nationality,
      birthDate: g.birthDate,
      documentType: g.documentType,
      documentNumberEnc: number ? seal(number) : kept!.documentNumberEnc,
      documentLast4: number ? number.slice(-4) : kept!.documentLast4,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db.transaction(async (tx) => {
    const values = {
      flightNumber: flight || null,
      landingDate: landingDate || null,
      landingTime: landingTime || null,
      transferRequested: input.transferRequested,
      transferNote: input.transferNote.trim().slice(0, 300) || null,
      requests: input.requests.trim().slice(0, 1000) || null,
      houseRulesAcceptedAt: now,
      submittedAt: now,
      updatedAt: now,
    };
    const [pre] = await tx
      .insert(schema.preCheckins)
      .values({ reservationId: r.id, ...values, createdAt: now })
      .onConflictDoUpdate({ target: schema.preCheckins.reservationId, set: values })
      .returning({ id: schema.preCheckins.id });
    await tx.delete(schema.preCheckinGuests).where(eq(schema.preCheckinGuests.preCheckinId, pre.id));
    await tx.insert(schema.preCheckinGuests).values(guests.map((g) => ({ ...g, preCheckinId: pre.id })));
    if (arrival) {
      await tx.update(schema.reservations).set({ estimatedArrival: arrival, updatedAt: now }).where(eq(schema.reservations.id, r.id));
    }
    await syncRequestTask(tx, { reservationId: r.id, source: "precheckin", text: input.requests, now });
    await tx.insert(schema.auditEvents).values({
      actorType: "guest",
      propertyId: r.propertyId,
      entityType: "reservation",
      entityId: r.id,
      action: before ? "pre_checkin.updated" : "pre_checkin.submitted",
      // No personal data in the log: only what changed in kind.
      after: { guests: guests.length, transfer: input.transferRequested, arrival: arrival || null, flight: Boolean(flight) },
      occurredAt: now,
    });
  });
  return { ok: true, updated: Boolean(before) };
}

/** What a pre-check-in shows: document numbers masked (last four characters only). */
export async function preCheckinView(db: AnyDb, reservationId: string) {
  const found = await current(db, reservationId);
  if (!found) return null;
  return {
    ...found.pre,
    guests: found.guests.map((g) => ({
      position: g.position,
      fullName: g.fullName,
      nationality: g.nationality,
      birthDate: g.birthDate,
      documentType: g.documentType,
      documentLast4: g.documentLast4,
      hasDocument: g.documentNumberEnc !== null,
      documentErased: g.documentErasedAt !== null,
    })),
  };
}

/**
 * Document numbers in full for the front desk; each reveal is logged. `open`
 * decrypts a sealed number (null when it cannot be read).
 */
export async function revealDocuments(
  db: AnyDb,
  input: { reservationId: string; actor: { type: "staff"; id: string }; now?: Date },
  open: (sealed: string) => string | null,
): Promise<Array<{ position: number; documentNumber: string | null }> | null> {
  const now = input.now ?? new Date();
  const found = await current(db, input.reservationId);
  const row = await load(db, input.reservationId);
  if (!found || !row) return null;
  await db.insert(schema.auditEvents).values({
    actorType: input.actor.type,
    actorId: input.actor.id,
    propertyId: row.r.propertyId,
    entityType: "reservation",
    entityId: row.r.id,
    action: "pre_checkin.documents_viewed",
    after: { guests: found.guests.filter((g) => g.documentNumberEnc).length },
    occurredAt: now,
  });
  return found.guests.map((g) => ({ position: g.position, documentNumber: g.documentNumberEnc ? open(g.documentNumberEnc) : null }));
}

/**
 * Erases document numbers that are no longer needed: 30 days after check-out,
 * or as soon as the booking is cancelled, expired or a no-show. Safe to run
 * at any time; returns how many were erased.
 */
export async function eraseExpiredDocuments(db: AnyDb, today: string, now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: schema.preCheckinGuests.id })
    .from(schema.preCheckinGuests)
    .innerJoin(schema.preCheckins, eq(schema.preCheckins.id, schema.preCheckinGuests.preCheckinId))
    .innerJoin(schema.reservations, eq(schema.reservations.id, schema.preCheckins.reservationId))
    .where(
      and(
        isNotNull(schema.preCheckinGuests.documentNumberEnc),
        sql`(${schema.reservations.status} IN ('cancelled', 'expired', 'no_show')
          OR ${schema.reservations.checkOut} + ${DOCUMENT_RETENTION_DAYS}::int < ${today}::date)`,
      ),
    );
  if (due.length === 0) return 0;
  await db
    .update(schema.preCheckinGuests)
    .set({ documentNumberEnc: null, documentLast4: null, documentErasedAt: now, updatedAt: now })
    .where(inArray(schema.preCheckinGuests.id, due.map((d) => d.id)));
  return due.length;
}
