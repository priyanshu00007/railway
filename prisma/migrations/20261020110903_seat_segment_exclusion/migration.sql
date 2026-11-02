CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Core invariant: for a given TripSeat, live segment allocations may never
-- overlap in stop-index space. Segment rows are deleted when their hold is
-- released or expired, so all remaining rows are live allocations.
ALTER TABLE "seat_segment_holds"
  ADD CONSTRAINT "seat_segment_no_overlap"
  EXCLUDE USING gist (
    "tripSeatId" gist_text_ops WITH =,
    int4range("fromIndex", "toIndex") WITH &&
  );
