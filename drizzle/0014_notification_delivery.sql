ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_status";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE INDEX "notification_outbox_reservation_idx" ON "notification_outbox" USING btree ("reservation_id");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_dedupe_key_unique" UNIQUE("dedupe_key");--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_status" CHECK ("notification_outbox"."status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'));