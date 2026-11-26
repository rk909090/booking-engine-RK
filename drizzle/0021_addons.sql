CREATE TABLE "addon_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"source" text NOT NULL,
	"service_date" date NOT NULL,
	"service_time" time,
	"persons" smallint DEFAULT 1 NOT NULL,
	"nights" smallint DEFAULT 1 NOT NULL,
	"quantity" smallint DEFAULT 1 NOT NULL,
	"units" smallint NOT NULL,
	"unit_price" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"folio_charge_id" uuid,
	"task_id" uuid,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addon_orders_status" CHECK ("addon_orders"."status" IN ('requested', 'confirmed', 'declined', 'cancelled')),
	CONSTRAINT "addon_orders_source" CHECK ("addon_orders"."source" IN ('checkout', 'portal', 'staff')),
	CONSTRAINT "addon_orders_counts" CHECK ("addon_orders"."persons" >= 1 AND "addon_orders"."nights" >= 1 AND "addon_orders"."quantity" >= 1 AND "addon_orders"."units" >= 1),
	CONSTRAINT "addon_orders_amount" CHECK ("addon_orders"."amount" = "addon_orders"."units" * "addon_orders"."unit_price")
);
--> statement-breakpoint
CREATE TABLE "addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"category" text NOT NULL,
	"pricing" text NOT NULL,
	"price" bigint NOT NULL,
	"needs_time" boolean DEFAULT true NOT NULL,
	"lead_hours" smallint DEFAULT 24 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "addons_pricing" CHECK ("addons"."pricing" IN ('per_booking', 'per_person', 'per_night', 'per_person_night')),
	CONSTRAINT "addons_category" CHECK ("addons"."category" IN ('food_beverage', 'minibar', 'spa', 'transfer', 'laundry', 'tour', 'other')),
	CONSTRAINT "addons_price_positive" CHECK ("addons"."price" > 0),
	CONSTRAINT "addons_lead_hours_range" CHECK ("addons"."lead_hours" BETWEEN 0 AND 720)
);
--> statement-breakpoint
ALTER TABLE "addon_orders" ADD CONSTRAINT "addon_orders_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_orders" ADD CONSTRAINT "addon_orders_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_orders" ADD CONSTRAINT "addon_orders_folio_charge_id_folio_charges_id_fk" FOREIGN KEY ("folio_charge_id") REFERENCES "public"."folio_charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addon_orders" ADD CONSTRAINT "addon_orders_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addons" ADD CONSTRAINT "addons_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "addon_orders_reservation_idx" ON "addon_orders" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "addon_orders_status_idx" ON "addon_orders" USING btree ("status","service_date");--> statement-breakpoint
CREATE INDEX "addons_property_idx" ON "addons" USING btree ("property_id","sort_order");--> statement-breakpoint
-- Only the server (service connection) reads these; block the public Supabase API.
ALTER TABLE "addons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "addon_orders" ENABLE ROW LEVEL SECURITY;
