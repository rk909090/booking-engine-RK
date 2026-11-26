CREATE TABLE "ical_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ical_events_dates_ordered" CHECK ("ical_events"."end_date" > "ical_events"."start_date")
);
--> statement-breakpoint
CREATE TABLE "ical_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"event_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ical_feeds_status" CHECK ("ical_feeds"."last_status" IS NULL OR "ical_feeds"."last_status" IN ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "units" ADD COLUMN "ical_export_token" text;--> statement-breakpoint
ALTER TABLE "ical_events" ADD CONSTRAINT "ical_events_feed_id_ical_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."ical_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ical_events" ADD CONSTRAINT "ical_events_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ical_feeds" ADD CONSTRAINT "ical_feeds_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ical_events_feed_uid_idx" ON "ical_events" USING btree ("feed_id","uid");--> statement-breakpoint
CREATE INDEX "ical_events_unit_idx" ON "ical_events" USING btree ("unit_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ical_feeds_unit_url_idx" ON "ical_feeds" USING btree ("unit_id","url");--> statement-breakpoint
ALTER TABLE "units" ADD CONSTRAINT "units_ical_export_token_unique" UNIQUE("ical_export_token");--> statement-breakpoint
ALTER TABLE "ical_feeds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ical_events" ENABLE ROW LEVEL SECURITY;
