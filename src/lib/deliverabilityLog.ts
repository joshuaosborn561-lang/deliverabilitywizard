/**
 * D248 — informational Wizard posts leave #deliverability. They go to
 * DELIVERABILITY_LOG_CHANNEL when set, otherwise one daily thread in
 * #deliverability.
 */

export const SLACK_LOG_KINDS = [
  "short_staffed",
  "stage_overdue",
  "canon_miss",
  "bounce_burst",
  "canary_registered",
  "hold_paused",
  "copy_check",
  "placement",
  "lead_expired",
] as const;

export type SlackLogKind = (typeof SLACK_LOG_KINDS)[number];

export function isSlackLogKind(kind?: string | null): kind is SlackLogKind {
  return Boolean(kind && (SLACK_LOG_KINDS as readonly string[]).includes(kind));
}

export function deliverabilityLogParentText(ymd: string): string {
  return `*Wizard log — ${ymd}*`;
}

export interface DeliverabilityLogThread {
  ymd: string;
  channel: string;
  ts: string;
}

export interface DeliverabilityLogPlan {
  channel: string;
  threadTs?: string;
  openParent?: { text: string };
}

export function planDeliverabilityLogPost(input: {
  logChannel?: string;
  humanChannel: string;
  todayYmd: string;
  thread: DeliverabilityLogThread | null;
}): DeliverabilityLogPlan {
  const log = input.logChannel?.trim();
  if (log) return { channel: log };
  if (input.thread && input.thread.ymd === input.todayYmd) {
    return { channel: input.thread.channel, threadTs: input.thread.ts };
  }
  return {
    channel: input.humanChannel,
    openParent: { text: deliverabilityLogParentText(input.todayYmd) },
  };
}
