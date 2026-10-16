/** D280/D281 — every skipped staff/isolation tick logs a reason; boot still fires. */

export type TickSkipReason =
  | "in_flight"
  | "quiet_hours"
  | "missing_smartlead_key"
  | "missing_smartdelivery_key"
  | "missing_inboxkit_key"
  | "inventory_unready"
  | "timeout";

export function tickSkipReason(opts: {
  inFlight?: boolean;
  quietHours?: boolean;
  missingKey?: "smartlead" | "smartdelivery" | "inboxkit" | null;
  inventoryUnready?: boolean;
}): TickSkipReason | null {
  if (opts.inFlight) return "in_flight";
  if (opts.quietHours) return "quiet_hours";
  if (opts.missingKey === "smartlead") return "missing_smartlead_key";
  if (opts.missingKey === "smartdelivery") return "missing_smartdelivery_key";
  if (opts.missingKey === "inboxkit") return "missing_inboxkit_key";
  if (opts.inventoryUnready) return "inventory_unready";
  return null;
}

export function formatSkipLog(stage: string, reason: string, extra?: Record<string, string | number | boolean | null>): string {
  const parts = Object.entries(extra ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return [`[v2] ${stage} skip reason=${reason}`, ...parts].join(" ");
}

export function formatProgressLog(
  stage: string,
  step: string,
  extra?: Record<string, string | number | boolean | null>,
): string {
  const parts = Object.entries(extra ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return [`[v2] ${stage} progress step=${step}`, ...parts].join(" ");
}

export const TICK_INTERVAL_MS = 15 * 60 * 1000;
