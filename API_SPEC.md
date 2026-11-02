# RailBook — API Spec (v1)

Base URL: `/api/v1`. JSON only. Error envelope:

```json
{ "statusCode": 4xx, "code": "STABLE_CODE", "message": "human readable", "requestId": "..." }
```

Stable codes: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, `HOLD_EXPIRED`, `SEAT_UNAVAILABLE`, `INVALID_STATE_TRANSITION`, `RATE_LIMITED`, `INTERNAL_ERROR`.

Auth: `Authorization: Bearer <access>`; refresh token in body/cookie. Idempotency header: `Idempotency-Key`. Rate limit headers standard.

## Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/register` | – | email, password → customer |
| POST | `/auth/login` | – | rate-limited |
| POST | `/auth/refresh` | – | rotates refresh token |
| POST | `/auth/logout` | customer | revokes session |
| GET | `/stations?q=` | – | search |
| GET | `/trains/search?origin=&destination=&date=&class=` | – | snapshot availability |
| GET | `/trips/:tripId` | – | stops, times |
| GET | `/trips/:tripId/availability?from=&to=&class=` | – | per-seat availability snapshot |
| POST | `/holds` | customer | tripId, fromStop, toStop, seats[] → hold w/ expiresAt |
| GET | `/holds/:id` | owner | status + expiry |
| DELETE | `/holds/:id` | owner | release (idempotent) |
| POST | `/bookings` | customer | from valid hold; Idempotency-Key required; passengers[] |
| GET | `/bookings` | owner | paginated list |
| GET | `/bookings/:id` | owner | detail |
| POST | `/bookings/:id/cancel` | owner | policy charges, refund record |
| POST | `/payments` | customer | bookingId; simulated provider |
| GET | `/payments/:id` | owner | status |
| GET | `/refunds/:id` | owner | status |
| POST | `/webhooks/payments/:provider` | signature | verified events, duplicate-safe |
| POST | `/admin/trips` | admin | create trip + stops + inventory |
| POST | `/admin/trips/:id/cancel` | admin | trip cancellation workflow |
| GET | `/healthz` | – | liveness |
| GET | `/readyz` | – | DB check |
| GET | `/docs` | – | OpenAPI UI |

Pagination: `?limit=&cursor=`; responses include `nextCursor`. Strict input schemas; unknown fields rejected.
