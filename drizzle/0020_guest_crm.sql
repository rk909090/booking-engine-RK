ALTER TABLE "guests" DROP CONSTRAINT "guests_has_contact";--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "phone_normalized" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "apoa_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "apoa_reported_by" text;--> statement-breakpoint
CREATE INDEX "guests_phone_normalized_idx" ON "guests" USING btree ("phone_normalized");--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_has_contact" CHECK ("guests"."email" IS NOT NULL OR "guests"."phone" IS NOT NULL OR "guests"."anonymized_at" IS NOT NULL);--> statement-breakpoint
-- Existing guests: fill the normalised phone used to recognise returning guests.
UPDATE "guests" SET "phone_normalized" = CASE
  WHEN regexp_replace("phone", '\D', '', 'g') = '' THEN NULL
  WHEN regexp_replace("phone", '\D', '', 'g') LIKE '0%' THEN '62' || substr(regexp_replace("phone", '\D', '', 'g'), 2)
  ELSE regexp_replace("phone", '\D', '', 'g') END
WHERE "phone" IS NOT NULL;
