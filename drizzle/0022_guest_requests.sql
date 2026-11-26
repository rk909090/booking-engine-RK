CREATE TABLE "date_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"quoted_total" bigint,
	"previous_total" bigint NOT NULL,
	"note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "date_change_requests_dates" CHECK ("date_change_requests"."check_out" > "date_change_requests"."check_in"),
	CONSTRAINT "date_change_requests_status" CHECK ("date_change_requests"."status" IN ('requested', 'approved', 'declined', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "guest_late_checkout_latest" time DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "guest_early_checkin_earliest" time DEFAULT '10:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "date_change_requests" ADD CONSTRAINT "date_change_requests_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "date_change_requests_one_open_idx" ON "date_change_requests" USING btree ("reservation_id") WHERE "date_change_requests"."status" = 'requested';--> statement-breakpoint
ALTER TABLE "date_change_requests" ENABLE ROW LEVEL SECURITY;
