CREATE TABLE "report_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"recipients" smallint DEFAULT 0 NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_runs_period_key" UNIQUE("property_id","kind","period_key"),
	CONSTRAINT "report_runs_status" CHECK ("report_runs"."status" IN ('pending', 'sent', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "report_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"staff_id" uuid,
	"email" text,
	"locale" text DEFAULT 'id' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_subscriptions_kind" CHECK ("report_subscriptions"."kind" IN ('daily', 'weekly', 'monthly')),
	CONSTRAINT "report_subscriptions_one_recipient" CHECK (("report_subscriptions"."staff_id" IS NULL) <> ("report_subscriptions"."email" IS NULL)),
	CONSTRAINT "report_subscriptions_locale" CHECK ("report_subscriptions"."locale" IN ('id', 'en'))
);
--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_subscriptions" ADD CONSTRAINT "report_subscriptions_staff_id_staff_members_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_runs_status_idx" ON "report_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_subscriptions_recipient_key" ON "report_subscriptions" USING btree ("property_id","kind",coalesce("staff_id"::text, lower("email")));--> statement-breakpoint
-- Recipients' email addresses: only the server reads these.
ALTER TABLE "report_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_runs" ENABLE ROW LEVEL SECURITY;
