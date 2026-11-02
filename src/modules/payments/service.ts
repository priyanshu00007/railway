import { prisma } from "../../db.js";
import { env } from "../../config.js";
import { apiError } from "../../common/errors.js";
import { hmacSignature } from "../../common/tokens.js";
import { inc } from "../../metrics.js";
import { fareMinor, isClass, type TravelClassName } from "../../common/pricing.js";

// Simulated payment provider. No real network calls; the webhook signature is
// HMAC-SHA256 over the canonical string `${eventId}|${paymentReference}|${amount}|${eventType}`
// using PAYMENT_WEBHOOK_SECRET. клиентов never send amounts — server derives them.

export type PaymentIntent = {
  paymentId: string;
  holdId: string;
  bookingId: string | null;
  amountMinor: number;
  currency: string;
  clientSecret: string;
  status: string;
};

export async function createIntent(idempotencyKey: string, holdId: string, userId: string): Promise<PaymentIntent> {
  return prisma.$transaction(async (tx) => {
    const hold = await tx.seatHold.findUnique({ where: { id: holdId } });
    if (!hold || hold.userId !== userId) throw apiError("NOT_FOUND", "hold not found");
    if (hold.status !== "ACTIVE" || hold.expiresAt <= new Date()) {
      throw apiError("HOLD_EXPIRED", "hold is not active");
    }

    const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
    if (existing) {
      // Same key = same intent; retry returns the stored record.
      if (existing.holdId !== holdId) throw apiError("IDEMPOTENCY_KEY_REUSED", "key used for another hold");
      return toIntent(existing);
    }

    const segments = await tx.seatSegmentHold.findMany({ where: { holdId } });
    const seg = segments[0];
    if (!seg) throw apiError("INVALID_STATE_TRANSITION", "hold has no allocation");

    const tripSeat = await tx.tripSeat.findUniqueOrThrow({ where: { id: segments[0]!.tripSeatId } });
    const amountMinor = seg.toIndex - seg.fromIndex >= 1
      ? fareFor(tripSeat.class, seg.fromIndex, seg.toIndex)
      : 0;

    const clientSecret = `sim_${crypto.randomUUID()}`;
    const payment = await tx.payment.create({
      data: {
        holdId,
        amountMinor,
        currency: "INR",
        status: "PENDING",
        clientSecret,
        idempotencyKey,
      },
    });
    return toIntent(payment);
  });
}

// Fare comes from pricing policy, not the client.
function fareFor(classType: string, from: number, to: number): number {
  if (!isClass(classType)) throw apiError("VALIDATION_ERROR", "unknown classType");
  return fareMinor(classType as TravelClassName, from, to);
}

function toIntent(row: {
  id: string; holdId: string | null; bookingId: string | null; amountMinor: number; currency: string; clientSecret: string; status: string;
}): PaymentIntent {
  if (row.holdId === null) throw apiError("INTERNAL_ERROR", "payment missing hold link");
  return {
    paymentId: row.id,
    holdId: row.holdId,
    bookingId: row.bookingId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    clientSecret: row.clientSecret,
    status: row.status,
  };
}

export type WebhookEvent = {
  eventId: string;
  eventType: "PAYMENT_SUCCESS" | "PAYMENT_FAILED";
  paymentReference: string;
  holdId: string;
  amountMinor: number;
  currency: string;
  signature: string;
};

export function canonicalString(e: Omit<WebhookEvent, "signature">): string {
  return `${e.eventId}|${e.paymentReference}|${e.amountMinor}|${e.eventType}`;
}

/** Verifies signature, dedupes events by eventId, records the outcome. Idempotent. */
export async function processWebhook(event: WebhookEvent): Promise<{ received: boolean; status: string }> {
  const expected = hmacSignature(canonicalString(event), env.PAYMENT_WEBHOOK_SECRET);
  const a = Buffer.from(event.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !a.equals(b)) {
    throw apiError("UNAUTHORIZED", "invalid webhook signature");
  }

  const succeeded = event.eventType === "PAYMENT_SUCCESS";
  // providerReference is unique → provider event dedupe at the DB level.
  const payment = await prisma.payment.findFirst({ where: { holdId: event.holdId, status: "PENDING" } });
  if (!payment) {
    const done = await prisma.payment.findFirst({
      where: { holdId: event.holdId, status: succeeded ? "SUCCEEDED" : "FAILED" },
    });
    if (done) {
      inc("railbook_webhook_duplicate_total");
      return { received: true, status: "duplicate_ignored" };
    }
    throw apiError("NOT_FOUND", "no pending payment for this hold");
  }
  if (done(payment, event)) {
    return { received: true, status: "duplicate_ignored" };
  }

  try {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: succeeded ? "SUCCEEDED" : "FAILED",
        providerReference: event.paymentReference,
      },
    });
    await prisma.outboxEvent.create({
      data: {
        eventType: succeeded ? "PAYMENT_SUCCEEDED" : "PAYMENT_FAILED",
        payload: { paymentId: payment.id, holdId: event.holdId, amountMinor: event.amountMinor },
      },
    });
    return { received: true, status: succeeded ? "accepted" : "captured_failure" };
  } catch (e) {
    if (String(e).includes("Unique constraint")) {
      inc("railbook_webhook_duplicate_total");
      return { received: true, status: "duplicate_ignored" };
    }
    throw e;
  }
}

function done(payment: unknown, event: unknown): boolean {
  // providerReference already recorded → replayed callback
  const p = payment as { providerReference?: string | null };
  const ev = event as { paymentReference: string };
  return p.providerReference === ev.paymentReference;
}
