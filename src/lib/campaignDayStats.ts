function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export interface CampaignDayStats {
  sent: number;
  replies: number;
  bounces: number;
  bounceRate: number;
  ooo?: number;
}

export function statsFromAnalytics(raw: unknown): CampaignDayStats {
  const row =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sent = pickNumber(row, ["sent_count", "sent", "total_sent", "emails_sent", "unique_sent_count"]) ?? 0;
  const replies = pickNumber(row, ["reply_count", "replies", "positive_reply_count"]) ?? 0;
  const bounces = pickNumber(row, ["bounce_count", "bounces", "bounced_count", "total_bounced"]) ?? 0;
  const ooo = pickNumber(row, [
    "ooo_count",
    "out_of_office_count",
    "out_of_office",
    "ooo",
  ]);
  return {
    sent,
    replies,
    bounces,
    bounceRate: sent > 0 ? (bounces / sent) * 100 : 0,
    ooo,
  };
}

export function oooFromStatistics(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  return pickNumber(row, [
    "ooo_count",
    "out_of_office_count",
    "out_of_office",
    "ooo",
    "ooo_reply_count",
  ]);
}

export function ymdUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function nyDateLabel(now = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  }).format(now);
}
