CREATE TYPE "public"."late_checkout_status" AS ENUM('requested', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "late_checkout_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"for_date" date NOT NULL,
	"requested_time" time NOT NULL,
	"status" "late_checkout_status" DEFAULT 'requested' NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"decision_note" text,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "late_checkout_fee_non_negative" CHECK ("late_checkout_requests"."fee" >= 0)
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "turnover_minutes" smallint DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "extras_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "late_checkout_requests" ADD CONSTRAINT "late_checkout_requests_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "late_checkout_one_active_idx" ON "late_checkout_requests" USING btree ("reservation_id") WHERE "late_checkout_requests"."status" IN ('requested', 'approved');--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_turnover_minutes_range" CHECK ("properties"."turnover_minutes" BETWEEN 0 AND 720);