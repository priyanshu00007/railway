// E2E smoke test: search → auth → hold → intent → webhook → booking → cancel.
// Run: node scripts/e2e.mjs (server must be running on BASE, default :3000)

const BASE = process.env.BASE ?? "http://localhost:3000";
const SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "sim-webhook-secret-dev-only";

const { createHmac } = await import("node:crypto");

function assert(cond, label, extra = "") {
  if (!cond) {
    console.error(`FAIL: ${label} ${extra}`);
    process.exit(1);
  }
  console.log(`ok: ${label} ${extra}`);
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      // content-type only when a body exists: an empty body with a JSON
      // content-type is rejected by Fastify's JSON parser (400) even on DELETE.
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json };
}

// 1. Discovery
const tomorrow = new Date(Date.now() + 86400_000);
const date = tomorrow.toISOString().slice(0, 10);
let r = await call("GET", `/api/v1/stations`);
assert(r.status === 200 && r.json.some((s) => s.code === "NDLS"), "stations list", `(${r.json?.length} stations)`);

r = await call("GET", `/api/v1/trips/search?from=NDLS&to=AGC&date=${date}`);
assert(r.status === 200 && r.json.length > 0, "trip search NDLS→AGC");
const trip = r.json[0];
assert(trip.originStopIndex === 0 && trip.destinationStopIndex === 2, "stops resolved", `[0,2) for NDLS→AGC`);
assert(trip.classes.some((c) => c.availableSeats > 0), "classes with availability", JSON.stringify(r.json[0].classes));
const tripId = trip.tripId;

r = await call("GET", `/api/v1/trips/${tripId}/availability?originCode=NDLS&destinationCode=AGC`);
assert(r.status === 200 && r.json.seatMap.every((s) => ["FREE", "HELD", "OCCUPIED"].includes(s.state)) && r.json.seatMap.some((s) => s.classType === "SECOND" && s.state === "FREE"), "seat map states valid with free SECOND seats",  `(${r.json.seatMap.length} seats)`);

// 2. Auth
r = await call("POST", "/api/v1/auth/register", {
  body: { email: `e2e-${Date.now()}@railbook.dev`, password: "e2e-passw0rd!" },
});
assert(r.status === 201 && r.json.accessToken, "register", `userId=${r.json.userId}`);
const token = r.json.accessToken;

// ownership: hold without token must fail
r = await call("POST", "/api/v1/holds", { body: { tripId, classType: "SECOND", originCode: "NDLS", destinationCode: "AGC" } });
assert(r.status === 401, "hold without token rejected 401");

// 3. Hold (atomic, SKIP LOCKED)
r = await call("POST", "/api/v1/holds", {
  token,
  body: { tripId, classType: "SECOND", originCode: "NDLS", destinationCode: "AGC" },
});
assert(r.status === 201, "hold created", `${r.json.coachCode}-${r.json.seatNumber} [${r.json.segmentRange.startStopIndex},${r.json.segmentRange.endStopIndex})`);
const hold = r.json;
const fare = hold.fareMinor;

r = await call("GET", `/api/v1/holds/${hold.holdId}`, { token });
assert(r.status === 200 && r.json.status === "ACTIVE" && r.json.secondsRemaining > 540, "hold live countdown");

// 4. Payment intent (server-derived amount)
const idemKey = crypto.randomUUID();
r = await call("POST", "/api/v1/payments/create-intent", { token, body: { holdId: hold.holdId }, headers: { "idempotency-key": idemKey } });
assert(r.status === 201 && r.json.amountMinor === fare, "payment intent", `amount=${r.json.amountMinor}`);
const payment = r.json;
r = await call("POST", "/api/v1/payments/create-intent", { token, body: { holdId: hold.holdId }, headers: { "idempotency-key": idemKey } });
assert(r.status === 201 && r.json.paymentId === payment.paymentId, "idempotent intent retry returns same payment");

// 5. Webhook (HMAC signed, replayed once → duplicate ignored)
const evt = {
  eventId: crypto.randomUUID(),
  eventType: "PAYMENT_SUCCESS",
  paymentReference: `pay_sim_${Date.now()}`,
  holdId: hold.holdId,
  amount: fare,
};
evt.signature = createHmac("sha256", SECRET)
  .update(`${evt.eventId}|${evt.paymentReference}|${evt.amount}|${evt.eventType}`)
  .digest("hex");
r = await call("POST", "/api/v1/webhooks/payments", { body: evt });
assert(r.status === 200 && r.json.status === "accepted", "webhook accepted");
r = await call("POST", "/api/v1/webhooks/payments", { body: evt });
assert(r.status === 200 && r.json.status === "duplicate_ignored", "duplicate webhook ignored");

// 5b. Bad signatures rejected
r = await call("POST", "/api/v1/webhooks/payments", { body: { ...evt, signature: "deadbeef" } });
assert(r.status === 401, "bad signature rejected 401");

// 6. Finalize booking (hold → CONFIRMED)
r = await call("POST", "/api/v1/bookings", {
  token,
  body: {
    holdId: hold.holdId,
    paymentReference: evt.paymentReference,
    passengers: [{ fullName: "Rajesh Sharma", age: 34, gender: "M" }],
  },
});
assert(r.status === 201 && r.json.status === "CONFIRMED", "booking confirmed", `${r.json.pnr} seat ${r.json.coach}-${r.json.seatNumber}`);
const booking = r.json;

// ownership: other users must not see it
r = await call("GET", `/api/v1/bookings/${booking.bookingId}`, { token: token.slice(0, -2) + "zz" });
assert(r.status === 401 || r.status === 404, "foreign booking hidden");

// confirmed seat now OCCUPIED on the map
r = await call("GET", `/api/v1/trips/${tripId}/availability?originCode=NDLS&destinationCode=AGC`);
const mine = r.json.seatMap.find((s) => s.seatNumber === booking.seatNumber && s.coachCode === booking.coach);
assert(mine?.state === "OCCUPIED", "seat shows OCCUPIED after confirmation");

// Segment resale: NDLS→MTJ [0,1) overlaps? [0,2) vs... choose MTJ→GWL [1,3) → overlaps [0,2)? max(1,0)<min(3,2)? 1<2 → must NOT reuse same seat but another seat free; but AGC→VGLJ [2,4) DOES NOT overlap [0,2) → same physical seat could be resold.
r = await call("POST", "/api/v1/holds", { token, body: { tripId, classType: "SECOND", originCode: "AGC", destinationCode: "VGLJ" } });
assert(r.status === 201, "segment resale", `second journey got ${r.json.coachCode}-${r.json.seatNumber} (may be same or different seat)`);
await call("DELETE", `/api/v1/holds/${r.json.holdId}`, { token });

// 7. Cancel + refund ledger
r = await call("POST", `/api/v1/bookings/${booking.bookingId}/cancel`, { token, body: {} });
assert(r.status === 200 && r.json.status === "CANCELLED", "cancelled", `refund=${r.json.refundAmount} fee=${r.json.cancellationFee} raw=${JSON.stringify(r.json)}`);
const fee = r.json.cancellationFee;
assert(fee === Math.max(20000, Math.round(fare * 0.2)), "fee policy 20% min 20000");

r = await call("POST", `/api/v1/bookings/${booking.bookingId}/cancel`, { token, body: {} });
assert(r.status === 200 && r.json.status === "CANCELLED", "cancel retry idempotent");

// seat freed after cancel
r = await call("GET", `/api/v1/trips/${tripId}/availability?originCode=NDLS&destinationCode=AGC`);
const again = r.json.seatMap.find((s) => s.seatNumber === booking.seatNumber && s.coachCode === booking.coach);
assert(again?.state === "FREE", "seat freed after cancellation");

// 8. Preferred-seat allotment: reserve EXACT seat via preferredCoach/preferredSeat
r = await call("POST", "/api/v1/holds", { token, body: { tripId, classType: "SLEEPER", originCode: "NDLS", destinationCode: "GWL", preferredCoach: "S1", preferredSeat: 7 } });
assert(r.status === 201 && r.json.coachCode === "S1" && r.json.seatNumber === 7, "exact seat allotment S1-7", `(${r.status} ${JSON.stringify(r.json)})`);
if (r.status === 201) await call("DELETE", `/api/v1/holds/${r.json.holdId}`, { token });
// double-allocation under concurrency: two racing holds for the exact seat must
// never both get S1-7 (DB exclusion constraint is the backstop).
const [a, b] = await Promise.all([
  call("POST", "/api/v1/holds", { token, body: { tripId, classType: "SLEEPER", originCode: "NDLS", destinationCode: "GWL", preferredCoach: "S1", preferredSeat: 7 } }),
  call("POST", "/api/v1/holds", { token, body: { tripId, classType: "SLEEPER", originCode: "NDLS", destinationCode: "GWL", preferredCoach: "S1", preferredSeat: 7 } }),
]);
const results = [a.json, b.json];
assert([a.status, b.status].every((s) => s === 201 || s === 409), "racing exact-seat holds resolve", `(${a.status}/${b.status})`);
assert(results.filter((j) => j.coachCode === "S1" && j.seatNumber === 7).length <= 1, "S1-7 allocated at most once", JSON.stringify(results.map((j) => `${j.coachCode}-${j.seatNumber}`)));
for (const j of results) if (j.holdId) await call("DELETE", `/api/v1/holds/${j.holdId}`, { token });

// sequential re-request after release is legal: exact seat is free again
r = await call("POST", "/api/v1/holds", { token, body: { tripId, classType: "SLEEPER", originCode: "NDLS", destinationCode: "GWL", preferredCoach: "S1", preferredSeat: 7 } });
assert(r.status === 201 && r.json.coachCode === "S1" && r.json.seatNumber === 7, "exact seat re-acquired after release", `(${r.status} ${JSON.stringify(r.json)})`);
if (r.status === 201) await call("DELETE", `/api/v1/holds/${r.json.holdId}`, { token });

// 9. Trip tracking: full route + progress milestones
r = await call("GET", `/api/v1/trips/${tripId}/progress`);
assert(
  r.status === 200 && r.json.stops.length === 5 && r.json.stops[0].code === "NDLS" && r.json.stops[4].code === "VGLJ" &&
  r.json.stops.every((s) => ["departed", "at_stop", "upcoming"].includes(s.milestone)),
  "trip progress milestones",
  `nextStop=${r.json.nextStop?.code ?? "-"} running=${r.json.running}`,
);

// 10. Booking list pagination envelope
r = await call("GET", "/api/v1/bookings?limit=1", { token });
assert(r.status === 200 && Array.isArray(r.json.items) && "nextCursor" in r.json, "paginated bookings");

// 11. Metrics
r = await call("GET", "/metrics");
assert(r.status === 200, "metrics exposed", `(${r.status})`);

console.log("\nE2E PASSED ✔");
