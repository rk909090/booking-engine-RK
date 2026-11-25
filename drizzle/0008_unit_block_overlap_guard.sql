-- Open maintenance blocks of one unit may not overlap each other.
-- (Blocks vs reservations are checked in the application, inside the same
-- transaction that creates the block or the hold.)
ALTER TABLE "unit_blocks"
  ADD CONSTRAINT "unit_blocks_no_overlap"
  EXCLUDE USING gist (
    "unit_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  )
  WHERE ("status" = 'open');
