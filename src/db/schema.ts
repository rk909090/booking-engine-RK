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
  uniqueIndex,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  type AnyPgColumn,
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
  type DiscountTerms,
  type Guarantee,
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
  /** Time needed to clean and inspect a villa between guests; limits late check-outs. Sample default: 2 hours. */
  turnoverMinutes: smallint("turnover_minutes").notNull().default(120),
  /** Largest discount on the nights' price each role may give, in basis points (1000 = 10%). */
  discountLimitFrontOfficeBp: integer("discount_limit_front_office_bp").notNull().default(1000),
  discountLimitManagerBp: integer("discount_limit_manager_bp").notNull().default(5000),
  cancellationTiers: jsonb("cancellation_tiers").$type<CancellationTier[]>().notNull().default(SAMPLE_CANCELLATION_TIERS),
  content: jsonb("content").$type<PropertyContent>().notNull().default({}),
  ...timestamps,
}, (t) => [
  check("properties_tax_rate_range", sql`${t.taxRateBp} BETWEEN 0 AND 10000`),
  check("properties_turnover_minutes_range", sql`${t.turnoverMinutes} BETWEEN 0 AND 720`),
  check("properties_discount_limits_range", sql`${t.discountLimitFrontOfficeBp} BETWEEN 0 AND 10000 AND ${t.discountLimitManagerBp} BETWEEN 0 AND 10000`),
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
    /** Secret part of this villa's iCal export URL (domain/ical.ts); null until first used. */
    icalExportToken: text("ical_export_token").unique(),
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
    /** Charges on top of the nights (for example a late check-out fee), included in total_amount. */
    extrasAmount: bigint("extras_amount", { mode: "number" }).notNull().default(0),
    /** Discount on the nights' price (before service and tax); total_amount is after it. */
    discountAmount: bigint("discount_amount", { mode: "number" }).notNull().default(0),
    /** How the discount was given, so it can be re-applied when the dates change. */
    discount: jsonb("discount").$type<DiscountTerms>(),
    /** Set when staff confirmed the booking without the deposit (see domain/guarantee.ts). */
    guarantee: jsonb("guarantee").$type<Guarantee>(),
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
    check("reservations_discount_non_negative", sql`${t.discountAmount} >= 0`),
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
    /** Set when another party (split bill) pays its own charges; such payments don't count toward the guest's bill. */
    folioPartyId: uuid("folio_party_id").references((): AnyPgColumn => folioParties.id),
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
    /** Not before this time (retry backoff). */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** When a worker took it for sending (a stale claim is retried). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Id returned by the provider (Resend email id, WhatsApp message id). */
    providerRef: text("provider_ref"),
    /** Makes reminders idempotent, e.g. "precheckin_reminder:<reservation>:email". */
    dedupeKey: text("dedupe_key").unique(),
    ...timestamps,
  },
  (t) => [
    check("notification_outbox_channel", sql`${t.channel} IN ('email', 'whatsapp')`),
    check("notification_outbox_status", sql`${t.status} IN ('pending', 'sending', 'sent', 'failed', 'skipped')`),
    index("notification_outbox_pending_idx").on(t.status, t.createdAt),
    index("notification_outbox_reservation_idx").on(t.reservationId),
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

export const lateCheckoutStatus = pgEnum("late_checkout_status", ["requested", "approved", "declined", "cancelled"]);

/**
 * A guest asking to leave later than the property's check-out time on their
 * departure date. Approval is refused while it would leave too little time to
 * prepare the villa for the next arrival.
 */
export const lateCheckoutRequests = pgTable(
  "late_checkout_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    /** The departure date the request is for. */
    forDate: date("for_date", { mode: "string" }).notNull(),
    requestedTime: time("requested_time").notNull(),
    status: lateCheckoutStatus("status").notNull().default("requested"),
    fee: bigint("fee", { mode: "number" }).notNull().default(0),
    note: text("note"),
    decisionNote: text("decision_note"),
    requestedBy: text("requested_by"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("late_checkout_fee_non_negative", sql`${t.fee} >= 0`),
    // At most one open (requested or approved) request per booking.
    uniqueIndex("late_checkout_one_active_idx")
      .on(t.reservationId)
      .where(sql`${t.status} IN ('requested', 'approved')`),
  ],
);

export const earlyCheckinStatus = pgEnum("early_checkin_status", ["requested", "approved", "declined", "cancelled"]);

/**
 * A guest asking to arrive before the property's check-in time on their
 * arrival date. Approval is refused while the guest leaving the same villa
 * that day (at the check-out time, or their approved late check-out) would
 * leave too little time to prepare the villa.
 */
export const earlyCheckinRequests = pgTable(
  "early_checkin_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    /** The arrival date the request is for. */
    forDate: date("for_date", { mode: "string" }).notNull(),
    requestedTime: time("requested_time").notNull(),
    status: earlyCheckinStatus("status").notNull().default("requested"),
    fee: bigint("fee", { mode: "number" }).notNull().default(0),
    note: text("note"),
    decisionNote: text("decision_note"),
    requestedBy: text("requested_by"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("early_checkin_fee_non_negative", sql`${t.fee} >= 0`),
    // At most one open (requested or approved) request per booking.
    uniqueIndex("early_checkin_one_active_idx")
      .on(t.reservationId)
      .where(sql`${t.status} IN ('requested', 'approved')`),
  ],
);

/**
 * Online pre-check-in filled in by the guest from their booking page before
 * arrival (domain/pre-checkin.ts). One per booking; the guest can update it
 * until the arrival day.
 */
export const preCheckins = pgTable("pre_checkins", {
  id: uuid("id").primaryKey().defaultRandom(),
  reservationId: uuid("reservation_id")
    .notNull()
    .unique()
    .references(() => reservations.id, { onDelete: "cascade" }),
  flightNumber: text("flight_number"),
  landingDate: date("landing_date", { mode: "string" }),
  landingTime: time("landing_time"),
  transferRequested: boolean("transfer_requested").notNull().default(false),
  transferNote: text("transfer_note"),
  requests: text("requests"),
  houseRulesAcceptedAt: timestamp("house_rules_accepted_at", { withTimezone: true }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

/**
 * The adult guests named in a pre-check-in. Identity document numbers are
 * encrypted (lib/crypto/guest-data.ts) and erased 30 days after check-out;
 * the last four characters are kept beside them for display until then.
 */
export const preCheckinGuests = pgTable(
  "pre_checkin_guests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preCheckinId: uuid("pre_checkin_id")
      .notNull()
      .references(() => preCheckins.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    fullName: text("full_name").notNull(),
    nationality: char("nationality", { length: 2 }).notNull(),
    birthDate: date("birth_date", { mode: "string" }).notNull(),
    documentType: text("document_type"),
    documentNumberEnc: text("document_number_enc"),
    documentLast4: text("document_last4"),
    documentErasedAt: timestamp("document_erased_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    check("pre_checkin_guests_document_type", sql`${t.documentType} IS NULL OR ${t.documentType} IN ('passport', 'id_card')`),
    uniqueIndex("pre_checkin_guests_position_idx").on(t.preCheckinId, t.position),
  ],
);

/**
 * Calendars of other channels (Airbnb, Booking.com, VRBO…) imported per villa
 * by iCal (domain/ical.ts). The URL is secret: whoever has it can read the
 * channel's calendar, so it is shown masked after saving.
 */
export const icalFeeds = pgTable(
  "ical_feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    eventCount: integer("event_count").notNull().default(0),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (t) => [
    check("ical_feeds_status", sql`${t.lastStatus} IS NULL OR ${t.lastStatus} IN ('ok', 'error')`),
    uniqueIndex("ical_feeds_unit_url_idx").on(t.unitId, t.url),
  ],
);

/** Busy periods read from an imported calendar; the villa is not bookable on these nights. */
export const icalEvents = pgTable(
  "ical_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedId: uuid("feed_id")
      .notNull()
      .references(() => icalFeeds.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }).notNull(),
    summary: text("summary"),
    ...timestamps,
  },
  (t) => [
    check("ical_events_dates_ordered", sql`${t.endDate} > ${t.startDate}`),
    uniqueIndex("ical_events_feed_uid_idx").on(t.feedId, t.uid),
    index("ical_events_unit_idx").on(t.unitId, t.startDate),
  ],
);

/**
 * Someone other than the guest who pays part of the bill (split bill): a
 * company, an agent, a second guest. Charges billed to them are kept off the
 * guest's bill and invoiced separately (domain/folio.ts).
 */
export const folioParties = pgTable(
  "folio_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Address, tax number or other details printed on their invoice. */
    details: text("details"),
    email: text("email"),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (t) => [index("folio_parties_reservation_idx").on(t.reservationId)],
);

export const folioCategories = ["food_beverage", "minibar", "spa", "transfer", "laundry", "tour", "other"] as const;

/** Extra charges on a booking (prices include tax and service). Voided charges stay for the record. */
export const folioCharges = pgTable(
  "folio_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    /** Null: the guest pays; otherwise the party billed (split bill). */
    partyId: uuid("party_id").references(() => folioParties.id),
    category: text("category").notNull(),
    description: text("description").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    chargeDate: date("charge_date", { mode: "string" }).notNull(),
    status: text("status").notNull().default("active"),
    voidReason: text("void_reason"),
    voidedBy: text("voided_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (t) => [
    check("folio_charges_category", sql`${t.category} IN ('food_beverage', 'minibar', 'spa', 'transfer', 'laundry', 'tour', 'other')`),
    check("folio_charges_status", sql`${t.status} IN ('active', 'void')`),
    check("folio_charges_quantity_positive", sql`${t.quantity} > 0`),
    check("folio_charges_amount", sql`${t.unitPrice} >= 0 AND ${t.amount} = ${t.quantity} * ${t.unitPrice}`),
    index("folio_charges_reservation_idx").on(t.reservationId),
  ],
);

/** Next invoice number per property and year (INV-<property>-<year>-00001), handed out atomically. */
export const invoiceCounters = pgTable(
  "invoice_counters",
  {
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    last: integer("last").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.year] })],
);

/**
 * An issued invoice: one for the guest and one per other party. The number
 * never changes; the content always shows the bill as it stands.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    partyId: uuid("party_id").references(() => folioParties.id),
    number: text("number").notNull().unique(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    issuedBy: text("issued_by"),
    ...timestamps,
  },
  (t) => [
    // One invoice for the guest (party null) and one per party.
    uniqueIndex("invoices_guest_idx").on(t.reservationId).where(sql`${t.partyId} IS NULL`),
    uniqueIndex("invoices_party_idx").on(t.partyId).where(sql`${t.partyId} IS NOT NULL`),
  ],
);
