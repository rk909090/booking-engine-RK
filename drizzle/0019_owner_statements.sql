CREATE TABLE "owner_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"expense_date" date NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"task_id" uuid,
	"created_by" text NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" text,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_expenses_category" CHECK ("owner_expenses"."category" IN ('utilities', 'repairs', 'supplies', 'cleaning', 'staff', 'pool_garden', 'internet', 'other', 'adjustment')),
	CONSTRAINT "owner_expenses_amount" CHECK ("owner_expenses"."amount" <> 0 AND ("owner_expenses"."amount" > 0 OR "owner_expenses"."category" = 'adjustment')),
	CONSTRAINT "owner_expenses_source" CHECK ("owner_expenses"."source" IN ('manual', 'maintenance'))
);
--> statement-breakpoint
CREATE TABLE "owner_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"month" date NOT NULL,
	"status" text DEFAULT 'locked' NOT NULL,
	"room_revenue" bigint NOT NULL,
	"commission" bigint NOT NULL,
	"management_fee" bigint NOT NULL,
	"expenses" bigint NOT NULL,
	"payout" bigint NOT NULL,
	"data" jsonb NOT NULL,
	"locked_at" timestamp with time zone NOT NULL,
	"locked_by" text NOT NULL,
	"paid_at" timestamp with time zone,
	"paid_by" text,
	"paid_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_statements_owner_property_month_key" UNIQUE("owner_id","property_id","month"),
	CONSTRAINT "owner_statements_status" CHECK ("owner_statements"."status" IN ('locked', 'paid')),
	CONSTRAINT "owner_statements_month_first_day" CHECK (extract(day from "owner_statements"."month") = 1)
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"amount" bigint NOT NULL,
	"start_month" date NOT NULL,
	"end_month" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_expenses_amount_positive" CHECK ("recurring_expenses"."amount" > 0),
	CONSTRAINT "recurring_expenses_category" CHECK ("recurring_expenses"."category" IN ('utilities', 'repairs', 'supplies', 'cleaning', 'staff', 'pool_garden', 'internet', 'other')),
	CONSTRAINT "recurring_expenses_months" CHECK (extract(day from "recurring_expenses"."start_month") = 1 AND ("recurring_expenses"."end_month" IS NULL OR (extract(day from "recurring_expenses"."end_month") = 1 AND "recurring_expenses"."end_month" >= "recurring_expenses"."start_month")))
);
--> statement-breakpoint
CREATE TABLE "unit_ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"management_fee_bp" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unit_ownerships_dates_ordered" CHECK ("unit_ownerships"."end_date" IS NULL OR "unit_ownerships"."end_date" > "unit_ownerships"."start_date"),
	CONSTRAINT "unit_ownerships_fee_range" CHECK ("unit_ownerships"."management_fee_bp" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "commission_rates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_expenses" ADD CONSTRAINT "owner_expenses_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_statements" ADD CONSTRAINT "owner_statements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ADD CONSTRAINT "recurring_expenses_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_ownerships" ADD CONSTRAINT "unit_ownerships_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_ownerships" ADD CONSTRAINT "unit_ownerships_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "owner_expenses_task_key" ON "owner_expenses" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "owner_expenses_property_date_idx" ON "owner_expenses" USING btree ("property_id","expense_date");--> statement-breakpoint
CREATE INDEX "owner_statements_property_month_idx" ON "owner_statements" USING btree ("property_id","month");--> statement-breakpoint
CREATE INDEX "recurring_expenses_property_idx" ON "recurring_expenses" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "unit_ownerships_owner_idx" ON "unit_ownerships" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "unit_ownerships_unit_idx" ON "unit_ownerships" USING btree ("unit_id","start_date");--> statement-breakpoint
-- A villa has one owner at a time: ownership periods [start_date, end_date) may not overlap (open end = still owned).
ALTER TABLE "unit_ownerships"
  ADD CONSTRAINT "unit_ownerships_no_overlap"
  EXCLUDE USING gist (
    "unit_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  );--> statement-breakpoint
-- Owner contact details and payouts: only the server (service connection) reads these.
ALTER TABLE "owners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "unit_ownerships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owner_expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "owner_statements" ENABLE ROW LEVEL SECURITY;
