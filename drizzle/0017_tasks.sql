CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"reservation_id" uuid,
	"kind" text NOT NULL,
	"source" text,
	"title" text NOT NULL,
	"notes" text,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"due_date" date,
	"due_time" time,
	"block_id" uuid,
	"checklist" jsonb,
	"result" text,
	"created_by" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_kind" CHECK ("tasks"."kind" IN ('clean', 'inspect', 'maintenance', 'request')),
	CONSTRAINT "tasks_status" CHECK ("tasks"."status" IN ('open', 'in_progress', 'done', 'cancelled')),
	CONSTRAINT "tasks_result" CHECK ("tasks"."result" IS NULL OR "tasks"."result" IN ('passed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_unit_id_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_staff_members_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_block_id_unit_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."unit_blocks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_clean_idx" ON "tasks" USING btree ("unit_id") WHERE "tasks"."kind" = 'clean' AND "tasks"."status" IN ('open', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_inspect_idx" ON "tasks" USING btree ("unit_id") WHERE "tasks"."kind" = 'inspect' AND "tasks"."status" IN ('open', 'in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_request_idx" ON "tasks" USING btree ("reservation_id","source") WHERE "tasks"."kind" = 'request' AND "tasks"."status" IN ('open', 'in_progress');--> statement-breakpoint
CREATE INDEX "tasks_property_status_idx" ON "tasks" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id","status");--> statement-breakpoint
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
