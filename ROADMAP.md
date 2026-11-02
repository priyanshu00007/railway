# RailBook — Roadmap

| Phase | Outcome | Status |
|---|---|---|
| 1. Foundation | scaffold, TS strict, Postgres up, migrations, health checks, CI, seeds, swagger | **current** |
| 2. Identity & catalog | auth+jwt+refresh, stations/trains/coaches/seats, trips & stops, search | pending |
| 3. Inventory & booking | availability query, transactional holds + expiry, booking state machine, concurrency & idempotency tests | pending |
| 4. Payments & cancellation | simulated provider, duplicate-safe webhooks, reconciliation, refund policies, outbox worker | pending |
| 5. Production-readiness | security tests, load tests, Railway deploy, monitoring, ops docs | pending |

## Definition of done (per phase)

- `pnpm lint && pnpm typecheck && pnpm test` green locally and in CI.
- New schema changes ship with committed migrations + rollback notes.
- New endpoints documented in `API_SPEC.md` and OpenAPI.
- Acceptance criteria in `PRD.md` that map to the phase are tested.
