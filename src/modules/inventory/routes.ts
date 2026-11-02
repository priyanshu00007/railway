import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import * as svc from "./service.js";
import { requireAuth } from "../auth/routes.js";

export const IdempotencyHeader = Type.Object({
  "idempotency-key": Type.Optional(Type.String({ })),
});

export const HoldRequestSchema = Type.Object({
  tripId: Type.String({ }),
  classType: Type.String(),
  originCode: Type.String({ minLength: 2, maxLength: 10 }),
  destinationCode: Type.String({ minLength: 2, maxLength: 10 }),
  ttlSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600 })),
  preferredCoach: Type.Optional(Type.String({ minLength: 1, maxLength: 8 })),
  preferredSeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
});

export const HoldResponseSchema = Type.Object({
  holdId: Type.String(),
  tripId: Type.String(),
  seatId: Type.String(),
  seatNumber: Type.Integer(),
  coachCode: Type.String(),
  classType: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
  segmentRange: Type.Object({
    startStopIndex: Type.Integer(),
    endStopIndex: Type.Integer(),
  }),
  fareMinor: Type.Integer(),
});

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  // ── Discovery (read-only, no locks) ─────────────────────────────────────
  app.get<{ Querystring: { from: string; to: string; date: string } }>(
    "/api/v1/trips/search",
    {
      schema: {
        querystring: Type.Object({
          from: Type.String({ minLength: 2, maxLength: 10 }),
          to: Type.String({ minLength: 2, maxLength: 10 }),
          date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
        }),
        response: { 200: Type.Array(Type.Any()) },
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (req) => {
      const { from, to, date } = req.query;
      return svc.searchTrips(from, to, date);
    },
  );

  // Journey tracking — where the train is now and when it reaches each stop.
  app.get<{ Params: { tripId: string } }>(
    "/api/v1/trips/:tripId/progress",
    { schema: { response: { 200: Type.Any() } } },
    async (req) => svc.tripProgress(req.params.tripId),
  );

  app.get<{ Params: { tripId: string }; Querystring: { originCode: string; destinationCode: string } }>(
    "/api/v1/trips/:tripId/availability",
    {
      schema: {
        querystring: Type.Object({
          originCode: Type.String({ minLength: 2, maxLength: 10 }),
          destinationCode: Type.String({ minLength: 2, maxLength: 10 }),
        }),
        response: { 200: Type.Any() },
      },
    },
    async (req) => {
      return svc.tripAvailability(req.params.tripId, req.query.originCode, req.query.destinationCode);
    },
  );

  app.get(
    "/api/v1/stations",
    { schema: { response: { 200: Type.Array(Type.Any()) } } },
    async () => svc.listStations(),
  );

  // ── Atomic reservation ──────────────────────────────────────────────────
  app.post<{ Headers: Record<string, string | undefined> }>(
    "/api/v1/holds",
    {
      schema: { body: HoldRequestSchema, response: { 201: HoldResponseSchema } },
      onRequest: [async (req) => void requireAuth(req)],
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const user = req.user!;
      const body = req.body as { tripId: string; classType: string; originCode: string; destinationCode: string; ttlSeconds?: number; preferredCoach?: string; preferredSeat?: number };
      const result = await svc.acquireSeatHold({ userId: user.id, ...body });
      reply.code(201);
      return result;
    },
  );

  app.get<{ Params: { holdId: string } }>(
    "/api/v1/holds/:holdId",
    { onRequest: [async (req) => void requireAuth(req)] },
    async (req) => svc.getHold(req.params.holdId, req.user!.id),
  );

  app.delete<{ Params: { holdId: string } }>(
    "/api/v1/holds/:holdId",
    { onRequest: [async (req) => void requireAuth(req)] },
    async (req, reply) => {
      await svc.releaseHold(req.params.holdId, req.user!.id);
      reply.code(204);
      return null;
    },
  );
}
