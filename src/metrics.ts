// Minimal metrics registry (Prometheus text exposition, no dependency).
// Counters survive only in-process — acceptable for v1 demo telemetry.

export const metrics: Record<string, number> = {
  railbook_requests_total: 0,
  railbook_seat_unavailable_total: 0,
  railbook_holds_created_total: 0,
  railbook_holds_expired_total: 0,
  railbook_webhook_duplicate_total: 0,
  railbook_bookings_confirmed_total: 0,
  railbook_bookings_cancelled_total: 0,
  lockAcquisitionMsLast: 0,
};

export function inc(name: keyof typeof metrics): void {
  metrics[name] = (metrics[name] ?? 0) + 1;
}

export function observeLockAcquisition(ms: number): void {
  metrics.lockAcquisitionMsLast = ms;
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(metrics)) {
    lines.push(`# TYPE ${name} ${name.endsWith("_total") ? "counter" : "gauge"}`);
    lines.push(`${name} ${value}`);
  }
  return lines.join("\n") + "\n";
}
