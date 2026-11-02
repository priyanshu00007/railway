// Synthetic seed data — synthetic trains/stations, no real railway inventory.
import { randomUUID, scryptSync } from "node:crypto";
import { PrismaClient, TravelClass } from "@prisma/client";

const prisma = new PrismaClient();

const stations = [
  { code: "MUC", name: "Munich Hbf", timezone: "Europe/Berlin" },
  { code: "NUE", name: "Nuremberg Hbf", timezone: "Europe/Berlin" },
  { code: "WUE", name: "Würzburg Hbf", timezone: "Europe/Berlin" },
  { code: "FD", name: "Fulda", timezone: "Europe/Berlin" },
  { code: "KBN", name: "Köln Hbf", timezone: "Europe/Berlin" },
  { code: "VIE", name: "Wien Hbf", timezone: "Europe/Vienna" },
  { code: "SZG", name: "Salzburg Hbf", timezone: "Europe/Vienna" },
  { code: "NDLS", name: "New Delhi", timezone: "Asia/Kolkata" },
  { code: "MTJ", name: "Mathura", timezone: "Asia/Kolkata" },
  { code: "AGC", name: "Agra Cantt", timezone: "Asia/Kolkata" },
  { code: "GWL", name: "Gwalior", timezone: "Asia/Kolkata" },
  { code: "VGLJ", name: "Jhansi (Veangagram)", timezone: "Asia/Kolkata" },
];

async function main() {
  for (const s of stations) {
    await prisma.station.upsert({
      where: { code: s.code },
      update: { name: s.name, timezone: s.timezone },
      create: s,
    });
  }

  const trainData = [
    {
      number: "RB100",
      name: "MUC–VIE Express",
      coaches: [
        { coachNo: "1", class: TravelClass.FIRST, seatCount: 20 },
        { coachNo: "2", class: TravelClass.SECOND, seatCount: 40 },
        { coachNo: "3", class: TravelClass.SECOND, seatCount: 40 },
      ],
    },
    {
      number: "RB200",
      name: "MUC–KBN InterCity",
      coaches: [
        { coachNo: "1", class: TravelClass.FIRST, seatCount: 18 },
        { coachNo: "2", class: TravelClass.SECOND, seatCount: 36 },
        { coachNo: "5", class: TravelClass.SLEEPER, seatCount: 24 },
      ],
    },
    {
      number: "EXP-101",
      name: "Gatimaan Superfast",
      coaches: [
        { coachNo: "A1", class: TravelClass.FIRST, seatCount: 12 },
        { coachNo: "B1", class: TravelClass.SECOND, seatCount: 24 },
        { coachNo: "S1", class: TravelClass.SLEEPER, seatCount: 18 },
      ],
    },
  ];

  for (const t of trainData) {
    const train = await prisma.train.upsert({
      where: { number: t.number },
      update: { name: t.name },
      create: { number: t.number, name: t.name, status: "ACTIVE" },
    });

    for (const c of t.coaches) {
      const coach = await prisma.coach.upsert({
        where: { trainId_coachNo: { trainId: train.id, coachNo: c.coachNo } },
        update: { class: c.class },
        create: { trainId: train.id, coachNo: c.coachNo, class: c.class },
      });
      const existing = await prisma.seat.count({ where: { coachId: coach.id } });
      if (existing < c.seatCount) {
        await prisma.seat.createMany({
          data: Array.from({ length: c.seatCount - existing }, (_, i) => ({
            coachId: coach.id,
            seatNo: existing + i + 1,
          })),
          skipDuplicates: true,
        });
      }
    }
  }

  // One demo scheduled trip per train, service date = tomorrow. Seats per trip are
  // materialized as TripSeat rows (segment inventory units).
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const serviceDate = new Date(
    Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate()),
  );

  const routeStations: Record<string, string[]> = {
    RB100: ["MUC", "SZG", "VIE"],
    RB200: ["MUC", "NUE", "WUE", "FD", "KBN"],
    "EXP-101": ["NDLS", "MTJ", "AGC", "GWL", "VGLJ"],
  };

  let baseMinute = 0;
  for (const [trainNumber, codes] of Object.entries(routeStations)) {
    const train = await prisma.train.findUniqueOrThrow({ where: { number: trainNumber } });
    const trip = await prisma.trip.upsert({
      where: { trainId_serviceDate: { trainId: train.id, serviceDate } },
      update: {},
      create: { trainId: train.id, serviceDate, status: "SCHEDULED" },
    });

    let idx = 0;
    for (const code of codes) {
      const station = await prisma.station.findUniqueOrThrow({ where: { code } });
      const departureAt = new Date(serviceDate.getTime() + baseMinute * 60_000);
      baseMinute += 95;
      await prisma.tripStop.upsert({
        where: { tripId_stopIndex: { tripId: trip.id, stopIndex: idx } },
        update: { stationId: station.id, departureAt },
        create: {
          tripId: trip.id,
          stationId: station.id,
          stopIndex: idx,
          departureAt,
          arrivalAt: idx === 0 ? null : departureAt,
        },
      });
      idx += 1;
    }

    const coaches = await prisma.coach.findMany({
      where: { trainId: train.id },
      include: { seats: true },
    });
    for (const coach of coaches) {
      for (const seat of coach.seats) {
        await prisma.tripSeat.upsert({
          where: { tripId_seatId: { tripId: trip.id, seatId: seat.id } },
          update: {},
          create: {
            tripId: trip.id,
            seatId: seat.id,
            coachNo: coach.coachNo,
            seatNo: seat.seatNo,
            class: coach.class,
          },
        });
      }
    }
  }

  // Demo identities (dev only, synthetic credentials).
  for (const [email, role] of [["demo@railbook.dev", "CUSTOMER"], ["admin@railbook.dev", "ADMIN"]] as const) {
    await prisma.user.upsert({
      where: { email },
      update: { role },
      create: { email, passwordHash: demoPasswordHash(), role },
    });
  }

  const counts = {
    stations: await prisma.station.count(),
    trains: await prisma.train.count(),
    trips: await prisma.trip.count(),
    tripSeats: await prisma.tripSeat.count(),
  };
  console.log("Seed complete:", counts);
}

function demoPasswordHash(): string {
  const salt = randomUUID().replace(/-/g, "");
  return `scrypt:${salt}:${scryptSync("demo-password-123", salt, 64).toString("hex")}`;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
