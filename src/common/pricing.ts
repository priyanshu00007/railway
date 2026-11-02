// Synthetic fare policy v1 — demo-only pricing, no real railway fares.
// fareMinor = baseFareMinor[class] + perSegmentMinor[class] * (segments in range)
// Full-range distance = destinationStopIndex - originStopIndex (a corridor count).

export type TravelClassName = "FIRST" | "SECOND" | "SLEEPER";

const RATE: Record<TravelClassName, { baseFareMinor: number; perSegmentMinor: number }> = {
  FIRST: { baseFareMinor: 1250, perSegmentMinor: 250 },
  SECOND: { baseFareMinor: 850, perSegmentMinor: 150 },
  SLEEPER: { baseFareMinor: 650, perSegmentMinor: 100 },
};

export function classNames(): TravelClassName[] {
  return ["FIRST", "SECOND", "SLEEPER"];
}

export function isClass(name: string): name is TravelClassName {
  return name in RATE;
}

/** segments travelled; a range [3,5) spans 2 corridors. */
export function fareMinor(className: TravelClassName, originStopIndex: number, destinationStopIndex: number): number {
  const r = RATE[className];
  return r.baseFareMinor + r.perSegmentMinor * Math.max(1, destinationStopIndex - originStopIndex);
}

/** Cancellation fee: 20% of fare, minimum 20000 minor units, deterministic. */
export function cancellationFeeMinor(fareMinorValue: number): number {
  return Math.max(20000, Math.round(fareMinorValue * 0.2));
}
