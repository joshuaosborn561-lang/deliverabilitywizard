/**
 * Diagnose why a campaign's *day* bounce spiked: delays / sender-originated,
 * spam/copy words, or mailboxes that need rotation.
 */

import type { CopySignal } from "./copySignal.js";
import { goliathSiblingKey } from "./dayBounce.js";

export type DayBounceCause =
  | "delays_or_sender_reputation"
  | "spam_or_copy"
  | "mailbox_rotation"
  | "mixed"
  | "unclear";

export interface DayBounceDiagnosis {
  primary: DayBounceCause;
  reasons: string[];
  senderOriginatedShare?: number;
  siblingComparison?: string;
  copySignalKind?: string;
  hotMailboxes?: string[];
}

export interface SiblingDayStats {
  campaignId: number;
  name: string;
  sent: number;
  bounced: number;
  rate: number;
}

const SPAM_WORD_RE =
  /\b(airpods?|free\s+gift|act now|limited time|click here|buy now|guaranteed?|risk[\s-]?free|congratulations|claim your)\b/i;

export function classifyBounceCategories(
  categories: Record<string, number>,
): { senderOriginated: number; other: number; total: number } {
  let senderOriginated = 0;
  let other = 0;
  for (const [name, count] of Object.entries(categories)) {
    if (/sender\s*originated/i.test(name)) senderOriginated += count;
    else other += count;
  }
  return { senderOriginated, other, total: senderOriginated + other };
}

export function diagnoseDayBounce(opts: {
  campaignName: string;
  dayRate: number;
  categories: Record<string, number>;
  siblings: SiblingDayStats[];
  copySignal?: CopySignal | null;
  sequenceSubject?: string;
  sequenceBodyPlain?: string;
  hotMailboxes?: Array<{ email: string; bounceRate: number; sent: number }>;
}): DayBounceDiagnosis {
  const reasons: string[] = [];
  const votes: DayBounceCause[] = [];
  const cats = classifyBounceCategories(opts.categories);

  if (cats.total > 0) {
    const share = cats.senderOriginated / cats.total;
    if (share >= 0.5) {
      votes.push("delays_or_sender_reputation");
      reasons.push(
        `${Math.round(share * 100)}% of sampled day bounces are *Sender Originated Bounce* — usually ESP deferrals / sender reputation, not bad lead emails.`,
      );
    }
  }

  const key = goliathSiblingKey(opts.campaignName);
  const isAirpods = /airpods?/i.test(opts.campaignName);
  const isTickets = /tickets?/i.test(opts.campaignName);
  const siblings = opts.siblings.filter(
    (s) =>
      goliathSiblingKey(s.name) === key &&
      s.campaignId !== undefined &&
      s.sent >= 30,
  );
  if (isAirpods) {
    const tickets = siblings.find((s) => /tickets?/i.test(s.name));
    if (tickets && tickets.rate + 5 < opts.dayRate) {
      votes.push("spam_or_copy");
      reasons.push(
        `Sibling *${tickets.name}* day bounce is ${tickets.rate.toFixed(1)}% vs this campaign ${opts.dayRate.toFixed(1)}% — same vertical, so the *AirPods offer/copy* is the likely difference.`,
      );
    }
  } else if (isTickets) {
    const airpods = siblings.find((s) => /airpods?/i.test(s.name));
    if (airpods && opts.dayRate + 5 < airpods.rate) {
      // Tickets fine, AirPods bad — this trip may still be mailboxes/delays
      reasons.push(
        `Sibling AirPods (*${airpods.name}*) is worse (${airpods.rate.toFixed(1)}%) — offer split suggests copy risk on AirPods more than on Tickets.`,
      );
    }
  }

  if (opts.copySignal?.kind === "copy_likely") {
    votes.push("spam_or_copy");
    reasons.push(`Placement copy signal: ${opts.copySignal.reason}`);
  }

  const hay = `${opts.sequenceSubject ?? ""}\n${opts.sequenceBodyPlain ?? ""}`;
  if (SPAM_WORD_RE.test(hay)) {
    const m = hay.match(SPAM_WORD_RE);
    votes.push("spam_or_copy");
    reasons.push(
      `Sequence copy contains spam-filter bait (“${m?.[0] ?? "…"}”) — tighten/remove offer-forward language.`,
    );
  }

  const hot = (opts.hotMailboxes ?? []).filter((m) => m.bounceRate > 7 && m.sent >= 20);
  if (hot.length >= 3) {
    votes.push("mailbox_rotation");
    reasons.push(
      `${hot.length} senders on this campaign are over 7% bounce (sample≥20) — rotate those mailboxes.`,
    );
  } else if (hot.length > 0 && cats.senderOriginated >= cats.other) {
    votes.push("mailbox_rotation");
    reasons.push(
      `Concentrated sender bounce on ${hot
        .slice(0, 5)
        .map((h) => h.email)
        .join(", ")} — rotate those first.`,
    );
  }

  if (!votes.length) {
    return {
      primary: "unclear",
      reasons: reasons.length
        ? reasons
        : [
            "Day bounce cleared 7% but categories/placement/siblings do not point to one cause — check SMTP deferrals and lead list quality next.",
          ],
      senderOriginatedShare: cats.total ? cats.senderOriginated / cats.total : undefined,
      hotMailboxes: hot.map((h) => h.email),
      copySignalKind: opts.copySignal?.kind,
    };
  }

  const counts = new Map<DayBounceCause, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const primary =
    ranked.length > 1 && ranked[0]![1] === ranked[1]![1]
      ? ("mixed" as const)
      : ranked[0]![0];

  return {
    primary,
    reasons,
    senderOriginatedShare: cats.total ? cats.senderOriginated / cats.total : undefined,
    hotMailboxes: hot.slice(0, 8).map((h) => `${h.email} (${h.bounceRate.toFixed(1)}%)`),
    copySignalKind: opts.copySignal?.kind,
  };
}

export function diagnosisLabel(cause: DayBounceCause): string {
  switch (cause) {
    case "delays_or_sender_reputation":
      return "Delays / sender-originated (ESP deferrals or reputation)";
    case "spam_or_copy":
      return "Spam words / offer copy";
    case "mailbox_rotation":
      return "Sending mailboxes need rotation";
    case "mixed":
      return "Mixed — more than one cause";
    default:
      return "Unclear — needs a closer look";
  }
}
