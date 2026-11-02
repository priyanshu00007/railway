# Security posture — RailBook v0.2

## Identity & sessions
- Passwords hashed with scrypt (64-byte derived key, per-user random salt) — `src/common/tokens.ts`.
- Access tokens: HMAC-SHA256 signed compact JWT-style, 15-minute TTL, timing-safe signature compare.
- Refresh tokens: opaque, **stored only as HMAC hashes**; rotation on every refresh (replay of an old token fails its revoked check); 30-day expiry; revocation on logout.
- Role model: `CUSTOMER` | `ADMIN`; `requireAdmin` on every admin route; ownership enforced in every read/cancel query (foreign users get 404, not 403 — no existence oracle).

## Authorization & data integrity
- `userId` **never** accepted from client bodies — always derived from the bearer token.
- Amounts/fare **never** accepted from clients — computed server-side from the pricing policy (`src/common/pricing.ts`).
- All inventory mutations inside transactions; overlap invariants enforced by the PostgreSQL exclusion constraint `seat_segment_no_overlap` (GiST), so even buggy app code cannot double-allocate.
- Hold confirmation, expiry, and cancellation are single-writer status-guarded updates (conditional `UPDATE … WHERE status=...`), race-safe with each other.
- Payment outcomes only from signed provider webhooks (HMAC-SHA256 hex over the canonical string, timing-safe); `providerReference` unique → replayed callbacks are no-ops (countered in metrics). Refunds are ledger entries marked `PENDING` — never reported complete without confirmation.

## XSS / injection
- JSON-only API; responses are `application/json`; HTML is never generated server-side (Swagger UI is a dev-only tool on `/docs`, gated off per-route with restricted CSP).
- Security headers on every API response via helmet + an `onSend` hook:
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'` (except `/docs*`),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  HSTS (prod), `Permissions-Policy` scoped, `cross-origin-resource-policy: same-site`.
- CORS: methods restricted to GET/POST/DELETE; in production the origin allow-list comes from `CORS_ORIGINS` (comma-separated). Dev allows all origins for local tooling.
- Defense-in-depth input hygiene: passenger names and other free text pass through `sanitizeText` (HTML markers + control characters stripped, whitespace collapsed) before persistence.
- No raw SQL from user-controlled identifiers: all numbers/strings go through Prisma's parameterized tagged templates; enum/text comparisons are explicit casts.
- Body size capped at 20 KB; JSON parsing rejects non-JSON content types.

## Abuse resistance
- Global rate limit 300 req/min; stricter per route: auth login/register 10/min, holds 30/min, trip search 120/min.
- Request IDs generated (or honored from `x-request-id`) and included in every error envelope; logs redact `authorization`, cookies, passwords and password hashes.
- 5xx responses never leak internal errors — stable `{statusCode, code, message, requestId}` envelope with stable codes (`SEAT_UNAVAILABLE`, `HOLD_EXPIRED`, `IDEMPOTENCY_KEY_REUSED`, …); 404s use the same envelope.

## Audit & traceability
- `audit_logs` rows for `BOOKING_CONFIRMED`, `BOOKING_CANCELLED`, `TRIP_CREATED` with actor, target, payload.
- `outbox_events` for payment and booking transitions; `idempotency_records`-style dedupe on payments via unique provider references.
- Prometheus counters (`/metrics`): requests, seat conflicts, holds created/expired, duplicate webhooks, confirmed/cancelled bookings, last lock-acquisition latency.

## Known limits (next steps)
- Idempotency-Key on `POST /holds` and `POST /bookings` routes is accepted only on payments today; wiring the generic interceptor (scoped key + request hash + stored response) onto both routes is the next hardening step.
- scrypt is a strong KDF but argon2id remains the target format factor (requires a native dependency).
- Rate limiting is in-memory (per-process); shareable store (e.g. Postgres counters) when horizontally scaled.
- CSP is relaxed on `/docs` (Swagger UI needs inline scripts); remove or auth-gate docs in production.
- No CSRF surface (no cookie sessions, bearer-only) — keep it that way if cookies are introduced later.
