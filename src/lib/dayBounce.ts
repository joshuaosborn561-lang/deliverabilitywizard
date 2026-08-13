/**
 * Calendar helpers for day-scoped campaign bounce watches.
 * Goliath schedules in America/Chicago — "tomorrow's sends" means that TZ day.
 */

/** YYYY-MM-DD in the given IANA timezone. */
export function calendarDateInTimeZone(
  timeZone: string,
  at: Date = new Date(),
): string {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function dayBounceRatePercent(sent: number, bounced: number): number {
  if (!sent || sent <= 0) return 0;
  // Prefer integer-friendly math so 7/100 is exactly 7, not 7.000000000000001.
  return (bounced * 100) / sent;
}

export function parseCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

/**
 * True when day-scoped bounce should trip the pause threshold.
 * Requires a minimum send sample so 1/5 early noise cannot pause a campaign.
 */
export function shouldTripDayBounce(opts: {
  sent: number;
  bounced: number;
  thresholdPercent: number;
  minSent: number;
}): boolean {
  if (opts.sent < opts.minSent) return false;
  // "Over 7%" — equality at the threshold does not trip. Compare in count
  // space to avoid float noise on bounced/sent*100.
  return opts.bounced * 100 > opts.thresholdPercent * opts.sent;
}

/** Strip Tickets/AirPods offer suffix so sibling campaigns can be compared. */
export function goliathSiblingKey(campaignName: string): string {
  return campaignName
    .replace(/\b(tickets?|airpods?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function isGoliathCampaign(campaign: {
  name?: string | null;
  client_id?: number | null;
}, goliathClientId?: number | null): boolean {
  if (/goliath/i.test(String(campaign.name ?? ""))) return true;
  if (
    typeof goliathClientId === "number" &&
    goliathClientId > 0 &&
    campaign.client_id === goliathClientId
  ) {
    return true;
  }
  return false;
}
