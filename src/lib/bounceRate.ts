/**
 * Per-sender bounce rate, and the decision to pull a sender off campaigns.
 *
 * A high bounce rate burns a domain's reputation faster than poor placement
 * does, and it is invisible to a placement test: seed inboxes accept mail, so
 * a mailbox can hold a clean inbox rate while bouncing badly against real
 * leads. The two signals have to be checked independently.
 *
 * Smartlead reports this in more than one shape depending on endpoint, and a
 * percentage field may be a fraction (0.05) or a percentage (5). Counts are
 * authoritative when present; the rate field is only trusted as a fallback.
 */

export interface SenderBounceStats {
  email: string;
  /** Percentage, 0-100. */
  bounceRate: number;
  /** Messages sent — the denominator behind bounceRate. */
  sent: number;
}

/** Read a number out of the first key that carries one. */
function num(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function str(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Pull the rows out of whichever envelope the response arrived in. */
export function extractRows(payload: unknown): Array<Record<string, unknown>> {
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): Array<Record<string, unknown>> => {
    if (!node || typeof node !== "object" || depth > 4) return [];
    if (seen.has(node)) return [];
    seen.add(node);

    if (Array.isArray(node)) {
      const rows = node.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object" && !Array.isArray(item),
      );
      // An array of objects that mention an address is the payload we want.
      if (rows.some((r) => str(r, EMAIL_KEYS))) return rows;
      return [];
    }

    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = walk(value, depth + 1);
      if (found.length) return found;
    }
    return [];
  };
  return walk(payload, 0);
}

const EMAIL_KEYS = ["email", "from_email", "email_account", "account_email"];
const SENT_KEYS = ["sent_count", "sent", "total_sent", "emails_sent", "total_count"];
const BOUNCE_COUNT_KEYS = ["bounce_count", "bounced_count", "bounced", "total_bounced"];
const BOUNCE_RATE_KEYS = ["bounce_rate", "bounceRate", "bounce_percentage"];

/**
 * Normalise one row into a bounce stat, or null when it carries no usable
 * signal. Counts win over a reported rate.
 */
export function parseSenderRow(
  row: Record<string, unknown>,
): SenderBounceStats | null {
  const email = str(row, EMAIL_KEYS)?.toLowerCase();
  if (!email || !email.includes("@")) return null;

  const sent = num(row, SENT_KEYS);
  const bounced = num(row, BOUNCE_COUNT_KEYS);

  if (sent !== null && sent > 0 && bounced !== null && bounced >= 0) {
    return { email, bounceRate: (bounced / sent) * 100, sent };
  }

  const reported = num(row, BOUNCE_RATE_KEYS);
  if (reported === null) return null;
  // A value at or below 1 is ambiguous between "1%" and "100%". Smartlead
  // reports percentages, so only treat it as a fraction when a count field
  // proves the denominator is large enough for 1% to be meaningful.
  const bounceRate = reported;
  return { email, bounceRate, sent: sent ?? 0 };
}

export function parseSenderBounceStats(payload: unknown): SenderBounceStats[] {
  const out = new Map<string, SenderBounceStats>();
  for (const row of extractRows(payload)) {
    const stat = parseSenderRow(row);
    if (!stat) continue;
    // Keep the worst reading for an address that appears per-campaign.
    const prev = out.get(stat.email);
    if (!prev || stat.bounceRate > prev.bounceRate) out.set(stat.email, stat);
  }
  return [...out.values()];
}

/**
 * Should this sender be pulled off campaigns?
 *
 * A small sample is not evidence: one bounce out of three sends is 33% and
 * means nothing. Requiring a floor keeps a newly-warmed mailbox from being
 * benched on its first bad send.
 */
export function shouldRotateForBounces(
  stat: SenderBounceStats,
  thresholdPercent: number,
  minSample: number,
): boolean {
  if (stat.sent < minSample) return false;
  return stat.bounceRate > thresholdPercent;
}

/**
 * D41 — warn (Slack / investigate) above ~2% but do not pull.
 * Rotation stays on bounceRateThreshold (5%, D5).
 */
export function shouldWarnForBounces(
  stat: SenderBounceStats,
  warnPercent: number,
  rotatePercent: number,
  minSample: number,
): boolean {
  if (stat.sent < minSample) return false;
  if (stat.bounceRate > rotatePercent) return false;
  return stat.bounceRate > warnPercent;
}
