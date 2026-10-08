/**
 * D248 — every posted #deliverability card for an ask is remembered.
 * Resolution chat.updates every copy, including leftovers from before
 * in-place update shipped.
 */

export interface SlackAskStamp {
  channel: string;
  ts: string;
}

export function slackStampsFromDetail(
  detail: Record<string, unknown> | undefined,
): SlackAskStamp[] {
  if (!detail) return [];
  const out: SlackAskStamp[] = [];
  const seen = new Set<string>();
  const push = (channel: unknown, ts: unknown) => {
    if (typeof channel !== "string" || !channel.trim()) return;
    if (typeof ts !== "string" || !ts.trim()) return;
    const key = `${channel}\0${ts}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ channel, ts });
  };
  const list = detail.slackMessages;
  if (Array.isArray(list)) {
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const rec = row as { channel?: unknown; ts?: unknown };
      push(rec.channel, rec.ts);
    }
  }
  push(detail.slackChannel, detail.slackTs);
  return out;
}

export function appendSlackStamp(
  detail: Record<string, unknown>,
  stamp: SlackAskStamp,
): Record<string, unknown> {
  const stamps = slackStampsFromDetail(detail);
  const exists = stamps.some(
    (row) => row.channel === stamp.channel && row.ts === stamp.ts,
  );
  const next = exists ? stamps : [...stamps, stamp];
  return {
    ...detail,
    slackChannel: stamp.channel,
    slackTs: stamp.ts,
    slackMessages: next,
  };
}

export function latestSlackStamp(
  detail: Record<string, unknown> | undefined,
): SlackAskStamp | undefined {
  const stamps = slackStampsFromDetail(detail);
  return stamps[stamps.length - 1];
}
