CREATE TYPE "public"."early_checkin_status" AS ENUM('requested', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "early_checkin_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"for_date" date NOT NULL,
	"requested_time" time NOT NULL,
	"status" "early_checkin_status" DEFAULT 'requested' NOT NULL,
	"fee" bigint DEFAULT 0 NOT NULL,
	"note" text,
	"decision_note" text,
	"requested_by" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_checkin_fee_non_negative" CHECK ("early_checkin_requests"."fee" >= 0)
);
--> statement-breakpoint
ALTER TABLE "early_checkin_requests" ADD CONSTRAINT "early_checkin_requests_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "early_checkin_one_active_idx" ON "early_checkin_requests" USING btree ("reservation_id") WHERE "early_checkin_requests"."status" IN ('requested', 'approved');