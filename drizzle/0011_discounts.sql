ALTER TABLE "properties" ADD COLUMN "discount_limit_front_office_bp" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "discount_limit_manager_bp" integer DEFAULT 5000 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "discount_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "discount" jsonb;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_discount_limits_range" CHECK ("properties"."discount_limit_front_office_bp" BETWEEN 0 AND 10000 AND "properties"."discount_limit_manager_bp" BETWEEN 0 AND 10000);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_discount_non_negative" CHECK ("reservations"."discount_amount" >= 0);