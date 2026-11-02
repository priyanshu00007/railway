import { prisma } from "../../db.js";
import { apiError } from "../../common/errors.js";
import { cancellationFeeMinor } from "../../common/pricing.js";
import { sanitizeText } from "../../common/sanitize.js";
import { inc } from "../../metrics.js";

// ─── Finalize (HOLD → CONFIRMED), race-safe with expiry ──────────────────────

export type FinalizeParams = {
  userId: string;
  holdId: string;
  paymentReference: string;
  passengers: Array<{ fullName: string; age: number; gender: "M" | "F" | "O" }>;
};

export async function finalizeBooking(params: FinalizeParams) {
  return prisma.$transaction(
    async (tx) => {
      // 1. Lock the hold row FOR UPDATE so expiry sweeps and confirms serialize.
      const holds = await tx.$queryRaw<Array<{
        id: string; userId: string; status: string; tripId: string; expiresAt: Date;
      }>>`
        SELECT id, "userId", status, "tripId", "expiresAt"
        FROM seat_holds WHERE id = ${params.holdId} FOR UPDATE`;
      const hold = holds[0];
      if (!hold || hold.userId !== params.userId) throw apiError("NOT_FOUND", "hold not found");
      if (hold.status === "EXPIRED") throw apiError("HOLD_EXPIRED", "hold expired");
      if (hold.status !== "ACTIVE") throw apiError("INVALID_STATE_TRANSITION", `hold is ${hold.status}`);
      if (hold.expiresAt <= new Date()) throw apiError("HOLD_EXPIRED", "hold expired");

      // 2. Payment verified: provider evidence with matching reference, SUCCEEDED,
      //    and not already attached to another booking.
      const payment = await tx.payment.findFirst({
        where: { holdId: hold.id, providerReference: params.paymentReference, status: "SUCCEEDED" },
      });
      if (!payment) throw apiError("PAYMENT_UNSUCCESSFUL", "no successful payment matching the reference");
      if (payment.bookingId) throw apiError("CONFLICT", "payment already linked to a booking");

      // 3. Hold → CONSUMED, allocation lives on in the confirmed booking.
      const updated = await tx.$executeRaw`
        UPDATE seat_holds SET status = 'CONSUMED' WHERE id = ${hold.id} AND status = 'ACTIVE'`;
      if (updated !== 1) throw apiError("CONFLICT", "hold lost during confirmation");

      const segments = await tx.seatSegmentHold.findMany({ where: { holdId: hold.id } });
      const tripSeatIds = segments.map((s) => s.tripSeatId);
      const tripSeats = await tx.tripSeat.findMany({ where: { id: { in: tripSeatIds } } });
      const segment = segments[0];
      const tripSeat = tripSeats.find((ts) => segment && ts.id === segment.tripSeatId);
      if (!segment || !tripSeat) throw apiError("INVALID_STATE_TRANSITION", "hold has no allocation");

      const bookingReference = nextPnr();
      const booking = await tx.booking.create({
        data: {
          bookingReference,
          userId: params.userId,
          status: "CONFIRMED",
          fareSnapshotMinor: payment.amountMinor,
          holdId: hold.id,
          passengers: {
            create: params.passengers.map((p) => ({
              fullName: sanitizeText(p.fullName),
              age: p.age,
              gender: p.gender,
              seatLabel: `${tripSeat.coachNo}-${tripSeat.seatNo}`,
            })),
          },
        },
        include: { passengers: true },
      });

      await tx.payment.update({ where: { id: payment.id }, data: { bookingId: booking.id } });
      await tx.auditLog.create({
        data: {
          actorId: params.userId,
          action: "BOOKING_CONFIRMED",
          target: booking.id,
          payload: { pnr: bookingReference, holdId: hold.id, fareMinor: payment.amountMinor },
        },
      });
      await tx.outboxEvent.create({
        data: {
          eventType: "BOOKING_CONFIRMED",
          payload: {
            bookingId: booking.id,
            bookingReference,
            tripId: hold.tripId,
            seat: `${tripSeat.coachNo}-${tripSeat.seatNo}`,
            range: [segment.fromIndex, segment.toIndex],
          },
        },
      });

      inc("railbook_bookings_confirmed_total");
      return {
        bookingId: booking.id,
        pnr: bookingReference,
        status: booking.status,
        tripId: hold.tripId,
        coach: tripSeat.coachNo,
        seatNumber: tripSeat.seatNo,
        classType: tripSeat.class,
        fareMinor: payment.amountMinor,
        journey: { fromIndex: segment.fromIndex, toIndex: segment.toIndex },
        createdAt: booking.createdAt.toISOString(),
      };
    },
    { isolationLevel: "ReadCommitted" },
  );
}

function nextPnr(): string {
  // Retainable PNR-style reference: 2 letters + 8 digits (random, uniqueness enforced).
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const l1 = letters[Math.floor(Math.random() * letters.length)];
  const l2 = letters[Math.floor(Math.random() * letters.length)];
  const digits = String(Math.floor(10_000_000 + Math.random() * 89_999_999));
  return `PNR-${l1}${l2}${digits}`;
}

// ─── Retrieval (ownership enforced) ─────────────────────────────────────────

export async function getBooking(bookingId: string, userId: string) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { passengers: true, payments: true, hold: { include: { segments: true } } },
  });
  if (!booking || booking.userId !== userId) throw apiError("NOT_FOUND", "booking not found");
  return booking;
}

/** Cursor-paginated listing: ?limit (1-50, default 20) & ?cursor (booking id of last item). */
export async function listMyBookings(userId: string, limitRaw: string | undefined, cursorRaw: string | undefined) {
  const limit = Math.min(50, Math.max(1, Number(limitRaw) || 20));
  const cursor = typeof cursorRaw === "string" && cursorRaw.length > 8 ? cursorRaw : undefined;
  const rows = await prisma.booking.findMany({
    where: cursor ? { userId, id: { lt: cursor } } : { userId },
    orderBy: { id: "desc" },
    take: limit,
    include: { passengers: true, payments: { select: { id: true, status: true, amountMinor: true, currency: true } } },
  });
  return {
    items: rows,
    nextCursor: rows.length === limit ? rows[rows.length - 1]?.id ?? null : null,
  };
}

// ─── Cancellation: reclaim segment, then record refund ──────────────────────

export async function cancelBooking(bookingId: string, userId: string) {
  return prisma.$transaction(
    async (tx) => {
      const holds = await tx.$queryRaw<Array<{ id: string; holdId: string | null; fareMinor: number }>>`
        SELECT id, "holdId", "fareSnapshotMinor" AS "fareMinor"
        FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
      const row = holds[0];
      if (!row) throw apiError("NOT_FOUND", "booking not found");

      const booking = await tx.booking.findUniqueOrThrow({ where: { id: row.id }, include: { payments: true } });
      if (booking.userId !== userId) throw apiError("NOT_FOUND", "booking not found");
      if (booking.status === "CANCELLED") {
        // Retried cancellation is idempotent: return the existing outcome.
        const existing = await tx.refund.findFirst({ where: { payment: { id: (booking.payments[0]?.id ?? "") } } });
        const fee = booking.fareSnapshotMinor - (existing?.amountMinor ?? 0);
        return ok(row.id, existing?.amountMinor ?? 0, fee);
      }
      if (booking.status !== "CONFIRMED") {
        throw apiError("INVALID_STATE_TRANSITION", `cannot cancel booking in ${booking.status}`);
      }

      const cancelled = await tx.$executeRaw`
        UPDATE bookings SET status = 'CANCELLED', "cancelledAt" = NOW()
        WHERE id = ${row.id} AND status = 'CONFIRMED'`;
      if (cancelled !== 1) throw apiError("CONFLICT", "booking lost during cancellation");

      // Free the seat range immediately.
      if (booking.holdId) {
        await tx.seatSegmentHold.deleteMany({ where: { holdId: booking.holdId } });
        await tx.seatHold.update({
          where: { id: booking.holdId },
          data: { status: "RELEASED", releasedAt: new Date() },
        });
      }

      const payment = booking.payments[0];
      const fare = booking.fareSnapshotMinor;
      const fee = cancellationFeeMinor(fare);
      const refundAmount = Math.max(0, fare - fee);
      if (payment) {
        await tx.refund.create({
          data: { paymentId: payment.id, amountMinor: refundAmount, status: "PENDING", reason: "customer cancellation" },
        });
        await tx.outboxEvent.create({
          data: {
            eventType: "BOOKING_CANCELLED",
            payload: { bookingId: booking.id, refundAmountMinor: refundAmount, feeMinor: fee },
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: "BOOKING_CANCELLED",
          target: booking.id,
          payload: { refundMinor: refundAmount, feeMinor: fee },
        },
      });

      inc("railbook_bookings_cancelled_total");
      return ok(booking.id, refundAmount, fee);
    },
    { isolationLevel: "ReadCommitted" },
  );
}

function ok(bookingId: string, refundAmount: number, cancellationFee: number) {
  return { bookingId, status: "CANCELLED", refundAmount, cancellationFee };
}
