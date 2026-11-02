import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import * as svc from "./service.js";
import { requireAuth } from "../auth/routes.js";

const PassengersSchema = Type.Array(
  Type.Object({
    fullName: Type.String({ minLength: 2, maxLength: 120 }),
    age: Type.Integer({ minimum: 1, maximum: 120 }),
    gender: Type.Union([Type.Literal("M"), Type.Literal("F"), Type.Literal("O")]),
  }),
  { minItems: 1, maxItems: 6 },
);

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/bookings",
    {
      onRequest: [async (req) => void requireAuth(req)],
      schema: {
        body: Type.Object({
          holdId: Type.String(),
          paymentReference: Type.String(),
          passengers: PassengersSchema,
        }),
        response: { 201: Type.Any() },
      },
    },
    async (req, reply) => {
      // Ownership comes from the token, never the body.
      const body = req.body as { holdId: string; paymentReference: string; passengers: svc.FinalizeParams["passengers"] };
      const result = await svc.finalizeBooking({
        userId: req.user!.id,
        holdId: body.holdId,
        paymentReference: body.paymentReference,
        passengers: body.passengers,
      });
      reply.code(201);
      return result;
    },
  );

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/api/v1/bookings",
    {
      schema: { querystring: Type.Object({ limit: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) }) },
      onRequest: [async (req) => void requireAuth(req)],
    },
    async (req) => {
      const q = req.query as { limit?: string; cursor?: string };
      return svc.listMyBookings(req.user!.id, q.limit, q.cursor);
    },
  );

  app.get<{ Params: { bookingId: string } }>(
    "/api/v1/bookings/:bookingId",
    { onRequest: [async (req) => void requireAuth(req)] },
    async (req) => svc.getBooking(req.params.bookingId, req.user!.id),
  );

  app.post<{ Params: { bookingId: string } }>(
    "/api/v1/bookings/:bookingId/cancel",
    { onRequest: [async (req) => void requireAuth(req)] },
    async (req) => svc.cancelBooking(req.params.bookingId, req.user!.id),
  );
}
