export type BounceClass =
  | "tenant_rate_limit"
  | "tenant_outbound_block"
  | "sender_blocked"
  | "invalid_recipient"
  | "content_block"
  | "unknown";

export function classifyBounceReason(raw: string): BounceClass {
  const text = raw.toLowerCase();
  if (/5\.7\.233|550 5\.7\.233|terrl|tenant.*limit/.test(text)) {
    return "tenant_rate_limit";
  }
  if (/5\.1\.8|as\(42004\)|outbound.?spam/.test(text)) {
    return "tenant_outbound_block";
  }
  if (/sender.*block|blocked.*sender|550 5\.7\.1/.test(text)) {
    return "sender_blocked";
  }
  if (/5\.1\.1|user unknown|invalid recipient|mailbox unavailable/.test(text)) {
    return "invalid_recipient";
  }
  if (/content|spamhaus|policy|552 5\.2/.test(text)) {
    return "content_block";
  }
  return "unknown";
}

/** D5 — a bounce rate is only evidence above the sample floor. */
export function bounceRateIsEvidence(opts: {
  bounceRate: number;
  sent: number;
  threshold?: number;
  sampleFloor?: number;
}): boolean {
  const threshold = opts.threshold ?? 5;
  const floor = opts.sampleFloor ?? 50;
  if (opts.sent < floor) return false;
  return opts.bounceRate >= threshold;
}

/** D148 — the bounce loop never pauses a campaign. */
export function bounceLoopMayPause(): false {
  return false;
}
