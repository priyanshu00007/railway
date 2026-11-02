import { Type, Static } from "@sinclair/typebox";

// Shared schemas for Fastify: request validation, fast serialization, OpenAPI.
// NOTE: userId is NEVER accepted in request bodies; it comes from the auth
// context (see src/common/errors.md / auth module). Dev-mode requests may use
// the seeded demo user until the auth module lands.

export const STATION_CODE = Type.String({ minLength: 2, maxLength: 10 });
const UUID = Type.String({ });
const DATE_ONLY = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });

// ─── 1. TRIP SEARCH ──────────────────────────────────────────────────────────

export const SearchTripsQuerySchema = Type.Object({
  originCode: STATION_CODE,
  destinationCode: STATION_CODE,
  departureDate: DATE_ONLY, // YYYY-MM-DD, interpreted in station-local context, stored UTC
});

export const AvailableClassSchema = Type.Object({
  classType: Type.String(),
  availableSeatsCount: Type.Integer({ minimum: 0 }),
});

export const SearchTripsResponseSchema = Type.Array(
  Type.Object({
    tripId: UUID,
    trainNumber: Type.String(),
    trainName: Type.String(),
    originStation: Type.String(),
    destinationStation: Type.String(),
    departureTime: Type.String({ format: "date-time" }),
    arrivalTime: Type.String({ format: "date-time" }),
    originStopIndex: Type.Integer({ minimum: 0 }),
    destinationStopIndex: Type.Integer({ minimum: 0 }),
    availableClasses: Type.Array(AvailableClassSchema),
  }),
);

export type SearchTripsQuery = Static<typeof SearchTripsQuerySchema>;
export type SearchTripsResponse = Static<typeof SearchTripsResponseSchema>;

// ─── 2. TRIP AVAILABILITY ────────────────────────────────────────────────────

export const TripAvailQuerySchema = Type.Object({
  originCode: STATION_CODE,
  destinationCode: STATION_CODE,
});

export const TripAvailResponseSchema = Type.Object({
  tripId: UUID,
  originStopIndex: Type.Integer({ minimum: 0 }),
  destinationStopIndex: Type.Integer({ minimum: 0 }),
  availableClasses: Type.Array(AvailableClassSchema),
});

export type TripAvailQuery = Static<typeof TripAvailQuerySchema>;
export type TripAvailResponse = Static<typeof TripAvailResponseSchema>;

// ─── 3. CREATE SEAT HOLD ─────────────────────────────────────────────────────

export const CreateHoldRequestSchema = Type.Object({
  tripId: UUID,
  classType: Type.String(),
  originCode: STATION_CODE,
  destinationCode: STATION_CODE,
});

export const CreateHoldResponseSchema = Type.Object({
  holdId: UUID,
  tripId: UUID,
  seatId: UUID,
  seatNumber: Type.Integer({ minimum: 1 }),
  coachCode: Type.String(),
  classType: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
  segmentRange: Type.Object({
    startStopIndex: Type.Integer({ minimum: 0 }),
    endStopIndex: Type.Integer({ minimum: 1 }),
  }),
});

export type CreateHoldRequest = Static<typeof CreateHoldRequestSchema>;
export type CreateHoldResponse = Static<typeof CreateHoldResponseSchema>;

// ─── 4. CREATE BOOKING / CHECKOUT ────────────────────────────────────────────

export const PassengerInputSchema = Type.Object({
  fullName: Type.String({ minLength: 2, maxLength: 120 }),
  age: Type.Integer({ minimum: 1, maximum: 120 }),
  gender: Type.Union([
    Type.Literal("M"),
    Type.Literal("F"),
    Type.Literal("O"),
  ]),
});

export const CreateBookingRequestSchema = Type.Object({
  holdId: UUID,
  passengers: Type.Array(PassengerInputSchema, { minItems: 1, maxItems: 6 }),
});

export const CreateBookingResponseSchema = Type.Object({
  bookingId: UUID,
  bookingReference: Type.String(),
  status: Type.String(),
  tripId: UUID,
  seatNumber: Type.Integer(),
  coachCode: Type.String(),
  classType: Type.String(),
  fareMinor: Type.Integer({ minimum: 0 }),
  createdAt: Type.String({ format: "date-time" }),
});

export type CreateBookingRequest = Static<typeof CreateBookingRequestSchema>;
export type CreateBookingResponse = Static<typeof CreateBookingResponseSchema>;

// ─── 5. PAYMENT WEBHOOK ──────────────────────────────────────────────────────

export const PaymentWebhookRequestSchema = Type.Object({
  eventId: UUID,
  eventType: Type.Union([
    Type.Literal("PAYMENT_SUCCESS"),
    Type.Literal("PAYMENT_FAILED"),
  ]),
  paymentReference: Type.String(),
  bookingId: UUID,
  amount: Type.Integer({ minimum: 0 }),
  currency: Type.String({ default: "INR" }),
  signature: Type.String(),
});

export const PaymentWebhookResponseSchema = Type.Object({
  received: Type.Boolean(),
  status: Type.String(),
});

export type PaymentWebhookRequest = Static<typeof PaymentWebhookRequestSchema>;
export type PaymentWebhookResponse = Static<typeof PaymentWebhookResponseSchema>;
