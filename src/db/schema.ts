import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  integer,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth-schema";
import {
  SAMPLE_CANCELLATION_TIERS,
  type CancellationTier,
  type PolicySnapshot,
  type PriceSnapshot,
  type PropertyContent,
  type UnitTypeContent,
} from "@/domain/types";

export * from "./auth-schema";

/*
 * Core domain schema (Fase 0). Money is stored as whole rupiah in bigint:
 * IDR has no minor unit in practice, and integers avoid float rounding.
 *
 * The rule "no two active reservations on the same unit for the same night"
 * is enforced by an EXCLUDE constraint added in a custom migration
 * (drizzle/*_reservation_overlap_guard.sql), because Drizzle cannot express it.
 */

export const staffRole = pgEnum("staff_role", [
  "director",
  "branch_manager",
  "front_office",
  "housekeeping",
]);

export const reservationStatus = pgEnum("reservation_status", [
  "hold",
  "confirmed",
  "in_house",
  "checked_out",
  "cancelled",
  "no_show",
  "expired",
]);

/** Statuses that occupy a unit. Keep in sync with the overlap guard migration. */
export const OCCUPYING_STATUSES = ["hold", "confirmed", "in_house", "checked_out"] as const;

export const bookingSource = pgEnum("booking_source", [
  "website",
  "direct",
  "walk_in",
  "ota",
  "agent",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Makassar"),
  checkInTime: time("check_in_time").notNull().default("14:00"),
  checkOutTime: time("check_out_time").notNull().default("11:00"),
  currency: char("currency", { length: 3 }).notNull().default("IDR"),
  isActive: boolean("is_active").notNull().default(true),
  /** Hotel tax and service charge in basis points (1000 = 10%). 0 until the real rates are confirmed. */
  taxRateBp: integer("tax_rate_bp").notNull().default(0),
  serviceRateBp: integer("service_rate_bp").notNull().default(0),
  /** Share of the total paid at booking. 10000 = pay in full. Sample default: 30%. */
  depositRateBp: integer("deposit_rate_bp").notNull().default(3000),
  /** The balance is due this many days before check-in; bookings closer than that pay in full. */
  balanceDueDays: smallint("balance_due_days").notNull().default(14),
  /** How long a unit is held while the guest pays. */
  holdMinutes: smallint("hold_minutes").notNull().default(15),
  cancellationTiers: jsonb("cancellation_tiers").$type<CancellationTier[]>().notNull().default(SAMPLE_CANCELLATION_TIERS),
  content: jsonb("content").$type<PropertyContent>().notNull().default({}),
  ...timestamps,
}, (t) => [
  check("properties_tax_rate_range", sql`${t.taxRateBp} BETWEEN 0 AND 10000`),
  check("properties_service_rate_range", sql`${t.serviceRateBp} BETWEEN 0 AND 10000`),
  check("properties_deposit_rate_range", sql`${t.depositRateBp} BETWEEN 0 AND 10000`),
  check("properties_balance_due_days_non_negative", sql`${t.balanceDueDays} >= 0`),
  check("properties_hold_minutes_range", sql`${t.holdMinutes} BETWEEN 5 AND 120`),
]);

export const unitTypes = pgTable(
  "unit_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    bedrooms: smallint("bedrooms").notNull(),
    maxGuests: smallint("max_guests").notNull(),
    baseRate: bigint("base_rate", { mode: "number" }).notNull(),
    minStayNights: smallint("min_stay_nights").notNull().default(1),
    maxStayNights: smallint("max_stay_nights").notNull().default(30),
    content: jsonb("content").$type<UnitTypeContent>().notNull().default({}),
    /** Amenity codes; labels live in the dictionaries. */
    amenities: text("amenities").array().notNull().default(sql`'{}'::text[]`),
    sortOrder: smallint("sort_order").notNull().default(0),
    isPublished: boolean("is_published").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique("unit_types_property_slug_key").on(t.propertyId, t.slug),
    unique("unit_types_id_property_key").on(t.id, t.propertyId),
    check("unit_types_bedrooms_positive", sql`${t.bedrooms} > 0`),
    check("unit_types_max_guests_positive", sql`${t.maxGuests} > 0`),
    check("unit_types_base_rate_non_negative", sql`${t.baseRate} >= 0`),
    check("unit_types_stay_range", sql`${t.minStayNights} >= 1 AND ${t.maxStayNights} >= ${t.minStayNights}`),
  ],
);

export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    propertyId: uuid("property_id").notNull(),
    unitTypeId: uuid("unit_type_id").notNull(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    // A unit's type must belong to the same property.
    foreignKey({
      name: "units_unit_type_same_property_fk",
      columns: [t.unitTypeId, t.propertyId],
      foreignColumns: [unitTypes.id, unitTypes.propertyId],
    }),
    // Lets reservations reference (unit, type, property) as one consistent triple.
    unique("units_id_type_property_key").on(t.id, t.unitTypeId, t.propertyId),
  ],
);

export const guests = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    countryCode: char("country_code", { length: 2 }),
    ...timestamps,
  },
  (t) => [
    index("guests_email_lower_idx").on(sql`lower(${t.email})`),
    check("guests_has_contact", sql`${t.email} IS NOT NULL OR ${t.phone} IS NOT NULL`),
  ],
);

export const staffMembers = pgTable("staff_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The Better Auth user this staff member signs in as. */
  authUserId: text("auth_user_id")
    .unique()
    .references(() => authUsers.id, { onDelete: "set null" }),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: staffRole("role").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
});

/** Which properties a non-director staff member may act on. Directors see all. */
export const staffPropertyAccess = pgTable(
  "staff_property_access",
  {
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staffMembers.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.propertyId] })],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    propertyId: uuid("property_id").notNull(),
    unitTypeId: uuid("unit_type_id").notNull(),
    unitId: uuid("unit_id").notNull(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id),
    status: reservationStatus("status").notNull(),
    source: bookingSource("source").notNull(),
    checkIn: date("check_in", { mode: "string" }).notNull(),
    checkOut: date("check_out", { mode: "string" }).notNull(),
    adults: smallint("adults").notNull(),
    children: smallint("children").notNull().default(0),
    totalAmount: bigint("total_amount", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("IDR"),
    holdExpiresAt: timestamp("hold_expires_at", { withTimezone: true }),
    estimatedArrival: time("estimated_arrival"),
    specialRequests: text("special_requests"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: text("cancellation_reason"),
    subtotalAmount: bigint("subtotal_amount", { mode: "number" }).notNull().default(0),
    serviceAmount: bigint("service_amount", { mode: "number" }).notNull().default(0),
    taxAmount: bigint("tax_amount", { mode: "number" }).notNull().default(0),
    /** Amount due at booking (deposit, or the full total when paying in full). */
    depositAmount: bigint("deposit_amount", { mode: "number" }).notNull().default(0),
    amountPaid: bigint("amount_paid", { mode: "number" }).notNull().default(0),
    balanceDueDate: date("balance_due_date", { mode: "string" }),
    /** Refund owed after cancellation; paying it out is tracked on payments. */
    refundAmount: bigint("refund_amount", { mode: "number" }),
    priceSnapshot: jsonb("price_snapshot").$type<PriceSnapshot>(),
    policySnapshot: jsonb("policy_snapshot").$type<PolicySnapshot>(),
    locale: text("locale").notNull().default("en"),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: "reservations_unit_consistent_fk",
      columns: [t.unitId, t.unitTypeId, t.propertyId],
      foreignColumns: [units.id, units.unitTypeId, units.propertyId],
    }),
    check("reservations_dates_ordered", sql`${t.checkOut} > ${t.checkIn}`),
    check("reservations_adults_positive", sql`${t.adults} >= 1`),
    check("reservations_children_non_negative", sql`${t.children} >= 0`),
    check("reservations_total_non_negative", sql`${t.totalAmount} >= 0`),
    check("reservations_amount_paid_non_negative", sql`${t.amountPaid} >= 0`),
    check(
      "reservations_hold_has_expiry",
      sql`${t.status} <> 'hold' OR ${t.holdExpiresAt} IS NOT NULL`,
    ),
    index("reservations_property_check_in_idx").on(t.propertyId, t.checkIn),
    index("reservations_guest_idx").on(t.guestId),
  ],
);

/** Append-only record of who did what. Never updated or deleted by the app. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    propertyId: uuid("property_id").references(() => properties.id),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId, t.occurredAt),
    check("audit_events_actor_type", sql`${t.actorType} IN ('staff', 'guest', 'system')`),
  ],
);

/**
 * Seasonal nightly rates per villa type. [start_date, end_date) like stays.
 * Seasons of one type may not overlap (EXCLUDE constraint in a custom migration).
 * Nights outside every season use unit_types.base_rate.
 */
export const rateSeasons = pgTable(
  "rate_seasons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitTypeId: uuid("unit_type_id")
      .notNull()
      .references(() => unitTypes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    nightlyRate: bigint("nightly_rate", { mode: "number" }).notNull(),
    /** Minimum stay for arrivals inside this season; null falls back to the villa type. */
    minStayNights: smallint("min_stay_nights"),
    ...timestamps,
  },
  (t) => [
    check("rate_seasons_dates_ordered", sql`${t.endDate} > ${t.startDate}`),
    check("rate_seasons_rate_non_negative", sql`${t.nightlyRate} >= 0`),
    check("rate_seasons_min_stay_positive", sql`${t.minStayNights} IS NULL OR ${t.minStayNights} >= 1`),
    index("rate_seasons_type_idx").on(t.unitTypeId, t.startDate),
  ],
);

/** manual: money moved outside the app (bank transfer, cash), recorded by staff. */
export const paymentProvider = pgEnum("payment_provider", ["simulated", "xendit", "manual"]);
export const paymentPurpose = pgEnum("payment_purpose", ["deposit", "balance", "full", "refund"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "paid", "expired", "failed", "cancelled"]);

/**
 * Money movements for a reservation. (provider, provider_ref) is unique, so a
 * webhook delivered twice cannot record the same payment twice.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id),
    provider: paymentProvider("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    purpose: paymentPurpose("purpose").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("IDR"),
    status: paymentStatus("status").notNull().default("pending"),
    checkoutUrl: text("checkout_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    raw: jsonb("raw"),
    ...timestamps,
  },
  (t) => [
    unique("payments_provider_ref_key").on(t.provider, t.providerRef),
    check("payments_amount_positive", sql`${t.amount} > 0`),
    index("payments_reservation_idx").on(t.reservationId),
  ],
);

/**
 * Messages to send (email, WhatsApp). Written in the same transaction as the
 * change that causes them, sent later by a worker, so nothing is lost or sent
 * for a change that rolled back.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    reservationId: uuid("reservation_id").references(() => reservations.id),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("notification_outbox_channel", sql`${t.channel} IN ('email', 'whatsapp')`),
    check("notification_outbox_status", sql`${t.status} IN ('pending', 'sent', 'failed', 'skipped')`),
    index("notification_outbox_pending_idx").on(t.status, t.createdAt),
  ],
);

export const housekeepingState = pgEnum("housekeeping_state", ["dirty", "inspect", "ready"]);

/**
 * Recorded cleaning state of each unit. A unit without a row is treated as
 * ready (newly added units). Occupancy and maintenance are not stored here:
 * they come from reservations and unit_blocks.
 */
export const unitStatus = pgTable("unit_status", {
  unitId: uuid("unit_id")
    .primaryKey()
    .references(() => units.id, { onDelete: "cascade" }),
  state: housekeepingState("state").notNull().default("ready"),
  note: text("note"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every change of a unit's cleaning state: who, when, from what to what. */
export const housekeepingEvents = pgTable(
  "housekeeping_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    fromState: housekeepingState("from_state"),
    toState: housekeepingState("to_state").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    note: text("note"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("housekeeping_events_unit_idx").on(t.unitId, t.occurredAt)],
);

export const blockStatus = pgEnum("block_status", ["open", "resolved"]);

/**
 * A unit taken out of sale for [start_date, end_date), e.g. repairs.
 * While open it hides the unit from availability and blocks new holds.
 */
export const unitBlocks = pgTable(
  "unit_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    reason: text("reason").notNull(),
    status: blockStatus("status").notNull().default("open"),
    createdBy: text("created_by"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("unit_blocks_dates_ordered", sql`${t.endDate} > ${t.startDate}`),
    index("unit_blocks_unit_idx").on(t.unitId, t.startDate),
  ],
);
