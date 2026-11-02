import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import * as svc from "./service.js";
import { requireAdmin } from "../auth/routes.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/v1/admin/trips",
    {
      onRequest: [async (req) => void requireAdmin(req)],
      schema: {
        body: Type.Object({
          trainId: Type.String(),
          serviceDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          stops: Type.Array(
            Type.Object({
              code: Type.String({ minLength: 2, maxLength: 10 }),
              arrivalTime: Type.Union([Type.Null(), Type.String({ format: "date-time" })]),
              departureTime: Type.String({ format: "date-time" }),
            }),
            { minItems: 2 },
          ),
        }),
        response: { 201: Type.Any() },
      },
    },
    async (req, reply) => {
      const result = await svc.createTrip(req.body as svc.CreateTripInput);
      reply.code(201);
      return result;
    },
  );

  app.post(
    "/api/v1/admin/reconcile",
    { onRequest: [async (req) => void requireAdmin(req)] },
    async () => svc.reconcile(),
  );
}
