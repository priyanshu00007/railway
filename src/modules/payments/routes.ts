import { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import * as svc from "./service.js";
import { requireAuth } from "../auth/routes.js";

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Headers: Record<string, string | undefined> }>(
    "/api/v1/payments/create-intent",
    {
      onRequest: [async (req) => void requireAuth(req)],
      schema: {
        body: Type.Object({ holdId: Type.String() }),
        response: { 201: Type.Any() },
      },
    },
    async (req, reply) => {
      // Server derives amount from the hold's fare snapshot — never from the body.
      const { holdId } = req.body as { holdId: string };
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
        return reply.code(400).send({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "Idempotency-Key header required",
          requestId: req.id,
        });
      }
      const intent = await svc.createIntent(idempotencyKey, holdId, req.user!.id);
      reply.code(201);
      return intent;
    },
  );

  // Webhook Fastify parses body; signature covers the canonical string fields,
  // so JSON re-serialization differences cannot break verification.
  app.post(
    "/api/v1/webhooks/payments",
    {
      schema: {
        body: Type.Object({
          eventId: Type.String(),
          eventType: Type.Union([Type.Literal("PAYMENT_SUCCESS"), Type.Literal("PAYMENT_FAILED")]),
          paymentReference: Type.String(),
          holdId: Type.String(),
          amount: Type.Integer({ minimum: 0 }),
          currency: Type.Optional(Type.String()),
          signature: Type.String(),
        }),
        response: { 200: Type.Any() },
      },
    },
    async (req) => {
      const body = req.body as {
        eventId: string; eventType: "PAYMENT_SUCCESS" | "PAYMENT_FAILED";
        paymentReference: string; holdId: string; amount: number; signature: string;
      };
      return svc.processWebhook({
        eventId: body.eventId,
        eventType: body.eventType,
        paymentReference: body.paymentReference,
        holdId: body.holdId,
        amountMinor: body.amount,
        currency: "INR",
        signature: body.signature,
      });
    },
  );
}
