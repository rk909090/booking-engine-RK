CREATE TYPE "public"."payment_provider" AS ENUM('simulated', 'xendit');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('deposit', 'balance', 'full', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'expired', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"reservation_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_channel" CHECK ("notification_outbox"."channel" IN ('email', 'whatsapp')),
	CONSTRAINT "notification_outbox_status" CHECK ("notification_outbox"."status" IN ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"purpose" "payment_purpose" NOT NULL,
	"amount" bigint NOT NULL,
	"currency" char(3) DEFAULT 'IDR' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"checkout_url" text,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_provider_ref_key" UNIQUE("provider","provider_ref"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "rate_seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_type_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"nightly_rate" bigint NOT NULL,
	"min_stay_nights" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_seasons_dates_ordered" CHECK ("rate_seasons"."end_date" > "rate_seasons"."start_date"),
	CONSTRAINT "rate_seasons_rate_non_negative" CHECK ("rate_seasons"."nightly_rate" >= 0),
	CONSTRAINT "rate_seasons_min_stay_positive" CHECK ("rate_seasons"."min_stay_nights" IS NULL OR "rate_seasons"."min_stay_nights" >= 1)
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "tax_rate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "service_rate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "deposit_rate_bp" integer DEFAULT 3000 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "balance_due_days" smallint DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "hold_minutes" smallint DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "cancellation_tiers" jsonb DEFAULT '[{"minDaysBefore":14,"chargeBp":0},{"minDaysBefore":7,"chargeBp":5000},{"minDaysBefore":0,"chargeBp":10000}]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "content" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "subtotal_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "service_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "tax_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "deposit_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "amount_paid" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "balance_due_date" date;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "refund_amount" bigint;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "price_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "policy_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "min_stay_nights" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "max_stay_nights" smallint DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "content" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "amenities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "sort_order" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "unit_types" ADD COLUMN "is_published" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_seasons" ADD CONSTRAINT "rate_seasons_unit_type_id_unit_types_id_fk" FOREIGN KEY ("unit_type_id") REFERENCES "public"."unit_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "payments_reservation_idx" ON "payments" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "rate_seasons_type_idx" ON "rate_seasons" USING btree ("unit_type_id","start_date");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_tax_rate_range" CHECK ("properties"."tax_rate_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_service_rate_range" CHECK ("properties"."service_rate_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_deposit_rate_range" CHECK ("properties"."deposit_rate_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_balance_due_days_non_negative" CHECK ("properties"."balance_due_days" >= 0);--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_hold_minutes_range" CHECK ("properties"."hold_minutes" BETWEEN 5 AND 120);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_amount_paid_non_negative" CHECK ("reservations"."amount_paid" >= 0);--> statement-breakpoint
ALTER TABLE "unit_types" ADD CONSTRAINT "unit_types_stay_range" CHECK ("unit_types"."min_stay_nights" >= 1 AND "unit_types"."max_stay_nights" >= "unit_types"."min_stay_nights");