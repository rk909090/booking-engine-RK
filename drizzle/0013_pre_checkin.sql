CREATE TABLE "pre_checkin_guests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pre_checkin_id" uuid NOT NULL,
	"position" smallint NOT NULL,
	"full_name" text NOT NULL,
	"nationality" char(2) NOT NULL,
	"birth_date" date NOT NULL,
	"document_type" text,
	"document_number_enc" text,
	"document_last4" text,
	"document_erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pre_checkin_guests_document_type" CHECK ("pre_checkin_guests"."document_type" IS NULL OR "pre_checkin_guests"."document_type" IN ('passport', 'id_card'))
);
--> statement-breakpoint
CREATE TABLE "pre_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"flight_number" text,
	"landing_date" date,
	"landing_time" time,
	"transfer_requested" boolean DEFAULT false NOT NULL,
	"transfer_note" text,
	"requests" text,
	"house_rules_accepted_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pre_checkins_reservation_id_unique" UNIQUE("reservation_id")
);
--> statement-breakpoint
ALTER TABLE "pre_checkin_guests" ADD CONSTRAINT "pre_checkin_guests_pre_checkin_id_pre_checkins_id_fk" FOREIGN KEY ("pre_checkin_id") REFERENCES "public"."pre_checkins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_checkins" ADD CONSTRAINT "pre_checkins_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pre_checkin_guests_position_idx" ON "pre_checkin_guests" USING btree ("pre_checkin_id","position");--> statement-breakpoint
-- Personal data: no access through the public Data API (the app connects as the database owner).
ALTER TABLE "pre_checkins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pre_checkin_guests" ENABLE ROW LEVEL SECURITY;
