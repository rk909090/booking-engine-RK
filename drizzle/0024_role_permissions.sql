CREATE TABLE "role_permissions" (
	"role" "staff_role" NOT NULL,
	"action" text NOT NULL,
	"allowed" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_role_action_pk" PRIMARY KEY("role","action")
);

--> statement-breakpoint
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
