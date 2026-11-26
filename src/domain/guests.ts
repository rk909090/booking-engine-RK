import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { diffDays } from "./dates";

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;
type Tx = Parameters<Parameters<AnyDb["transaction"]>[0]>[0];
type Executor = AnyDb | Tx;
type Actor = { type: "staff"; id: string };

/*
 * Guest profiles (rules agreed with the owner, 26 Nov 2026):
 * - a new booking joins an existing profile with the same email, or the same
 *   phone number when that profile has no other email (so an agent's phone
 *   used for several guests does not merge them); other duplicates are
 *   merged by staff;
 * - staff keep internal notes, preferences and tags; returning guests and
 *   VIPs are flagged on their bookings;
 * - on request (UU PDP) a branch manager exports everything held about a
 *   guest and can erase the personal data: names and contact details go,
 *   bookings and money stay for the accounts;
 * - foreign guests are listed for the immigration report (APOA) from the
 *   pre-check-in data, exported, and marked as reported.
 */

export const GUEST_TAGS = ["vip", "honeymoon", "family", "business", "caution"] as const;
export type GuestTag = (typeof GUEST_TAGS)[number];

/** Digits only; Indonesian numbers written from 0 become 62…. Null when too short to identify anyone. */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const n = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return n.length >= 8 ? n : null;
}

const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * The profile a booking belongs to: an existing guest with this email, or
 * with this phone and no different email; otherwise a new one. Missing
 * contact details are filled in; the name on the profile is kept.
 */
export async function findOrCreateGuest(
  db: Executor,
  input: { fullName: string; email: string | null; phone: string | null; countryCode: string | null },
): Promise<string> {
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim() || null;
  const phoneNormalized = normalizePhone(phone);
  const country = input.countryCode?.trim().toUpperCase().slice(0, 2) || null;
  let found: typeof schema.guests.$inferSelect | undefined;
  if (email) {
    [found] = await db
      .select()
      .from(schema.guests)
      .where(and(sql`lower(${schema.guests.email}) = ${email}`, isNull(schema.guests.anonymizedAt)))
      .orderBy(asc(schema.guests.createdAt))
      .limit(1);
  }
  if (!found && phoneNormalized) {
    [found] = await db
      .select()
      .from(schema.guests)
      .where(and(eq(schema.guests.phoneNormalized, phoneNormalized), isNull(schema.guests.anonymizedAt), email ? isNull(schema.guests.email) : undefined))
      .orderBy(asc(schema.guests.createdAt))
      .limit(1);
  }
  if (found) {
    const fill = {
      ...(!found.email && email ? { email } : {}),
      ...(!found.phone && phone ? { phone, phoneNormalized } : {}),
      ...(!found.countryCode && country ? { countryCode: country } : {}),
    };
    if (Object.keys(fill).length) await db.update(schema.guests).set({ ...fill, updatedAt: new Date() }).where(eq(schema.guests.id, found.id));
    return found.id;
  }
  const [row] = await db
    .insert(schema.guests)
    .values({ fullName: input.fullName.trim(), email, phone, phoneNormalized, countryCode: country })
    .returning({ id: schema.guests.id });
  return row.id;
}

export type GuestStats = { stays: number; nights: number; spend: number; upcoming: number; lastStay: string | null };

/** Stays (checked out), nights, spend (checked out and in house), upcoming bookings, last departure. */
export async function guestStats(db: Executor, guestIds: string[], propertyIds?: readonly string[] | null): Promise<Map<string, GuestStats>> {
  if (guestIds.length === 0) return new Map();
  const rows = await db
    .select({ guestId: schema.reservations.guestId, status: schema.reservations.status, checkIn: schema.reservations.checkIn, checkOut: schema.reservations.checkOut, total: schema.reservations.totalAmount })
    .from(schema.reservations)
    .where(
      and(
        inArray(schema.reservations.guestId, guestIds),
        inArray(schema.reservations.status, ["confirmed", "in_house", "checked_out"]),
        propertyIds ? inArray(schema.reservations.propertyId, [...propertyIds]) : undefined,
      ),
    );
  const out = new Map<string, GuestStats>();
  for (const id of guestIds) out.set(id, { stays: 0, nights: 0, spend: 0, upcoming: 0, lastStay: null });
  for (const r of rows) {
    const s = out.get(r.guestId)!;
    if (r.status === "checked_out") {
      s.stays++;
      s.nights += diffDays(r.checkIn, r.checkOut);
      if (!s.lastStay || r.checkOut > s.lastStay) s.lastStay = r.checkOut;
    }
    if (r.status === "checked_out" || r.status === "in_house") s.spend += r.total;
    if (r.status === "confirmed") s.upcoming++;
  }
  return out;
}

export type GuestsError = "not_found" | "invalid" | "duplicate" | "same_guest" | "anonymized" | "active_booking";
export type GuestsResult = { ok: true } | { ok: false; error: GuestsError; otherId?: string };

async function audit(db: Executor, actor: Actor, guestId: string, action: string, after: Record<string, unknown>) {
  // Never personal data in the log: only what kind of change it was.
  await db.insert(schema.auditEvents).values({ actorType: actor.type, actorId: actor.id, entityType: "guest", entityId: guestId, action, after, occurredAt: new Date() });
}

/** Contact details, notes and tags of a profile. An email or phone that belongs to another profile asks for a merge instead. */
export async function updateGuest(
  db: AnyDb,
  input: { guestId: string; fullName: string; email: string | null; phone: string | null; countryCode: string | null; notes: string | null; tags: string[]; actor: Actor },
): Promise<GuestsResult> {
  const [g] = await db.select().from(schema.guests).where(eq(schema.guests.id, input.guestId));
  if (!g) return { ok: false, error: "not_found" };
  if (g.anonymizedAt) return { ok: false, error: "anonymized" };
  const fullName = input.fullName.trim().replace(/\s+/g, " ");
  const email = input.email?.trim().toLowerCase() || null;
  const phone = input.phone?.trim().slice(0, 40) || null;
  const country = input.countryCode?.trim().toUpperCase() || null;
  if (fullName.length < 2 || fullName.length > 120 || (email && !validEmail(email)) || (!email && !phone) || (country && !/^[A-Z]{2}$/.test(country))) return { ok: false, error: "invalid" };
  if (input.tags.some((t) => !(GUEST_TAGS as readonly string[]).includes(t))) return { ok: false, error: "invalid" };
  const phoneNormalized = normalizePhone(phone);
  const [other] = await db
    .select({ id: schema.guests.id })
    .from(schema.guests)
    .where(
      and(
        ne(schema.guests.id, g.id),
        isNull(schema.guests.anonymizedAt),
        or(email ? sql`lower(${schema.guests.email}) = ${email}` : sql`false`, phoneNormalized ? eq(schema.guests.phoneNormalized, phoneNormalized) : sql`false`),
      ),
    )
    .limit(1);
  if (other) return { ok: false, error: "duplicate", otherId: other.id };
  await db
    .update(schema.guests)
    .set({ fullName, email, phone, phoneNormalized, countryCode: country, notes: input.notes?.trim().slice(0, 2000) || null, tags: [...new Set(input.tags)], updatedAt: new Date() })
    .where(eq(schema.guests.id, g.id));
  await audit(db, input.actor, g.id, "guest.updated", { tags: [...new Set(input.tags)], notes: Boolean(input.notes?.trim()) });
  return { ok: true };
}

/** Moves every booking of `removeId` to `keepId`, combines contacts, notes and tags, then deletes the duplicate. */
export async function mergeGuests(db: AnyDb, input: { keepId: string; removeId: string; actor: Actor }): Promise<GuestsResult> {
  if (input.keepId === input.removeId) return { ok: false, error: "same_guest" };
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.guests).where(inArray(schema.guests.id, [input.keepId, input.removeId])).for("update");
    const keep = rows.find((r) => r.id === input.keepId);
    const remove = rows.find((r) => r.id === input.removeId);
    if (!keep || !remove) return { ok: false, error: "not_found" } as const;
    if (keep.anonymizedAt || remove.anonymizedAt) return { ok: false, error: "anonymized" } as const;
    const moved = await tx.update(schema.reservations).set({ guestId: keep.id, updatedAt: new Date() }).where(eq(schema.reservations.guestId, remove.id)).returning({ id: schema.reservations.id });
    await tx
      .update(schema.guests)
      .set({
        email: keep.email ?? remove.email,
        phone: keep.phone ?? remove.phone,
        phoneNormalized: keep.phone ? keep.phoneNormalized : remove.phoneNormalized,
        countryCode: keep.countryCode ?? remove.countryCode,
        notes: [keep.notes, remove.notes].filter(Boolean).join("\n").slice(0, 2000) || null,
        tags: [...new Set([...keep.tags, ...remove.tags])],
        updatedAt: new Date(),
      })
      .where(eq(schema.guests.id, keep.id));
    await tx.delete(schema.guests).where(eq(schema.guests.id, remove.id));
    await audit(tx, input.actor, keep.id, "guest.merged", { removedGuestId: remove.id, bookingsMoved: moved.length });
    return { ok: true } as const;
  });
}

/** Other profiles that may be the same person: same email, phone or name. */
export async function possibleDuplicates(db: Executor, guest: typeof schema.guests.$inferSelect) {
  if (guest.anonymizedAt) return [];
  return db
    .select({ id: schema.guests.id, fullName: schema.guests.fullName, email: schema.guests.email, phone: schema.guests.phone })
    .from(schema.guests)
    .where(
      and(
        ne(schema.guests.id, guest.id),
        isNull(schema.guests.anonymizedAt),
        or(
          sql`lower(${schema.guests.fullName}) = ${guest.fullName.toLowerCase()}`,
          guest.email ? sql`lower(${schema.guests.email}) = ${guest.email.toLowerCase()}` : sql`false`,
          guest.phoneNormalized ? eq(schema.guests.phoneNormalized, guest.phoneNormalized) : sql`false`,
        ),
      ),
    )
    .limit(5);
}

/** Everything held about a guest, for a data request under UU PDP. Document numbers stay masked. */
export async function exportGuestData(db: AnyDb, input: { guestId: string; actor: Actor }) {
  const [g] = await db.select().from(schema.guests).where(eq(schema.guests.id, input.guestId));
  if (!g) return null;
  const reservations = await db
    .select({ r: schema.reservations, propertyName: schema.properties.name })
    .from(schema.reservations)
    .innerJoin(schema.properties, eq(schema.properties.id, schema.reservations.propertyId))
    .where(eq(schema.reservations.guestId, g.id))
    .orderBy(asc(schema.reservations.checkIn));
  const ids = reservations.map((x) => x.r.id);
  const pre = ids.length ? await db.select().from(schema.preCheckins).where(inArray(schema.preCheckins.reservationId, ids)) : [];
  const preGuests = pre.length ? await db.select().from(schema.preCheckinGuests).where(inArray(schema.preCheckinGuests.preCheckinId, pre.map((p) => p.id))) : [];
  const messages = ids.length
    ? await db
        .select({ reservationId: schema.notificationOutbox.reservationId, kind: schema.notificationOutbox.kind, channel: schema.notificationOutbox.channel, recipient: schema.notificationOutbox.recipient, status: schema.notificationOutbox.status, createdAt: schema.notificationOutbox.createdAt })
        .from(schema.notificationOutbox)
        .where(inArray(schema.notificationOutbox.reservationId, ids))
    : [];
  await audit(db, input.actor, g.id, "guest.exported", { bookings: ids.length });
  return {
    exportedAt: new Date().toISOString(),
    profile: { fullName: g.fullName, email: g.email, phone: g.phone, countryCode: g.countryCode, notes: g.notes, tags: g.tags, createdAt: g.createdAt },
    bookings: reservations.map(({ r, propertyName }) => {
      const p = pre.find((x) => x.reservationId === r.id);
      return {
        code: r.code,
        property: propertyName,
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        adults: r.adults,
        children: r.children,
        totalAmount: r.totalAmount,
        amountPaid: r.amountPaid,
        currency: r.currency,
        estimatedArrival: r.estimatedArrival,
        specialRequests: r.specialRequests,
        createdAt: r.createdAt,
        preCheckin: p
          ? {
              flightNumber: p.flightNumber,
              landingDate: p.landingDate,
              landingTime: p.landingTime,
              transferRequested: p.transferRequested,
              transferNote: p.transferNote,
              requests: p.requests,
              guests: preGuests
                .filter((x) => x.preCheckinId === p.id)
                .map((x) => ({ fullName: x.fullName, nationality: x.nationality, birthDate: x.birthDate, documentType: x.documentType, documentLast4: x.documentLast4, documentErased: x.documentErasedAt !== null })),
            }
          : null,
        messages: messages.filter((m) => m.reservationId === r.id).map((m) => ({ kind: m.kind, channel: m.channel, recipient: m.recipient, status: m.status, createdAt: m.createdAt })),
      };
    }),
  };
}

/**
 * Erases a guest's personal data (UU PDP request): name, contacts, notes,
 * requests, pre-check-in details and messages. Bookings, amounts and
 * invoices stay for the accounts. Refused while a booking is still active.
 */
export async function anonymizeGuest(db: AnyDb, input: { guestId: string; actor: Actor; now?: Date }): Promise<GuestsResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [g] = await tx.select().from(schema.guests).where(eq(schema.guests.id, input.guestId)).for("update");
    if (!g) return { ok: false, error: "not_found" } as const;
    if (g.anonymizedAt) return { ok: false, error: "anonymized" } as const;
    const bookings = await tx.select({ id: schema.reservations.id, status: schema.reservations.status }).from(schema.reservations).where(eq(schema.reservations.guestId, g.id));
    if (bookings.some((b) => b.status === "hold" || b.status === "confirmed" || b.status === "in_house")) return { ok: false, error: "active_booking" } as const;
    const ids = bookings.map((b) => b.id);
    if (ids.length) {
      const pre = await tx.select({ id: schema.preCheckins.id }).from(schema.preCheckins).where(inArray(schema.preCheckins.reservationId, ids));
      if (pre.length) {
        await tx.delete(schema.preCheckinGuests).where(inArray(schema.preCheckinGuests.preCheckinId, pre.map((p) => p.id)));
        await tx.delete(schema.preCheckins).where(inArray(schema.preCheckins.id, pre.map((p) => p.id)));
      }
      await tx.delete(schema.notificationOutbox).where(inArray(schema.notificationOutbox.reservationId, ids));
      await tx.update(schema.reservations).set({ specialRequests: null, updatedAt: now }).where(inArray(schema.reservations.id, ids));
      await tx.update(schema.tasks).set({ notes: null, updatedAt: now }).where(and(inArray(schema.tasks.reservationId, ids), eq(schema.tasks.kind, "request")));
    }
    await tx
      .update(schema.guests)
      .set({ fullName: "—", email: null, phone: null, phoneNormalized: null, countryCode: null, notes: null, tags: [], anonymizedAt: now, updatedAt: now })
      .where(eq(schema.guests.id, g.id));
    await audit(tx, input.actor, g.id, "guest.anonymized", { bookings: ids.length });
    return { ok: true } as const;
  });
}

export type ForeignArrival = {
  reservationId: string;
  code: string;
  checkIn: string;
  checkOut: string;
  unitCode: string;
  status: string;
  reportedAt: Date | null;
  /** No pre-check-in yet: the guest's details must be taken at the desk. */
  missing: boolean;
  guests: Array<{ position: number; fullName: string; nationality: string; birthDate: string; documentType: string | null; documentLast4: string | null; hasDocument: boolean; documentNumberEnc: string | null }>;
};

/**
 * Foreign guests arriving in [from, to] at a property, for the immigration
 * report (APOA): every non-Indonesian adult from the pre-check-in, and
 * bookings of foreign guests who have not done it yet.
 */
export async function foreignArrivals(db: Executor, input: { propertyId: string; from: string; to: string }): Promise<ForeignArrival[]> {
  const rows = await db
    .select({ r: schema.reservations, unitCode: schema.units.code, guestCountry: schema.guests.countryCode })
    .from(schema.reservations)
    .innerJoin(schema.units, eq(schema.units.id, schema.reservations.unitId))
    .innerJoin(schema.guests, eq(schema.guests.id, schema.reservations.guestId))
    .where(
      and(
        eq(schema.reservations.propertyId, input.propertyId),
        inArray(schema.reservations.status, ["confirmed", "in_house", "checked_out"]),
        gte(schema.reservations.checkIn, input.from),
        lte(schema.reservations.checkIn, input.to),
      ),
    )
    .orderBy(asc(schema.reservations.checkIn), asc(schema.units.code));
  if (!rows.length) return [];
  const pre = await db.select().from(schema.preCheckins).where(inArray(schema.preCheckins.reservationId, rows.map((x) => x.r.id)));
  const preGuests = pre.length
    ? await db.select().from(schema.preCheckinGuests).where(and(inArray(schema.preCheckinGuests.preCheckinId, pre.map((p) => p.id)), ne(schema.preCheckinGuests.nationality, "ID"))).orderBy(asc(schema.preCheckinGuests.position))
    : [];
  const out: ForeignArrival[] = [];
  for (const { r, unitCode, guestCountry } of rows) {
    const p = pre.find((x) => x.reservationId === r.id);
    const foreign = p ? preGuests.filter((g) => g.preCheckinId === p.id) : [];
    if (p && !foreign.length) continue;
    if (!p && (!guestCountry || guestCountry === "ID")) continue;
    out.push({
      reservationId: r.id,
      code: r.code,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      unitCode,
      status: r.status,
      reportedAt: r.apoaReportedAt,
      missing: !p,
      guests: foreign.map((g) => ({ position: g.position, fullName: g.fullName, nationality: g.nationality, birthDate: g.birthDate, documentType: g.documentType, documentLast4: g.documentLast4, hasDocument: g.documentNumberEnc !== null, documentNumberEnc: g.documentNumberEnc })),
    });
  }
  return out;
}

/** Marks bookings as reported to immigration (or clears the mark). */
export async function markApoaReported(db: AnyDb, input: { reservationIds: string[]; reported: boolean; actor: Actor; now?: Date }): Promise<number> {
  if (!input.reservationIds.length) return 0;
  const now = input.now ?? new Date();
  const rows = await db
    .update(schema.reservations)
    .set(input.reported ? { apoaReportedAt: now, apoaReportedBy: input.actor.id, updatedAt: now } : { apoaReportedAt: null, apoaReportedBy: null, updatedAt: now })
    .where(and(inArray(schema.reservations.id, input.reservationIds), input.reported ? isNull(schema.reservations.apoaReportedAt) : isNotNull(schema.reservations.apoaReportedAt)))
    .returning({ id: schema.reservations.id, propertyId: schema.reservations.propertyId });
  if (rows.length) {
    await db.insert(schema.auditEvents).values(
      rows.map((r) => ({ actorType: input.actor.type, actorId: input.actor.id, propertyId: r.propertyId, entityType: "reservation", entityId: r.id, action: input.reported ? "apoa.reported" : "apoa.unreported", after: {}, occurredAt: now })),
    );
  }
  return rows.length;
}

/** Guests seen at these properties (all when null), most recent first, with a search over name, email and phone. */
export async function listGuests(db: Executor, input: { propertyIds: readonly string[] | null; q?: string; tag?: string | null; limit: number; offset: number }) {
  const q = input.q?.trim().toLowerCase() ?? "";
  const digits = q.replace(/\D/g, "");
  const scoped = input.propertyIds
    ? sql`EXISTS (SELECT 1 FROM ${schema.reservations} r WHERE r.guest_id = ${schema.guests.id} AND r.property_id IN ${input.propertyIds.length ? sql`(${sql.join(input.propertyIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`(NULL)`})`
    : undefined;
  const where = and(
    scoped,
    q
      ? or(
          sql`lower(${schema.guests.fullName}) LIKE ${`%${q}%`}`,
          sql`lower(${schema.guests.email}) LIKE ${`%${q}%`}`,
          digits.length >= 4 ? sql`${schema.guests.phoneNormalized} LIKE ${`%${digits.startsWith("0") ? `62${digits.slice(1)}` : digits}%`}` : undefined,
        )
      : undefined,
    input.tag ? sql`${input.tag} = ANY(${schema.guests.tags})` : undefined,
  );
  const lastBooking = sql<string | null>`(SELECT max(r.check_in) FROM ${schema.reservations} r WHERE r.guest_id = ${schema.guests.id})`;
  const rows = await db
    .select({ guest: schema.guests, lastBooking })
    .from(schema.guests)
    .where(where)
    .orderBy(desc(lastBooking), desc(schema.guests.createdAt))
    .limit(input.limit)
    .offset(input.offset);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.guests).where(where);
  return { rows, total: Number(total) };
}
