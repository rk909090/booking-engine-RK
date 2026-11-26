CREATE TABLE "arrival_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_type_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arrival_closures_dates_ordered" CHECK ("arrival_closures"."end_date" > "arrival_closures"."start_date")
);
--> statement-breakpoint
CREATE TABLE "promo_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"value_bp" integer,
	"amount" bigint,
	"book_from" date,
	"book_until" date,
	"stay_from" date,
	"stay_until" date,
	"min_nights" smallint,
	"unit_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"max_uses" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_codes_property_code_key" UNIQUE("property_id","code"),
	CONSTRAINT "promo_codes_code_format" CHECK ("promo_codes"."code" ~ '^[A-Z0-9]{3,20}$'),
	CONSTRAINT "promo_codes_value" CHECK (("promo_codes"."kind" = 'percent' AND "promo_codes"."value_bp" BETWEEN 1 AND 9000 AND "promo_codes"."amount" IS NULL) OR ("promo_codes"."kind" = 'amount' AND "promo_codes"."amount" > 0 AND "promo_codes"."value_bp" IS NULL)),
	CONSTRAINT "promo_codes_min_nights_positive" CHECK ("promo_codes"."min_nights" IS NULL OR "promo_codes"."min_nights" >= 1),
	CONSTRAINT "promo_codes_max_uses_positive" CHECK ("promo_codes"."max_uses" IS NULL OR "promo_codes"."max_uses" >= 1),
	CONSTRAINT "promo_codes_book_window" CHECK ("promo_codes"."book_from" IS NULL OR "promo_codes"."book_until" IS NULL OR "promo_codes"."book_until" >= "promo_codes"."book_from"),
	CONSTRAINT "promo_codes_stay_window" CHECK ("promo_codes"."stay_from" IS NULL OR "promo_codes"."stay_until" IS NULL OR "promo_codes"."stay_until" >= "promo_codes"."stay_from")
);
--> statement-breakpoint
ALTER TABLE "rate_seasons" DROP CONSTRAINT "rate_seasons_rate_non_negative";--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "non_refundable_bp" integer;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "breakfast_per_guest" bigint;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "early_bird_days" smallint;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "early_bird_bp" integer;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "long_stay_tiers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rate_seasons" ADD COLUMN "weekend_rate" bigint;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "rate_plan" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "pricing_terms" jsonb;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "promo_code_id" uuid;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "breakfast_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "weekend_rate" bigint;--> statement-breakpoint
ALTER TABLE "arrival_closures" ADD CONSTRAINT "arrival_closures_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrival_closures" ADD CONSTRAINT "arrival_closures_unit_type_id_unit_types_id_fk" FOREIGN KEY ("unit_type_id") REFERENCES "public"."unit_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "arrival_closures_property_idx" ON "arrival_closures" USING btree ("property_id","start_date");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservations_promo_code_idx" ON "reservations" USING btree ("promo_code_id");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_non_refundable_bp_range" CHECK ("properties"."non_refundable_bp" IS NULL OR "properties"."non_refundable_bp" BETWEEN 1 AND 9000);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_breakfast_positive" CHECK ("properties"."breakfast_per_guest" IS NULL OR "properties"."breakfast_per_guest" > 0);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_early_bird_pair" CHECK (("properties"."early_bird_days" IS NULL) = ("properties"."early_bird_bp" IS NULL));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_early_bird_range" CHECK ("properties"."early_bird_days" IS NULL OR ("properties"."early_bird_days" BETWEEN 1 AND 365 AND "properties"."early_bird_bp" BETWEEN 1 AND 9000));--> statement-breakpoint
ALTER TABLE "rate_seasons" ADD CONSTRAINT "rate_seasons_rate_non_negative" CHECK ("rate_seasons"."nightly_rate" >= 0 AND ("rate_seasons"."weekend_rate" IS NULL OR "rate_seasons"."weekend_rate" >= 0));--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_rate_plan_known" CHECK ("reservations"."rate_plan" IN ('standard', 'non_refundable', 'breakfast'));--> statement-breakpoint
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_weekend_rate_non_negative" CHECK ("unit_types"."weekend_rate" IS NULL OR "unit_types"."weekend_rate" >= 0);--> statement-breakpoint
-- Only the server (service connection) reads these; block the public Supabase API.
ALTER TABLE "arrival_closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "promo_codes" ENABLE ROW LEVEL SECURITY;
