import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
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
  ...timestamps,
});

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
    ...timestamps,
  },
  (t) => [
    unique("unit_types_property_slug_key").on(t.propertyId, t.slug),
    unique("unit_types_id_property_key").on(t.id, t.propertyId),
    check("unit_types_bedrooms_positive", sql`${t.bedrooms} > 0`),
    check("unit_types_max_guests_positive", sql`${t.maxGuests} > 0`),
    check("unit_types_base_rate_non_negative", sql`${t.baseRate} >= 0`),
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
