# RailBook — Database Design (v1)

PostgreSQL via Prisma. All timestamps `timestamptz` UTC. Money as integer minor units. Segment inventory is the decided model.

## Entity map

```
User 1─* RefreshToken (hashed)
User 1─* Booking 1─* Passenger
User 1─* SeatHold 1─* SeatSegmentHold (seat + fromIndex..toIndex)
Station 1─* TripStop (ordered by stopIndex; Trip carries TripStops)
Trip 1─* TripSeat (per-trip instances seeded from Train coaches)
TripSeat 1─* SeatSegmentHold   (overlap constraint per trip+seat)
SeatSegmentHold 1─0..1 BookingSegment (survives into confirmed booking)
Booking 1─* Payment 1─* Refund
IdempotencyRecord (scope+key_hash unique, request_hash, stored response)
OutboxEvent (type, payload, processedAt) / AuditLog (actor, action, target, payload)
```

## Key integrity rules

- `Booking.bookingReference` unique (PNR-style, server-generated).
- `IdempotencyRecord (scope, key_hash)` unique.
- `Payment.providerEventId` unique (duplicate webhook safety).
- Insurance of the core invariant — no overlapping active allocations for the same trip seat:
  - Recommended: Postgres **exclusion constraint** with GiST on `(trip_seat_id EXCLUDE USING gist (int4range(from_index, to_index)) WHERE (status = 'ACTIVE'))`. Prisma does not express this natively — create it in a raw SQL of the migration, and mirror the predicate used by all writes.
  - Companion: transactional `SELECT ... FOR UPDATE` on the involved `TripSeat` rows in deterministic `(trip_id, seat)` order before inserts (also reduces deadlocks and allows friendly `SEAT_UNAVAILABLE` errors instead of raw constraint violations).
- `TripStop (trip_id, stop_index)` unique; `from_index < to_index` checked.
- Booking/payment/refund state transitions validated in application; DB check constraints protect format-level invariants (e.g. enums-as-varchar with allowed-value CHECKs where practical).

## Indexes (initial, pattern-driven)

- `TripSeat (trip_id, coach_no, seat_no)`
- `TripStop (station_id)` and `(trip_id, stop_index)` for search joins
- `SeatHold (user_id, status)`, `SeatHold (trip_id, expires_at)` for expiry sweep
- `Booking (user_id, created_at)`
- `Payment (booking_id)`, `(provider_ref)`

## Migration policy

- Prisma migrate with committed SQL; exclusion constraint added with raw SQL in a paired migration.
- No `db push` against any environment that holds data.
