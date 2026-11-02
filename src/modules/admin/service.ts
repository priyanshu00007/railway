import { prisma } from "../../db.js";
import { apiError } from "../../common/errors.js";
import { expireStaleHolds } from "../inventory/service.js";

export type CreateTripInput = {
  trainId: string;
  serviceDate: string; // YYYY-MM-DD
  stops: Array<{ code: string; arrivalTime: string | null; departureTime: string }>;
};

export async function createTrip(input: CreateTripInput) {
  if (input.stops.length < 2) {
    throw apiError("VALIDATION_ERROR", "trip needs at least two stops");
  }
  const serviceDate = new Date(`${input.serviceDate}T00:00:00.000Z`);
  if (Number.isNaN(serviceDate.getTime())) throw apiError("VALIDATION_ERROR", "invalid serviceDate");

  const train = await prisma.train.findUnique({ where: { id: input.trainId }, include: { coaches: { include: { seats: true } } } });
  if (!train) throw apiError("NOT_FOUND", "train not found");
  if (train.status !== "ACTIVE") throw apiError("INVALID_STATE_TRANSITION", "train is not active");

  const stations = await prisma.station.findMany({
    where: { code: { in: input.stops.map((s) => s.code) } },
  });
  const byCode = new Map(stations.map((s) => [s.code, s]));
  for (const stop of input.stops) {
    if (!byCode.has(stop.code)) throw apiError("VALIDATION_ERROR", `unknown station ${stop.code}`);
  }

  const trip = await prisma.trip.create({
    data: {
      trainId: input.trainId,
      serviceDate,
      status: "SCHEDULED",
      stops: {
        create: input.stops.map((stop, stopIndex) => ({
          stationId: byCode.get(stop.code)!.id,
          stopIndex,
          arrivalAt: stop.arrivalTime ? new Date(stop.arrivalTime) : null,
          departureAt: new Date(stop.departureTime),
        })),
      },
      tripSeats: {
        create: train.coaches.flatMap((coach) =>
          coach.seats.map((seat) => ({
            seatId: seat.id,
            coachNo: coach.coachNo,
            seatNo: seat.seatNo,
            class: coach.class,
          })),
        ),
      },
    },
  });

  await prisma.auditLog.create({
    data: { action: "TRIP_CREATED", target: trip.id, payload: { trainNumber: train.number, serviceDate: input.serviceDate } },
  });

  const seatCount = await prisma.tripSeat.count({ where: { tripId: trip.id } });
  return { tripId: trip.id, trainNumber: train.number, serviceDate: input.serviceDate, seatCount: seatCount };
}

export type ReconcileReport = {
  expiredHolds: number;
  unprocessedOutboxEvents: number;
  orphanedSuccessfulPayments: number;
  refundsIssued: number;
};

/** Operational reconciliation: expire holds, inspect outbox, refund stuck payments. */
export async function reconcile(): Promise<ReconcileReport> {
  // 1. Expire stale holds (idempotent, race-safe with confirmation).
  const expiredHolds = await expireStaleHolds();

  // 2. Report outbox lag (processing itself belongs to a worker process).
  const unprocessedOutboxEvents = await prisma.outboxEvent.count({ where: { processedAt: null } });

  // 3. Payments SUCCEEDED but never attached to a booking (webhook loss on
  //    confirm or conflicting confirm) get a refund ledger entry, never 'completed'.
  const stuck = await prisma.payment.findMany({
    where: { status: "SUCCEEDED", bookingId: null },
    include: { refunds: true },
  });
  let refundsIssued = 0;
  for (const p of stuck) {
    if (p.refunds.length > 0) continue;
    await prisma.refund.create({
      data: { paymentId: p.id, amountMinor: p.amountMinor, status: "PENDING", reason: "reconciliation auto-refund" },
    });
    await prisma.outboxEvent.create({
      data: { eventType: "RECONCILE_AUTO_REFUND", payload: { paymentId: p.id } },
    });
    refundsIssued += 1;
  }

  return { expiredHolds, unprocessedOutboxEvents, orphanedSuccessfulPayments: stuck.length, refundsIssued };
}
