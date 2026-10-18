import "server-only";
import { defer } from "../notify/defer";
import { alertsConfigured } from "./config";

// S1 paid alerts: the kick. Every place that records a payment (lib/requests.ts recordPayment, lib/x402/store.ts,
// lib/moonpay/store.ts, lib/match.ts) calls alertsSoon() next to watchSoon(). The alert rows themselves were already
// queued by the 0025 trigger in the same transaction; this only makes them go out after the response is sent instead
// of waiting for the next kick or the daily cron. Calls made before the queued run starts share it. Without a
// configured channel it does nothing, not even a query. The sender loads after the response, off the settle path.

let queued = false;

export function alertsSoon(): void {
  if (queued || !alertsConfigured()) return;
  queued = true;
  defer("paid alerts", async () => {
    queued = false;
    await (await import("./deliver")).deliverDueAlerts();
  });
}
