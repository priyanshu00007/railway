# AGENTS.md

## Project

RailBook — a railway reservation backend built with Fastify, TypeScript, PostgreSQL and Prisma.

## Requirement status

- **Segment-based inventory is a decision, not an option.** The same physical seat may be sold for non-overlapping station-to-station segments. Never regress to whole-trip inventory without an explicit plan to migrate.

## Core engineering rules

1. TypeScript with strict compiler settings.
2. pnpm for dependency management (`pnpm-lock.yaml` when available).
3. Modular monolith: no microservices, Kafka, Kubernetes, or Redis without a documented requirement.
4. Separate HTTP handlers, application services, domain logic and persistence.
5. PostgreSQL is the source of truth for bookings, payments, refunds and seat inventory.
6. Never implement booking correctness with in-memory locks, Redis, or client-side state alone.
7. Never trust client-supplied prices, statuses, user IDs, payment outcomes or hold ownership.
8. Inventory mutations happen inside database transactions with constraints or row locks.
9. Every retried booking/payment operation has an explicit idempotency strategy.
10. Never claim a real payment succeeded without verified provider evidence.

## Code organization

Feature modules under `src/modules/<feature>` (e.g. `auth`, `trains`, `inventory`, `bookings`, `payments`). Each may contain routes, schemas, services, repositories, and tests. No empty abstraction layers.

## API conventions

- Business endpoints under `/api/v1`.
- Resource-oriented routes; validate input/output with Fastify schemas (TypeBox-style).
- Consistent error envelope: `{ statusCode, code, message, requestId }` with stable `code` values.
- Request IDs propagated into logs; never leak stack traces or secrets to clients.
- OpenAPI docs at `/docs`.

## Booking correctness

- Search availability is a snapshot, never a reservation.
- Allocate inventory atomically in a transaction; enforce overlap invariants at the DB level (exclusion/unique constraints) where possible.
- Consistent lock ordering; explicit isolation and retry behavior.
- No external payment network calls while a DB transaction is open.
- Hold expiry and expiry processing must be idempotent and race-safe with confirmation.
- Payment/refund states modeled separately from booking states.
- Add/update concurrency tests before touching inventory allocation logic.

## Security

- Modern password hashing (argon2). Refresh tokens stored as hashes.
- Authorization checked on every protected operation; ownership enforced server-side.
- Rate-limit login, booking and expensive searches.
- Redact tokens, passwords and sensitive passenger data from logs.
- Never commit `.env` files or credentials.

## Database changes

- Prisma schema changes and migration files committed together.
- No destructive `prisma db push` against any shared/dev DB.
- Indexes from measured query patterns; explicit FKs, unique and check constraints.
- Money as integer minor units. All timestamps in UTC (Postgres `timestamptz`).

## Testing

- Unit-test domain/state machines; integration-test persistence on PostgreSQL.
- Required scenarios: concurrent seat allocation, idempotent booking, duplicate payment callbacks, expired holds, cancellation races, refund retries, ownership failures.
- Run lint, type-check, unit and integration tests before merging. Never weaken assertions to make CI pass.

## Observability

- Pino structured logs; request and DB latency; liveness/readiness endpoints.
- Audit records for privileged actions and significant booking transitions.

## Workflow

1. Read the relevant module and tests first. 2. Identify affected state transitions and constraints. 3. Smallest coherent change. 4. Add tests. 5. Format/lint, type-check, test. 6. Summarize migrations and limits.

## Scope control

- Synthetic data and simulated payments only; no real railway or payment integrations without explicit approval.
- Do not put authoritative state only in caches/queues.
