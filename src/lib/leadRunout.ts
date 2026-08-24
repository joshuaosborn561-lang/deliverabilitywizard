/**
 * D52 — how far through its list an ACTIVE campaign is.
 * Campaign audit watches senders. Send volume watches today's sent count.
 * Neither watches remaining leads. This does.
 */

export type RunoutStage = "half" | "three_quarters" | "done";
export type RunoutPerformance = "working" | "struggling" | "unknown";

export interface CampaignLeadStats {
  total: number;
  contacted: number;
  remaining: number;
  replied: number;
  positiveReplies: number;
  replyRate: number | null;
}

export function parseCampaignLeadStats(raw: unknown): CampaignLeadStats | null {
  const root = unwrap(raw);
  if (!root) return null;

  const leadStats = unwrap(
    root.campaign_lead_stats ?? root.campaignLeadStats ?? root.lead_stats,
  );
  const total =
    num(root.total_leads) ??
    num(root.totalLeads) ??
    num(leadStats?.total) ??
    num(root.total_count);
  const notStarted = num(leadStats?.notStarted ?? leadStats?.not_started);
  const contacted =
    num(root.contacted) ??
    num(root.leads_contacted) ??
    (total != null && notStarted != null ? Math.max(0, total - notStarted) : undefined);
  if (total == null || total <= 0) return null;

  const remaining =
    notStarted ??
    (contacted != null ? Math.max(0, total - contacted) : undefined);
  if (remaining == null) return null;

  const replied =
    num(root.replied) ??
    num(root.leads_replied) ??
    num(root.reply_count) ??
    0;
  const positive =
    num(root.positive_reply_count) ??
    num(root.positive_replies) ??
    num(root.interested) ??
    num(leadStats?.interested) ??
    0;
  const replyRate =
    num(root.reply_rate) ??
    (contacted && contacted > 0 ? (replied / contacted) * 100 : null);

  return {
    total,
    contacted: contacted ?? Math.max(0, total - remaining),
    remaining,
    replied,
    positiveReplies: positive,
    replyRate,
  };
}

export function consumedPercent(stats: CampaignLeadStats): number {
  if (stats.total <= 0) return 0;
  return ((stats.total - stats.remaining) / stats.total) * 100;
}

export function runoutStage(consumedPct: number): RunoutStage | null {
  if (consumedPct >= 99.5) return "done";
  if (consumedPct >= 75) return "three_quarters";
  if (consumedPct >= 50) return "half";
  return null;
}

export function classifyRunoutPerformance(
  stats: CampaignLeadStats,
  minSample = 50,
): RunoutPerformance {
  if (stats.contacted < minSample) return "unknown";
  const rate = stats.replyRate ?? 0;
  if (rate >= 1 || stats.positiveReplies > 0) return "working";
  if (rate < 0.5 && stats.replied === 0 && stats.positiveReplies === 0) {
    return "struggling";
  }
  return "unknown";
}

export function daysRemaining(
  leadsLeft: number,
  sentPerDay: number,
): number | null {
  if (sentPerDay <= 0) return null;
  return leadsLeft / sentPerDay;
}

export function formatRunoutMessage(input: {
  campaignName: string;
  stage: RunoutStage;
  remaining: number;
  sentPerDay: number;
  performance: RunoutPerformance;
}): string {
  const through =
    input.stage === "done"
      ? "out of leads"
      : input.stage === "three_quarters"
        ? "three quarters through its list"
        : "about halfway through its list";
  const days = daysRemaining(input.remaining, input.sentPerDay);
  const pace =
    input.stage === "done"
      ? input.sentPerDay > 0
        ? `It was sending about ${Math.round(input.sentPerDay)} a day until it stopped.`
        : "It has stopped sending."
      : input.sentPerDay > 0
        ? `About ${Math.round(input.remaining)} leads left, sending about ${Math.round(input.sentPerDay)} a day, so ${formatDays(days)}.`
        : `About ${Math.round(input.remaining)} leads left. It is not sending right now, so I cannot say how long that will last.`;

  const ask =
    input.performance === "struggling"
      ? "This one is not getting replies. Do not top it up — that would be throwing good leads after a campaign that is not working. I have not imported anything."
      : input.stage === "half"
        ? "Start sourcing the next batch. I have not imported anything."
        : input.stage === "three_quarters"
          ? "You need the next batch in hand. I have not imported anything."
          : "It has stopped. I have not imported anything.";

  const urgency =
    input.performance === "working" && input.stage !== "done"
      ? "This one is working, so running out matters."
      : input.performance === "unknown" && input.stage !== "done"
        ? "I do not have enough reply data yet to say if topping up is worth it."
        : undefined;

  return [`*${input.campaignName}* is ${through}.`, pace, urgency, ask]
    .filter(Boolean)
    .join(" ");
}

export function formatDays(days: number | null): string {
  if (days == null) return "I cannot tell how long that will last";
  if (days < 1) return "less than a day";
  if (days < 1.5) return "about a day";
  if (days < 9.5) return `about ${Math.round(days)} days`;
  if (days < 20) return "about two weeks";
  return `about ${Math.round(days / 7)} weeks`;
}

function unwrap(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const nested = row.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...row, ...(nested as Record<string, unknown>) };
  }
  return row;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}
