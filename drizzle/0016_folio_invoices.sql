CREATE TABLE "folio_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"party_id" uuid,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" bigint NOT NULL,
	"amount" bigint NOT NULL,
	"charge_date" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"void_reason" text,
	"voided_by" text,
	"voided_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folio_charges_category" CHECK ("folio_charges"."category" IN ('food_beverage', 'minibar', 'spa', 'transfer', 'laundry', 'tour', 'other')),
	CONSTRAINT "folio_charges_status" CHECK ("folio_charges"."status" IN ('active', 'void')),
	CONSTRAINT "folio_charges_quantity_positive" CHECK ("folio_charges"."quantity" > 0),
	CONSTRAINT "folio_charges_amount" CHECK ("folio_charges"."unit_price" >= 0 AND "folio_charges"."amount" = "folio_charges"."quantity" * "folio_charges"."unit_price")
);
--> statement-breakpoint
CREATE TABLE "folio_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"name" text NOT NULL,
	"details" text,
	"email" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"property_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invoice_counters_property_id_year_pk" PRIMARY KEY("property_id","year")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"party_id" uuid,
	"number" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"issued_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "folio_party_id" uuid;--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_charges" ADD CONSTRAINT "folio_charges_party_id_folio_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."folio_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_parties" ADD CONSTRAINT "folio_parties_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_party_id_folio_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."folio_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folio_charges_reservation_idx" ON "folio_charges" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "folio_parties_reservation_idx" ON "folio_parties" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_guest_idx" ON "invoices" USING btree ("reservation_id") WHERE "invoices"."party_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_party_idx" ON "invoices" USING btree ("party_id") WHERE "invoices"."party_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_folio_party_id_folio_parties_id_fk" FOREIGN KEY ("folio_party_id") REFERENCES "public"."folio_parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folio_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "folio_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
