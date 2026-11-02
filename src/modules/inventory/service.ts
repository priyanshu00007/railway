import { prisma } from "../../db.js";
import { apiError } from "../../common/errors.js";
import { fareMinor, isClass, classNames, type TravelClassName } from "../../common/pricing.js";
import { inc, observeLockAcquisition } from "../../metrics.js";

const HOLD_TTL_SECONDS_DEFAULT = 600; // 10 minutes

// ─── Discovery ───────────────────────────────────────────────────────────────

export async function listStations(): Promise<Array<{ code: string; name: string; timezone: string }>> {
  const stations = await prisma.station.findMany({ orderBy: { code: "asc" }, select: { code: true, name: true, timezone: true } });
  return stations;
}

export type TripSearchRow = {
  tripId: string;
  trainNumber: string;
  trainName: string;
  originStation: string;
  destinationStation: string;
  departureTime: string;
  arrivalTime: string;
  originStopIndex: number;
  destinationStopIndex: number;
  /** Every stop of the trip in order — lets clients display the full timetable. */
  route: Array<{ code: string; name: string; stopIndex: number; arrivalTime: string | null; departureTime: string | null }>;
  classes: Array<{ classType: string; availableSeats: number; baseFare: number }>;
};

export async function searchTrips(from: string, to: string, date: string): Promise<TripSearchRow[]> {
  const serviceDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(serviceDate.getTime())) throw apiError("VALIDATION_ERROR", "invalid date");

  // One pass: trips visiting both stations in the right order on that date.
  const trips = await prisma.trip.findMany({
    where: { serviceDate, status: "SCHEDULED" },
    include: {
      train: true,
      stops: { orderBy: { stopIndex: "asc" }, include: { station: true } },
      tripSeats: true,
    },
  });

  const fromUUID = await prisma.station.findUnique({ where: { code: from.toUpperCase() } });
  const toUUID = await prisma.station.findUnique({ where: { code: to.toUpperCase() } });
  if (!fromUUID || !toUUID) return [];

  const rows: TripSearchRow[] = [];
  for (const trip of trips) {
    const stopsByIndex = new Map(trip.stops.map((s) => [s.stopIndex, s]));
    const fromStop = trip.stops.find((s) => s.stationId === fromUUID.id);
    const toStop = trip.stops.find((s) => s.stationId === toUUID.id);
    if (!fromStop || !toStop || fromStop.stopIndex >= toStop.stopIndex) continue;

    const originDeparture = stopsByIndex.get(fromStop.stopIndex)?.departureAt;
    const destinationArrival = stopsByIndex.get(toStop.stopIndex)?.arrivalAt ?? stopsByIndex.get(toStop.stopIndex)?.departureAt;
    if (!originDeparture || !destinationArrival) continue;

    // Snapshot availability per class over [fromIndex, toIndex) — no locks taken.
    const classes: TripSearchRow["classes"] = [];
    for (const className of classNames()) {
      const seats = trip.tripSeats.filter((ts) => ts.class === className);
      const allocatedSeats = seats.length === 0
        ? 0
        : await countOverlappingAllocations(trip.id, className, fromStop.stopIndex, toStop.stopIndex);
      classes.push({
        classType: className,
        availableSeats: Math.max(0, seats.length - allocatedSeats),
        baseFare: fareMinor(className as TravelClassName, fromStop.stopIndex, toStop.stopIndex),
      });
    }

    rows.push({
      tripId: trip.id,
      trainNumber: trip.train.number,
      trainName: trip.train.name,
      originStation: from,
      destinationStation: to,
      departureTime: originDeparture.toISOString(),
      arrivalTime: destinationArrival.toISOString(),
      originStopIndex: fromStop.stopIndex,
      destinationStopIndex: toStop.stopIndex,
      route: trip.stops.map((s) => ({
        code: s.station.code,
        name: s.station.name,
        stopIndex: s.stopIndex,
        arrivalTime: s.arrivalAt ? s.arrivalAt.toISOString() : null,
        departureTime: s.departureAt ? s.departureAt.toISOString() : null,
      })),
      classes,
    });
  }
  return rows.sort((a, b) => a.departureTime.localeCompare(b.departureTime));
}

// Count seats of the requested class with ANY live allocation overlapping [o, d).
// Live = allocation whose hold is ACTIVE and unexpired, or CONSUMED (confirmed).
async function countOverlappingAllocations(tripId: string, classType: string, o: number, d: number): Promise<number> {
  const result = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT COUNT(DISTINCT ssh_all."tripSeatId") c
    FROM seat_holds sh
    JOIN seat_segment_holds ssh_all ON ssh_all."holdId" = sh.id
    JOIN trip_seats ts_f ON ts_f.id = ssh_all."tripSeatId"
    WHERE sh."tripId" = ${tripId}
      AND ts_f.class::text = ${classType}
      AND (sh.status = 'CONSUMED' OR (sh.status = 'ACTIVE' AND sh."expiresAt" > NOW()))
      AND int4range(ssh_all."fromIndex", ssh_all."toIndex", '[)') && int4range(${o}::int, ${d}::int, '[)')`;
  return Number(result[0]?.c ?? 0);
}

// ─── Journey tracking (timetable-derived, synthetic) ────────────────────────

export type TripProgress = {
  tripId: string;
  trainNumber: string;
  status: string;
  /** Between first departure and last arrival, we assume on-time running. */
  running: boolean;
  currentSegment: { fromStopIndex: number; toStopIndex: number; fromCode: string; toCode: string } | null;
  nextStop: { code: string; name: string; stopIndex: number; scheduledArrival: string | null } | null;
  stops: Array<{
    code: string; name: string; stopIndex: number;
    scheduledArrival: string | null; scheduledDeparture: string | null;
    /** departed | at_stop | upcoming — derived from server clock vs timetable. */
    milestone: "departed" | "at_stop" | "upcoming";
  }>;
};

export async function tripProgress(tripId: string): Promise<TripProgress> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { train: true, stops: { orderBy: { stopIndex: "asc" }, include: { station: true } } },
  });
  if (!trip) throw apiError("NOT_FOUND", "trip not found");

  const now = Date.now();
  const firstDeparture = trip.stops[0]?.departureAt?.getTime();
  const lastStop = trip.stops[trip.stops.length - 1];
  const lastArrival = (lastStop?.arrivalAt ?? lastStop?.departureAt)?.getTime();
  const running =
    trip.status === "SCHEDULED" &&
    firstDeparture !== undefined && lastArrival !== undefined &&
    now >= firstDeparture + 60_000 && now <= lastArrival;

  const stops: TripProgress["stops"] = trip.stops.map((s) => {
    const arrival = s.arrivalAt?.getTime();
    const departure = s.departureAt?.getTime();
    const departed = departure !== undefined && departure + 60_000 <= now;
    const atStop = !departed && arrival !== undefined && arrival <= now;
    return {
      code: s.station.code,
      name: s.station.name,
      stopIndex: s.stopIndex,
      scheduledArrival: s.arrivalAt ? s.arrivalAt.toISOString() : null,
      scheduledDeparture: s.departureAt ? s.departureAt.toISOString() : null,
      milestone: departed ? "departed" : atStop ? "at_stop" : "upcoming",
    };
  });

  const departedCount = stops.filter((s) => s.milestone === "departed").length;
  const atStopIdx = stops.findIndex((s) => s.milestone === "at_stop");
  const prev = atStopIdx >= 0 ? trip.stops[atStopIdx] : trip.stops[departedCount - 1];
  const next = stops.find((s) => s.milestone === "upcoming") ?? null;
  const nextStopRow = next && next.stopIndex < trip.stops.length ? trip.stops[next.stopIndex] : null;
  const prevStopRow = prev ?? null;

  return {
    tripId,
    trainNumber: trip.train.number,
    status: trip.status,
    running,
    currentSegment: running && prevStopRow && nextStopRow
      ? { fromStopIndex: prevStopRow.stopIndex, toStopIndex: nextStopRow.stopIndex, fromCode: prevStopRow.station.code, toCode: nextStopRow.station.code }
      : null,
    nextStop: nextStopRow
      ? {
          code: nextStopRow.station.code,
          name: nextStopRow.station.name,
          stopIndex: nextStopRow.stopIndex,
          scheduledArrival: nextStopRow.arrivalAt ? nextStopRow.arrivalAt.toISOString() : null,
        }
      : null,
    stops,
  };
}

// ─── Availability detail ─────────────────────────────────────────────────────

export type AvailabilityResult = {
  tripId: string;
  originStopIndex: number;
  destinationStopIndex: number;
  classes: Array<{ classType: string; availableSeats: number; baseFare: number }>;
  seatMap: Array<{ seatId: string; coachCode: string; seatNumber: number; classType: string; state: "FREE" | "HELD" | "OCCUPIED" }>;
};

export async function tripAvailability(tripId: string, from: string, to: string): Promise<AvailabilityResult> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: {
      stops: { include: { station: true } },
      tripSeats: { include: { segments: { include: { hold: true } } } },
    },
  });
  if (!trip) throw apiError("NOT_FOUND", "trip not found");

  const fromStop = trip.stops.find((s) => s.station.code === from.toUpperCase());
  const toStop = trip.stops.find((s) => s.station.code === to.toUpperCase());
  if (!fromStop || !toStop || fromStop.stopIndex >= toStop.stopIndex) {
    throw apiError("VALIDATION_ERROR", "origin and destination must be trip stops in travelling order");
  }

  const seatMap: AvailabilityResult["seatMap"] = seatMapFor(trip.tripSeats, fromStop.stopIndex, toStop.stopIndex);
  const classSummary: AvailabilityResult["classes"] = [];
  for (const className of classNames()) {
    const seats = seatMap.filter((s) => s.classType === className);
    classSummary.push({
      classType: className,
      availableSeats: seats.filter((s) => s.state === "FREE").length,
      baseFare: fareMinor(className as TravelClassName, fromStop.stopIndex, toStop.stopIndex),
    });
  }

  return {
    tripId,
    originStopIndex: fromStop.stopIndex,
    destinationStopIndex: toStop.stopIndex,
    classes: classSummary,
    seatMap,
  };
}

function seatMapFor(
  tripSeats: Array<{
    id: string;
    coachNo: string;
    seatNo: number;
    class: string;
    segments: Array<{ hold: { status: string; expiresAt: Date }; fromIndex: number; toIndex: number }>;
  }>,
  o: number,
  d: number,
): AvailabilityResult["seatMap"] {
  const now = Date.now();
  return tripSeats
    .sort((a, b) => a.seatNo - b.seatNo)
    .map((ts) => {
      const live = ts.segments.filter(
        (seg) =>
          (seg.hold.status === "CONSUMED" || (seg.hold.status === "ACTIVE" && seg.hold.expiresAt.getTime() > now)) &&
          Math.max(o, seg.fromIndex) < Math.min(d, seg.toIndex), // overlap
      );
      const state = live.some((l) => l.hold.status === "CONSUMED")
        ? ("OCCUPIED" as const)
        : live.length > 0
          ? ("HELD" as const)
          : ("FREE" as const);
      return { seatId: ts.id, coachCode: ts.coachNo, seatNumber: ts.seatNo, classType: ts.class, state };
    });
}

// ─── Atomic hold (concurrency core) ──────────────────────────────────────────

export type AcquireHoldParams = {
  userId: string;
  tripId: string;
  classType: string;
  originCode: string;
  destinationCode: string;
  ttlSeconds?: number;
  /** Optional exact seat allotment: coach + seat. Falls back to auto-alloc when unset. */
  preferredCoach?: string;
  preferredSeat?: number;
};

export async function acquireSeatHold(params: AcquireHoldParams) {
  if (!isClass(params.classType)) throw apiError("VALIDATION_ERROR", "unknown classType");

  const trip = await prisma.trip.findUnique({
    where: { id: params.tripId },
    include: { stops: { include: { station: true } } },
  });
  if (!trip) throw apiError("NOT_FOUND", "trip not found");
  if (trip.status !== "SCHEDULED") throw apiError("INVALID_STATE_TRANSITION", "trip not bookable");

  const fromStop = trip.stops.find((s) => s.station.code === params.originCode.toUpperCase());
  const toStop = trip.stops.find((s) => s.station.code === params.destinationCode.toUpperCase());
  if (!fromStop || !toStop) throw apiError("VALIDATION_ERROR", "origin/destination not on trip route");
  if (fromStop.stopIndex >= toStop.stopIndex) throw apiError("VALIDATION_ERROR", "origin must precede destination");

  const ttl = params.ttlSeconds ?? HOLD_TTL_SECONDS_DEFAULT;
  if (ttl < 30 || ttl > 3600) throw apiError("VALIDATION_ERROR", "ttl must be 30-3600 seconds");

  const lockStart = Date.now();
  return prisma.$transaction(
    async (tx) => {
      // 1. Lock candidate seats exclusively, never waiting on peers (SKIP LOCKED).
      //    Deterministic lock order by (coachNo, seatNo) keeps deadlocks away.
      // Exact seat allotment when requested: lock only that one seat row.
      // If it is busy or cannot be locked, leave empty — fall back to auto-assignment.
      const exact = params.preferredCoach && params.preferredSeat
        ? await tx.$queryRaw<Array<{ id: string }>>`
            SELECT ts.id
            FROM trip_seats ts
            WHERE ts."tripId" = ${params.tripId}
              AND ts.class::text = ${params.classType}
              AND ts."coachNo" = ${params.preferredCoach}
              AND ts."seatNo" = ${params.preferredSeat}
              AND NOT EXISTS (
                SELECT 1
                FROM seat_holds sh
                JOIN seat_segment_holds ssh ON ssh."holdId" = sh.id
                WHERE ssh."tripSeatId" = ts.id
                  AND (sh.status = 'CONSUMED' OR (sh.status = 'ACTIVE' AND sh."expiresAt" > NOW()))
                  AND int4range(ssh."fromIndex", ssh."toIndex", '[)')
                      && int4range(${fromStop.stopIndex}::int, ${toStop.stopIndex}::int, '[)')
              )
            ORDER BY ts."coachNo" ASC, ts."seatNo" ASC
            FOR UPDATE OF ts SKIP LOCKED
            LIMIT 1`
        : [];

      const candidates = exact.length === 1
        ? exact
        : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT ts.id
        FROM trip_seats ts
        WHERE ts."tripId" = ${params.tripId}
          AND ts.class::text = ${params.classType}
          AND NOT EXISTS (
            SELECT 1
            FROM seat_holds sh
            JOIN seat_segment_holds ssh ON ssh."holdId" = sh.id
            WHERE ssh."tripSeatId" = ts.id
              AND (sh.status = 'CONSUMED' OR (sh.status = 'ACTIVE' AND sh."expiresAt" > NOW()))
              AND int4range(ssh."fromIndex", ssh."toIndex", '[)')
                  && int4range(${fromStop.stopIndex}::int, ${toStop.stopIndex}::int, '[)')
          )
        ORDER BY ts."coachNo" ASC, ts."seatNo" ASC
        FOR UPDATE OF ts SKIP LOCKED
        LIMIT 1`;

      if (candidates.length === 0) {
        inc("railbook_seat_unavailable_total");
        throw apiError("SEAT_UNAVAILABLE", "no seat available for this segment range");
      }
      const tripSeatId = candidates[0]!.id;

      observeLockAcquisition(Date.now() - lockStart);

      // 2. Create the hold + its single allocation inside the same transaction.
      const expiresAt = new Date(Date.now() + ttl * 1000);
      const seat = await tx.tripSeat.findUniqueOrThrow({ where: { id: tripSeatId } });
      const hold = await tx.seatHold.create({
        data: { userId: params.userId, tripId: params.tripId, status: "ACTIVE", expiresAt },
      });
      await tx.seatSegmentHold.create({
        data: { holdId: hold.id, tripSeatId, fromIndex: fromStop.stopIndex, toIndex: toStop.stopIndex },
      });

      inc("railbook_holds_created_total");
      return {
        holdId: hold.id,
        tripId: params.tripId,
        seatId: tripSeatId,
        seatNumber: seat.seatNo,
        coachCode: seat.coachNo,
        classType: seat.class,
        expiresAt: expiresAt.toISOString(),
        segmentRange: { startStopIndex: fromStop.stopIndex, endStopIndex: toStop.stopIndex },
        fareMinor: fareMinor(seat.class as TravelClassName, fromStop.stopIndex, toStop.stopIndex),
      };
    },
    { isolationLevel: "ReadCommitted" },
  );
}

export async function getHold(holdId: string, userId: string) {
  const hold = await prisma.seatHold.findUnique({ where: { id: holdId }, include: { segments: true } });
  if (!hold || hold.userId !== userId) throw apiError("NOT_FOUND", "hold not found");
  const secondsRemaining = Math.max(0, Math.floor((hold.expiresAt.getTime() - Date.now()) / 1000));
  return {
    holdId: hold.id,
    tripId: hold.tripId,
    status: hold.status,
    secondsRemaining,
    segmentRange: hold.segments[0]
      ? { startStopIndex: hold.segments[0].fromIndex, endStopIndex: hold.segments[0].toIndex }
      : null,
  };
}

/** Voluntary release — idempotent: releasing a released/expired hold is a no-op success. */
export async function releaseHold(holdId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const hold = await tx.seatHold.findUnique({ where: { id: holdId } });
    if (!hold || hold.userId !== userId) throw apiError("NOT_FOUND", "hold not found");
    if (hold.status === "ACTIVE") {
      await tx.seatHold.update({
        where: { id: hold.id },
        data: { status: "RELEASED", releasedAt: new Date() },
      });
      // Free the range immediately for other passengers.
      await tx.seatSegmentHold.deleteMany({ where: { holdId: hold.id } });
    }
    // Released/Expired/Consumed: no-op by design.
  });
}

/** Expiry sweep — idempotent and race-safe with confirmation (status-guarded updates only). */
export async function expireStaleHolds(): Promise<number> {
  const cutoff = new Date();
  const stale = await prisma.seatHold.findMany({
    where: { status: "ACTIVE", expiresAt: { lt: cutoff } },
    select: { id: true },
  });
  for (const h of stale) {
    const updated = await prisma.$transaction(
      async (tx) => {
        // Conditional update: only ACTIVE→EXPIRED; a concurrent confirm has flipped
        // the status already, and then this write matches nothing.
        const rows = await tx.$executeRaw`
          UPDATE seat_holds SET status = 'EXPIRED'
          WHERE id = ${h.id} AND status = 'ACTIVE'`;
        if (rows > 0) {
          await tx.seatSegmentHold.deleteMany({ where: { holdId: h.id } });
        }
        return rows;
      },
    );
    if (updated > 0) inc("railbook_holds_expired_total");
  }
  return stale.length;
}
