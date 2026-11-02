# RailBook — System Design

## Architecture (modular monolith)

```
Clients ─► Fastify API (validation · auth · rate limit · logging)
                 │
     Domain modules (search, inventory, booking, payment, admin)
                 │
       Background worker (hold expiry, payment reconcile, outbox)  [separate process when needed]
                 │
       PostgreSQL — transactional source of truth, constraints, row locks
```

Deployment: one API service, one PostgreSQL. Worker process added when hold expiry / reconciliation / outbox justify it. Redis only as an optimization later — never the sole guard of booking correctness.

## Inventory model (segment-based — DECIDED)

A single physical seat is bookable for **non-overlapping station segments** of a scheduled trip.

Core invariant: for one `(trip_id, coach_id, seat_number)`, two seat allocations on the same trip must not overlap in stop-index space.

Representation: each trip stop has a station-ordered index (`stopIndex` 0..N-1). A segment allocation covers `[fromIndex, toIndex)` (open end, matching boarding at `fromIndex` and alighting at `toIndex`). Overlap check uses standard interval logic: allocations A and B conflict iff `A.fromIndex < B.toIndex AND B.fromIndex < A.toIndex`.

Guard rails:

- `SearchReturnLegsOff`-style logic is unnecessary; all trips are one direction per trip row.
- Enforce overlap invariants at the database level (exclusion constraint via GiST on int4range, plus transactional SELECT … FOR UPDATE lock ordering by seat) where feasible; application-level checks are the fallback, not the primary defense.
- Lock acquisition order: always lock seats by `(trip_id, coach_id, seat_number)` ascending, then segment rows, to reduce deadlocks.

## Booking lifecycle

```
search (snapshot) ─► create hold (txn, atomic allocation, expires_at)
      ─► initiate payment (idempotency key, PENDING_PAYMENT)
            ├─ success ─► confirm booking (txn: verify hold active, booking → CONFIRMED)
            ├─ failure ─► release hold, booking → cancelled/failed path
            └─ timeout ─► PAYMENT_REVIEW; check provider final state BEFORE releasing/reassigning inventory
```

Rules:

- `expiresAt` is server time; confirmation must re-verify the hold inside the confirming transaction.
- Confirmation vs expiry race: both are conditional updates keyed on hold status (`ACTIVE`); only one wins.
- Never do external payment network calls inside an open transaction.

## Idempotency

`IdempotencyRecord (scope, key_hash, request_hash, response, status)`, unique on `(scope, key_hash)`. Same key + same request hash → return stored response; different request hash → `409 IDEMPOTENCY_KEY_REUSED`. Applied to booking creation, payment initiation, and webhook/event ingestion.

## Payments (simulated)

Provider adapter interface (`PaymentProvider`), default deterministic simulator (seedable outcomes). Payment/refund statuses tracked separately from booking: `PENDING / SUCCEEDED / FAILED / DUPLICATE_SUSPECTED / RECONCILED …`. Webhook endpoint verifies provider signature before processing; support duplicate callbacks (payment intent) outbox pattern; `OutboxEvent` rows processed exactly-once-effect (idempotent handlers).

## Consistency & failure handling

- PostgreSQL is the only source of truth; constraints carry the invariants.
- Payment proven success only on verified provider evidence (simulator event or webhook).
- A payment timeout is not a failure: mark `PAYMENT_REVIEW`, reconcile asynchronously.
- Expired holds are released by a reconciliation job + on-demand check; both idempotent.
- Audit log for privileged actions and booking/payment transitions.

## Capacity assumptions (v1)

Small: hundreds of trips, thousands of seats per trip, low write concurrency. No sharding, no read replicas, no pre-optimization; add indexes from measured query patterns.
