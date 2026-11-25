CREATE TYPE "public"."block_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."housekeeping_state" AS ENUM('dirty', 'inspect', 'ready');--> statement-breakpoint
CREATE TABLE "housekeeping_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"from_state" "housekeeping_state",
	"to_state" "housekeeping_state" NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"note" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"reason" text NOT NULL,
	"status" "block_status" DEFAULT 'open' NOT NULL,
	"created_by" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_blocks_dates_ordered" CHECK ("unit_blocks"."end_date" > "unit_blocks"."start_date")
);
--> statement-breakpoint
CREATE TABLE "unit_status" (
	"unit_id" uuid PRIMARY KEY NOT NULL,
	"state" "housekeeping_state" DEFAULT 'ready' NOT NULL,
	"note" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "housekeeping_events" ADD CONSTRAINT "housekeeping_events_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_blocks" ADD CONSTRAINT "unit_blocks_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_status" ADD CONSTRAINT "unit_status_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "housekeeping_events_unit_idx" ON "housekeeping_events" USING btree ("unit_id","occurred_at");--> statement-breakpoint
CREATE INDEX "unit_blocks_unit_idx" ON "unit_blocks" USING btree ("unit_id","start_date");