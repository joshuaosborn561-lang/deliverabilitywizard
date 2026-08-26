/**
 * Day-over-day "nothing is being delivered" signature.
 * Out-of-office collapse is the load-bearing signal: OOOs are automated
 * and indifferent to the offer. Do not call this a fingerprint in Slack (D47).
 */

export interface DeliveryWatchSnapshot {
  replies: number;
  ooo: number;
  bounceRate: number;
  sent?: number;
}

export interface DeliveryWatchInput {
  yesterday: DeliveryWatchSnapshot;
  today: DeliveryWatchSnapshot;
  infraUnchanged: boolean;
  sequenceUnchanged: boolean;
  listUnchanged: boolean;
}

export interface DeliveryWatchHit {
  hit: boolean;
  reason: string;
  repliesFrom: number;
  repliesTo: number;
  oooFrom: number;
  oooTo: number;
  bounceFrom: number;
  bounceTo: number;
}

const REPLY_COLLAPSE = 0.2;
const BOUNCE_SPIKE_POINTS = 3;

export function detectDeliveryCollapse(input: DeliveryWatchInput): DeliveryWatchHit {
  const base = {
    hit: false,
    reason: "",
    repliesFrom: input.yesterday.replies,
    repliesTo: input.today.replies,
    oooFrom: input.yesterday.ooo,
    oooTo: input.today.ooo,
    bounceFrom: input.yesterday.bounceRate,
    bounceTo: input.today.bounceRate,
  };

  if (!input.infraUnchanged || !input.sequenceUnchanged || !input.listUnchanged) {
    return { ...base, reason: "Sequence, list, or inboxes changed — not a silent delivery drop." };
  }

  const bounceSpiked =
    input.today.bounceRate - input.yesterday.bounceRate >= BOUNCE_SPIKE_POINTS;
  if (bounceSpiked) {
    return { ...base, reason: "Bounces jumped — this is a bounce problem, not a silent drop." };
  }

  const repliesCollapsed =
    input.yesterday.replies >= 3 &&
    (input.today.replies === 0 ||
      input.today.replies / input.yesterday.replies <= REPLY_COLLAPSE);

  const oooCollapsed = input.yesterday.ooo >= 2 && input.today.ooo === 0;

  if (repliesCollapsed && oooCollapsed) {
    return {
      ...base,
      hit: true,
      reason:
        "Replies dropped toward zero and out-of-office replies also went to zero, while bounces stayed flat. Nothing is being delivered.",
    };
  }

  return {
    ...base,
    reason: "No silent-delivery signature (need both replies and out-of-office collapsing).",
  };
}

export function oooDetectionEnabled(settings: unknown): boolean | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const row = settings as Record<string, unknown>;
  const nested =
    row.out_of_office_detection_settings ??
    row.outOfOfficeDetectionSettings ??
    row.ooo_detection ??
    row;
  if (nested && typeof nested === "object") {
    const obj = nested as Record<string, unknown>;
    if (typeof obj.enabled === "boolean") return obj.enabled;
    if (typeof obj.is_enabled === "boolean") return obj.is_enabled;
    if (typeof obj.out_of_office_detection === "boolean") {
      return obj.out_of_office_detection;
    }
  }
  if (typeof row.ignoreOOOasReply === "boolean") return true;
  return undefined;
}
