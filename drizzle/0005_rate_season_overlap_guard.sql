-- Seasons of the same villa type may not overlap, so every night has at
-- most one seasonal rate. [start_date, end_date) like stays.
ALTER TABLE "rate_seasons"
  ADD CONSTRAINT "rate_seasons_no_overlap"
  EXCLUDE USING gist (
    "unit_type_id" WITH =,
    daterange("start_date", "end_date", '[)') WITH &&
  );
