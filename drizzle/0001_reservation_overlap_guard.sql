-- No two occupying reservations may share a unit on the same night.
-- Stays are half-open [check_in, check_out): a guest leaving on the 14th and
-- the next guest arriving on the 14th do not overlap.
-- Statuses listed here must match OCCUPYING_STATUSES in src/db/schema.ts.
-- An expired hold must be moved to 'expired' before its nights can be resold.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_overlap"
  EXCLUDE USING gist (
    "unit_id" WITH =,
    daterange("check_in", "check_out", '[)') WITH &&
  )
  WHERE ("status" IN ('hold', 'confirmed', 'in_house', 'checked_out'));
