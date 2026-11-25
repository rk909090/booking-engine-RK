CREATE TYPE "public"."booking_source" AS ENUM('website', 'direct', 'walk_in', 'ota', 'agent');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('hold', 'confirmed', 'in_house', 'checked_out', 'cancelled', 'no_show', 'expired');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('director', 'branch_manager', 'front_office', 'housekeeping');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"property_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "audit_events_actor_type" CHECK ("audit_events"."actor_type" IN ('staff', 'guest', 'system'))
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"country_code" char(2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guests_has_contact" CHECK ("guests"."email" IS NOT NULL OR "guests"."phone" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Makassar' NOT NULL,
	"check_in_time" time DEFAULT '14:00' NOT NULL,
	"check_out_time" time DEFAULT '11:00' NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_type_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"status" "reservation_status" NOT NULL,
	"source" "booking_source" NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"adults" smallint NOT NULL,
	"children" smallint DEFAULT 0 NOT NULL,
	"total_amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"estimated_arrival" time,
	"special_requests" text,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_code_unique" UNIQUE("code"),
	CONSTRAINT "reservations_dates_ordered" CHECK ("reservations"."check_out" > "reservations"."check_in"),
	CONSTRAINT "reservations_adults_positive" CHECK ("reservations"."adults" >= 1),
	CONSTRAINT "reservations_children_non_negative" CHECK ("reservations"."children" >= 0),
	CONSTRAINT "reservations_total_non_negative" CHECK ("reservations"."total_amount" >= 0),
	CONSTRAINT "reservations_hold_has_expiry" CHECK ("reservations"."status" <> 'hold' OR "reservations"."hold_expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "staff_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_members_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "staff_members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "staff_property_access" (
	"staff_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	CONSTRAINT "staff_property_access_staff_id_property_id_pk" PRIMARY KEY("staff_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "unit_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"bedrooms" smallint NOT NULL,
	"max_guests" smallint NOT NULL,
	"base_rate" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_types_property_slug_key" UNIQUE("property_id","slug"),
	CONSTRAINT "unit_types_id_property_key" UNIQUE("id","property_id"),
	CONSTRAINT "unit_types_bedrooms_positive" CHECK ("unit_types"."bedrooms" > 0),
	CONSTRAINT "unit_types_max_guests_positive" CHECK ("unit_types"."max_guests" > 0),
	CONSTRAINT "unit_types_base_rate_non_negative" CHECK ("unit_types"."base_rate" >= 0)
);
--> statement-breakpoint
CREATE TABLE "units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_type_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_code_unique" UNIQUE("code"),
	CONSTRAINT "units_id_type_property_key" UNIQUE("id","unit_type_id","property_id")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_unit_consistent_fk" FOREIGN KEY ("unit_id","unit_type_id","property_id") REFERENCES "public"."units"("id","unit_type_id","property_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_property_access" ADD CONSTRAINT "staff_property_access_staff_id_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_property_access" ADD CONSTRAINT "staff_property_access_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_unit_type_same_property_fk" FOREIGN KEY ("unit_type_id","property_id") REFERENCES "public"."unit_types"("id","property_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "guests_email_lower_idx" ON "guests" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "reservations_property_check_in_idx" ON "reservations" USING btree ("property_id","check_in");--> statement-breakpoint
CREATE INDEX "reservations_guest_idx" ON "reservations" USING btree ("guest_id");