# RailBook — PRD (v1.0)

Working specification. Architecture details in `SYSTEM_DESIGN.md`; endpoint contracts in `API_SPEC.md`.

## Vision

A reliable railway reservation backend with train discovery, segment-based seat inventory, expiring holds, booking confirmation, simulated payments, cancellation/refunds and admin management. Synthetic data; no real railway inventory or money.

## Problem

Availability changes between search and confirmation. Concurrent requests, retries, payment timeouts and cancellation races create duplicate allocations or inconsistent records. RailBook must stay consistent under concurrency, retries and interruption.

## Roles

- **Guest:** search stations, trips, fares; view indicative availability.
- **Customer:** register/login, create holds, submit passengers, view/book/cancel own bookings, track refunds.
- **Admin:** manage stations, trains, coaches, seats, routes, trips, fares and policies; inspect bookings/payments/audit; cancel trips.

## Key functional requirements

| ID | Requirement |
|----|-------------|
| FR-01 | Register/login; argon2id passwords; short-lived access tokens + rotating revocable refresh tokens; role enforcement |
| FR-02 | Station/train/route/coach/seat catalog; UTC timestamps; station timezone stored for display |
| FR-03 | Search by origin, destination, date; filter by class; results are snapshots, never reservations |
| FR-04 | Atomic seat allocation into temporary holds with server-set expiry; competing allocations rejected; expiry race-safe |
| FR-05 | Booking from valid hold; unique reference; explicit state machine; idempotency keys; fare snapshot |
| FR-06 | Simulated payment adapter; attempt/record tracking; duplicate and delayed-event handling |
| FR-07 | Cancellation eligibility; versioned policy charges; inventory released only per workflow; refunds tracked separately; refunds never reported complete before confirmation |
| FR-08 | Admin endpoints permission-protected; validated schedule changes; audit log |
| FR-09 | OpenAPI docs; validation; centralized errors; structured logs; health/readiness; migrations & recovery docs |

## Booking states

`PENDING_PAYMENT → CONFIRMED → CANCEL_PENDING → CANCELLED`; also `EXPIRED`, `PAYMENT_REVIEW`. Payment and refund statuses are separate models. All transitions validated server-side.

## Non-goals (MVP)

No official railway integration, no real money, no live train tracking, no dynamic pricing, no microservices/multi-region, no frontend commitment.

## Acceptance criteria

1. Concurrent requests cannot double-allocate the same seat segment.
2. Expired holds cannot be confirmed; release is safe and idempotent.
3. Same idempotency key never creates duplicate bookings or charges; same payload + same key returns the stored result, different payload is rejected.
4. Duplicate payment callbacks never double-charge or double-confirm.
5. Retried cancellations/refunds keep state consistent.
6. Customers cannot view or cancel others' bookings.
7. Admin endpoints require the admin role; critical actions are audited.
8. OpenAPI docs and integration tests exist and pass.
9. p95 search < 500 ms and booking transaction < 1 s on documented test workloads (test goals, not guarantees).

## Metrics

Zero duplicate allocations in tests; zero invalid state transitions in tests; idempotency tests pass concurrently; deterministic workloads reproducible; audited critical transitions.
